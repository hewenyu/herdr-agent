import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import { SessionService } from "../../src/runtime/sessions.js";
import type { ToolResultProjectionInput } from "../../src/runtime/tool-results.js";
import type { ConversationEngine, EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { response } from "./helpers.js";

test("result references survive ordinary turns but not a session-generation reset", async () => {
  const store = new Store(":memory:");
  let reference: string | undefined;
  let calls = 0;
  const read: RuntimeTool = {
    name: "inspect",
    description: "Inspect data",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ text: "x".repeat(30000) }),
  };
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      calls++;
      if (calls === 1) {
        const result = await input.tools
          .find((tool) => tool.name === "inspect")
          ?.execute({}, input.actor);
        const project = (
          input as EngineInput & {
            projectToolResult?: (value: ToolResultProjectionInput) => unknown | Promise<unknown>;
          }
        ).projectToolResult;
        assert.ok(project);
        const projected = (await project({
          tool: "inspect",
          toolCallId: "call",
          args: {},
          result,
        })) as { reference?: string };
        reference = projected.reference;
        assert.equal(typeof reference, "string");
      } else {
        const reader = input.tools.find((tool) => tool.name === "tool_result_read");
        assert.ok(reader);
        if (calls === 2) {
          const page = (await reader.execute({ reference, page: 0 }, input.actor)) as {
            text?: string;
          };
          assert.equal(typeof page.text, "string", "next-turn on-demand reads must work");
        } else {
          await assert.rejects(
            Promise.resolve().then(() => reader.execute({ reference, page: 0 }, input.actor)),
            { code: "invalid_scope" },
          );
        }
      }
      return {
        text: "可按需查询。",
        messages: [],
        toolCalls: 1,
        writeCalls: 0,
        toolEvidence: { successful: 1, successfulWrites: 0, unknown: 0, notExecuted: 0 },
      };
    },
  };
  try {
    const sessions = new SessionService(store, engine, { tools: () => [read] });
    const session = sessions.current("owner", "chat");
    const actor = { ownerId: "owner", chatId: "chat", sessionId: session.id, messageId: "first" };
    await sessions.reply(actor, "查看");
    await sessions.reply({ ...actor, messageId: "second" }, "继续查看引用");
    sessions.clear("owner", session.id);
    await sessions.reply({ ...actor, messageId: "third" }, "旧代次引用不应可读");
  } finally {
    store.close();
  }
});

for (const earlierRawCheckpoint of [false, true, "retained-history"] as const)
  test(`an already-projected failed request is not retried (${earlierRawCheckpoint === "retained-history" ? "stale mutable engine history" : earlierRawCheckpoint ? "earlier reduction is superseded" : "reference is not new reduction"})`, async () => {
    const store = new Store(":memory:");
    let calls = 0;
    let writes = 0;
    const canonical = { accepted: true, text: "x".repeat(40000) };
    const write: RuntimeTool = {
      name: "record",
      description: "Record once",
      readOnly: false,
      parameters: { type: "object", properties: {} },
      execute: async () => {
        writes++;
        return canonical;
      },
    };
    const engine: ConversationEngine = {
      contextTokens: 50000,
      summarize: async () => "",
      run: async (input) => {
        calls++;
        if (calls === 1) {
          const result = await input.tools
            .find((tool) => tool.name === write.name)
            ?.execute({}, input.actor);
          assert.ok(input.projectToolResult);
          if (earlierRawCheckpoint) {
            const rawCheckpoint: AgentMessage[] = [
              { role: "user", content: input.prompt, timestamp: 0 },
              response("", [{ type: "toolCall", name: write.name, id: "call", arguments: {} }]),
              {
                role: "toolResult",
                toolName: write.name,
                toolCallId: "call",
                content: [{ type: "text", text: JSON.stringify(canonical) }],
                isError: false,
                timestamp: 0,
              },
            ];
            // Engines may retain their canonical working history in the input
            // array while checkpointing a distinct bounded provider view. That
            // stale mutable array is not proof about the latest failed request.
            if (earlierRawCheckpoint === "retained-history") input.messages.push(...rawCheckpoint);
            await input.onCheckpoint?.(rawCheckpoint);
          }
          const projected = await input.projectToolResult({
            tool: write.name,
            toolCallId: "call",
            args: {},
            result,
          });
          assert.ok((projected as { reference?: string }).reference);
          // This is already the exact bounded request that failed. Recovery must
          // not confuse reference growth since initial history with NEW reduction.
          await input.onCheckpoint?.([
            { role: "user", content: input.prompt, timestamp: 0 },
            response("", [{ type: "toolCall", name: write.name, id: "call", arguments: {} }]),
            {
              role: "toolResult",
              toolName: write.name,
              toolCallId: "call",
              content: [{ type: "text", text: JSON.stringify(projected) }],
              isError: false,
              timestamp: 0,
            },
          ]);
        }
        throw new OperationError(
          "context_budget",
          "mandatory request cannot fit even after projection",
        );
      },
    };
    try {
      const sessions = new SessionService(store, engine, { tools: () => [write] });
      const session = sessions.current("owner", "chat");
      const actor = {
        ownerId: "owner",
        chatId: "chat",
        sessionId: session.id,
        messageId: "no-retry",
      };
      await assert.rejects(sessions.reply(actor, "Record within current constraints"), {
        code: "context_budget",
      });
      assert.equal(
        calls,
        1,
        "retry must require a new durable reduction of the failed request itself",
      );
      assert.equal(writes, 1, "the confirmed side effect remains committed once");
    } finally {
      store.close();
    }
  });

