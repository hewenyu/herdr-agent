import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { OperationError } from "../../src/core/errors.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { SessionService } from "../../src/runtime/sessions.js";
import type { ConversationEngine, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "./helpers.js";

function write(execute: RuntimeTool["execute"]): RuntimeTool {
  return {
    name: "write",
    description: "Record work",
    parameters: { type: "object", properties: {} },
    readOnly: false,
    execute,
  };
}

test("failed model continuation restores confirmed tool evidence without replaying the write", async () => {
  const store = new Store(":memory:");
  let writes = 0;
  const streams = scripted([
    response("", [{ type: "toolCall", id: "write-1", name: "write", arguments: {} }]),
    { ...response(""), stopReason: "error", errorMessage: "network interruption" },
    response("请求已记录。"),
  ]);
  const engine = new PiEngine(config, { streamFn: streams });
  const options = {
    tools: () => [
      write(async () => {
        writes++;
        return { accepted: true };
      }),
    ],
  };
  const sessions = new SessionService(store, engine, options);
  try {
    const session = sessions.current("owner", "chat");
    const actor = { ownerId: "owner", chatId: "chat", sessionId: session.id, messageId: "request" };
    await assert.rejects(sessions.reply(actor, "创建"));
    const restarted = new SessionService(store, engine, options);
    assert.equal(restarted.canRecover(actor), true);
    const reply = await restarted.reply(actor, "创建");
    assert.equal(reply.text, "请求已记录。");
    assert.equal(writes, 1);
    assert.equal(restarted.history("owner", session.id).filter((m) => m.role === "user").length, 1);
  } finally {
    store.close();
  }
});

test("restart repairs the checkpoint gap after a write commits and before its tool result persists", async () => {
  const store = new Store(":memory:");
  let writes = 0;
  const options = {
    tools: () => [
      write(async () => {
        writes++;
        return { accepted: true, marker: "durable" };
      }),
    ],
  };
  const interrupted: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      await input.onCheckpoint?.([
        { role: "user", content: input.prompt, timestamp: Date.now() },
        response("", [{ type: "toolCall", id: "write-gap", name: "write", arguments: {} }]),
      ]);
      await input.tools[0]?.execute({}, input.actor);
      throw new OperationError("model_failed", "interrupted", "unknown");
    },
  };
  try {
    const sessions = new SessionService(store, interrupted, options);
    const session = sessions.current("owner", "chat");
    const actor = { ownerId: "owner", chatId: "chat", sessionId: session.id, messageId: "gap" };
    await assert.rejects(sessions.reply(actor, "创建"));
    const engine = new PiEngine(config, {
      streamFn: scripted([response("请求已记录。")], (context) => {
        assert.ok(
          context.messages.some(
            (m) => m.role === "toolResult" && JSON.stringify(m).includes("durable"),
          ),
        );
      }),
    });
    await new SessionService(store, engine, options).reply(actor, "创建");
    assert.equal(writes, 1);
  } finally {
    store.close();
  }
});

for (const failure of ["throws", "returns"] as const)
  test(`unknown write ${failure} blocks automatic continuation`, async () => {
    const store = new Store(":memory:");
    let writes = 0;
    const tool = write(async () => {
      writes++;
      if (failure === "throws") throw new OperationError("transport", "unconfirmed", "unknown");
      return { status: "unconfirmed" };
    });
    const engine = new PiEngine(config, {
      streamFn: scripted([
        response("", [{ type: "toolCall", id: "unknown", name: "write", arguments: {} }]),
        { ...response(""), stopReason: "error", errorMessage: "offline" },
      ]),
    });
    try {
      const sessions = new SessionService(store, engine, { tools: () => [tool] });
      const session = sessions.current("owner", "chat");
      const actor = {
        ownerId: "owner",
        chatId: "chat",
        sessionId: session.id,
        messageId: "unknown",
      };
      await assert.rejects(sessions.reply(actor, "创建"));
      assert.equal(sessions.canRecover(actor), false);
      await assert.rejects(sessions.reply(actor, "创建"), { code: "turn_unconfirmed" });
      assert.equal(writes, 1);
    } finally {
      store.close();
    }
  });