const raw = { accepted: true, text: "x".repeat(6_000_000) };

function fixture() {
  const store = new Store(":memory:");
  let writes = 0;
  const write: RuntimeTool = {
    name: "write",
    description: "Record work",
    readOnly: false,
    parameters: { type: "object", properties: {} },
    execute: async () => {
      writes++;
      return raw;
    },
  };
  const interrupted = async (input: EngineInput, code: string) => {
    await input.tools.find((tool) => tool.name === "write")?.execute({}, input.actor);
    await input.onCheckpoint?.([
      { role: "user", content: input.prompt, timestamp: Date.now() },
      response("", [{ type: "toolCall", name: "write", id: "call", arguments: {} }]),
      {
        role: "toolResult",
        toolName: "write",
        toolCallId: "call",
        content: [{ type: "text", text: JSON.stringify(raw) }],
        isError: false,
        timestamp: Date.now(),
      },
    ]);
    throw new OperationError(code, "interrupted after canonical receipt", "not_executed");
  };
  const checkResume = (input: EngineInput) => {
    assert.equal(
      input.resume,
      true,
      "a context retry must resume the repaired checkpoint, not restart the prompt",
    );
    assert.ok(
      input.messages.some((message) => message.role === "toolResult"),
      "confirmed tool evidence must survive the retry",
    );
    assert.ok(Buffer.byteLength(JSON.stringify(input.messages)) < 100000);
    return {
      text: "请求已记录。",
      messages: input.messages,
      toolCalls: 1,
      writeCalls: 1,
      toolEvidence: { successful: 1, successfulWrites: 1, unknown: 0, notExecuted: 0 },
    };
  };
  return { store, write, interrupted, checkResume, writes: () => writes };
}

test("context-reduction retry consumes the newly durable checkpoint with resume enabled", async () => {
  const f = fixture();
  let calls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) =>
      ++calls === 1 ? f.interrupted(input, "context_budget") : f.checkResume(input),
  };
  try {
    const sessions = new SessionService(f.store, engine, { tools: () => [f.write] });
    const session = sessions.current("owner", "chat");
    await sessions.reply(
      { ownerId: "owner", chatId: "chat", sessionId: session.id, messageId: "request" },
      "记录",
    );
    assert.equal(calls, 2);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test("legacy giant checkpoint is projected before recovery capacity is judged", async () => {
  const f = fixture();
  const interrupted: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: (input) => f.interrupted(input, "model_failed"),
  };
  try {
    const options = { tools: () => [f.write] };
    const sessions = new SessionService(f.store, interrupted, options);
    const session = sessions.current("owner", "chat");
    const actor = { ownerId: "owner", chatId: "chat", sessionId: session.id, messageId: "request" };
    await assert.rejects(sessions.reply(actor, "记录"), { code: "model_failed" });
    const resumed = new SessionService(
      f.store,
      {
        contextTokens: 50000,
        summarize: async () => "",
        run: async (input) => f.checkResume(input),
      },
      options,
    );
    assert.equal(
      resumed.canRecover(actor),
      true,
      "raw legacy bytes are not the size of the repaired model context",
    );
    await resumed.reply(actor, "记录");
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