test("recovery is bounded, preserves message identity and refuses cleared generations", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async () => {
      calls++;
      throw new OperationError("model_failed", "offline", "unknown");
    },
  };
  try {
    const sessions = new SessionService(store, engine);
    const session = sessions.current("owner", "chat");
    const actor = { ownerId: "owner", chatId: "chat", sessionId: session.id, messageId: "bounded" };
    await assert.rejects(sessions.reply(actor, "要求"));
    await assert.rejects(sessions.reply(actor, "换一个要求"), { code: "duplicate_identity" });
    await assert.rejects(sessions.reply(actor, "要求"));
    await assert.rejects(sessions.reply(actor, "要求"));
    assert.equal(sessions.canRecover(actor), false);
    await assert.rejects(sessions.reply(actor, "要求"), { code: "turn_unconfirmed" });
    assert.equal(calls, 3);
    sessions.clear("owner", session.id);
    assert.equal(sessions.canRecover(actor), false);
  } finally {
    store.close();
  }
});

test("model timeout releases a lane even if a provider stream ignores abort", async () => {
  const engine = new PiEngine(
    { ...config, timeoutMs: 20 },
    { streamFn: () => new AssistantMessageEventStream() },
  );
  await assert.rejects(
    engine.run({
      actor: { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "timeout" },
      sessionId: "session",
      prompt: "hello",
      systemPrompt: "chat",
      messages: [],
      tools: [],
    }),
    { code: "model_failed" },
  );
});

test("restricted workflows force only the first request and reject missing tool calls", async () => {
  const choices: unknown[] = [];
  const script = scripted([
    response("", [{ type: "toolCall", id: "required", name: "write", arguments: {} }]),
    response("确认完毕。"),
  ]);
  const engine = new PiEngine(config, {
    streamFn: (model, context, options) => {
      choices.push((options as Record<string, unknown> | undefined)?.toolChoice);
      return script(model, context, options);
    },
  });
  const input = {
    actor: { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "required" },
    sessionId: "session",
    prompt: "确认目录信任",
    systemPrompt: "use tool",
    messages: [],
    tools: [write(async () => ({ verified: true }))],
    enforceClaims: false,
    requireToolCall: true,
  };
  await engine.run(input);
  assert.deepEqual(choices, ["required", undefined]);
  await assert.rejects(
    new PiEngine(config, { streamFn: scripted([response("确认完毕。")]) }).run(input),
    { code: "model_failed" },
  );
});

for (const action of ["reset", "archive"] as const)
  test(`recovery restores deferred ${action} intent without replaying its tool`, async () => {
    const store = new Store(":memory:");
    let sessions: SessionService;
    let executions = 0;
    const toolName = action === "reset" ? "session_clear" : "session_archive";
    const options = {
      tools: () => [
        {
          ...write(async (_args, actor) => {
            executions++;
            return action === "reset"
              ? sessions.requestReset(actor)
              : sessions.requestArchive(actor, actor.sessionId);
          }),
          name: toolName,
        },
      ],
    };
    const engine = new PiEngine(config, {
      streamFn: scripted([
        response("", [{ type: "toolCall", id: "intent", name: toolName, arguments: {} }]),
        { ...response(""), stopReason: "error", errorMessage: "response interrupted" },
        response("会话处理完毕。"),
      ]),
    });
    try {
      sessions = new SessionService(store, engine, options);
      const original = sessions.current("owner", "chat");
      const actor = {
        source: "feishu" as const,
        chatType: "private" as const,
        ownerId: "owner",
        chatId: "chat",
        sessionId: original.id,
        messageId: "intent",
      };
      await assert.rejects(sessions.reply(actor, "执行会话操作"));
      assert.equal(sessions.get("owner", original.id).archived, false);
      assert.equal(store.list("session_reset_requests").length, 0);
      assert.equal(store.list("session_archive_requests").length, 0);
      sessions = new SessionService(store, engine, options);
      await sessions.reply(actor, "执行会话操作");
      assert.equal(executions, 1);
      assert.equal(sessions.get("owner", original.id).archived, true);
      if (action === "reset") {
        assert.notEqual(sessions.current("owner", "chat").id, original.id);
        assert.equal(sessions.list("owner", { archived: true }).length, 2);
      }
      const count = sessions.list("owner", { archived: true }).length;
      await sessions.reply(actor, "执行会话操作");
      assert.equal(sessions.list("owner", { archived: true }).length, count);
      assert.equal(executions, 1);
    } finally {
      store.close();
    }
  });
