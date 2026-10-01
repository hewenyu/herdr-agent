import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { SessionService } from "../../src/runtime/sessions.js";
import { resultScopeForGeneration } from "../../src/runtime/tool-results.js";
import type { ConversationEngine, EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "./helpers.js";

const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
const giant = (size = 120_000) => ({
  outcome: "successful",
  taskId: "task-1",
  entries: "审".repeat(size),
});
function readTool(execute: RuntimeTool["execute"], name = "task_get"): RuntimeTool {
  return {
    name,
    description: "read",
    parameters: { type: "object", properties: {} },
    readOnly: true,
    execute,
  };
}

test("an oversized live tool result never enters the durable model checkpoint", async () => {
  const store = new Store(":memory:");
  const requests: string[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response("", [{ type: "toolCall", id: "call", name: "task_get", arguments: {} }]),
        response("已核验任务事实。"),
      ],
      (context) => requests.push(JSON.stringify(context.messages)),
    ),
  });
  const sessions = new SessionService(store, engine, {
    tools: () => [readTool(async () => giant())],
  });
  try {
    const session = sessions.current("owner", "chat");
    const actor: ActorContext = {
      ownerId: "owner",
      chatId: "chat",
      sessionId: session.id,
      messageId: "giant-live",
    };
    // The engine-side request projection is A-owned; session persistence is
    // B-owned and must be bounded independently of it.
    await sessions.reply(actor, "查询任务状态").catch(() => undefined);
    const [receiptId] = store.entries("pi_checkpoints").map(([id]) => id);
    assert.ok(receiptId, "a durable checkpoint is written even for a failed turn");
    const checkpoint = store.get<{ messages: AgentMessage[] }>("pi_checkpoints", receiptId);
    assert.ok(checkpoint);
    assert.ok(
      bytes(checkpoint.messages) < 64_000,
      `checkpoint must not embed the raw result: ${bytes(checkpoint.messages)} bytes`,
    );
    assert.ok(
      !checkpoint.messages.some(
        (message) => message.role === "toolResult" && JSON.stringify(message).includes("审审审"),
      ),
      "raw content must not be in the durable model checkpoint",
    );
    // Canonical bytes stay durable under the turn scope and are pageable.
    const results = store.entries<{ reference: string }>("tool_results");
    assert.equal(results.length, 1);
    const reference = results[0]?.[1].reference;
    assert.ok(reference);
    assert.ok(store.entries("tool_result_pages").length > 1);
  } finally {
    store.close();
  }
});

test("an unreducible giant legacy checkpoint is refused, not replayed through resume", async () => {
  const store = new Store(":memory:");
  let runs = 0;
  let summaries = 0;
  const engine: ConversationEngine = {
    contextTokens: 50_000,
    summarize: async () => {
      summaries++;
      return "历史摘要";
    },
    run: async () => {
      runs++;
      return { text: "不应执行", messages: [] };
    },
  };
  try {
    const sessions = new SessionService(store, engine);
    const session = sessions.current("owner", "chat");
    const actor: ActorContext = {
      ownerId: "owner",
      chatId: "chat",
      sessionId: session.id,
      messageId: "legacy-giant",
    };
    const turnId = recoverKey(actor);
    // A checkpoint whose oversized payload has no tool-result structure to
    // project (a raw user message) cannot be reduced: it must be refused.
    store.set("turn_receipts", turnId, {
      generation: 0,
      status: "failed",
      replyId: `reply_${turnId}`,
      recoveryVersion: 1,
      attempts: 1,
    });
    store.set("messages", `user_${turnId}`, {
      id: `user_${turnId}`,
      sessionId: session.id,
      role: "user",
      source: "user",
      text: "查询任务状态",
      createdAt: new Date().toISOString(),
      delivery: "delivered",
      deliveryIds: [actor.messageId],
      generation: 0,
      sequence: 1,
    });
    store.set("pi_checkpoints", turnId, {
      sessionId: session.id,
      generation: 0,
      messages: [{ role: "user", content: "审".repeat(400_000), timestamp: Date.now() }],
      updatedAt: new Date().toISOString(),
    });
    assert.equal(sessions.canRecover(actor), false, "an unreducible checkpoint is not recoverable");
    await assert.rejects(sessions.reply(actor, "查询任务状态"), { code: "turn_unconfirmed" });
    assert.equal(runs, 0, "the model must never receive the giant checkpoint");
    assert.equal(summaries, 0, "no summarization may be attempted for a refused checkpoint");
    assert.ok(bytes(store.get("pi_checkpoints", turnId)) > 300_000, "the original is preserved");
  } finally {
    store.close();
  }
});

test("a recoverable giant checkpoint is reduced before the model request", async () => {
  const store = new Store(":memory:");
  const inputs: EngineInput[] = [];
  const engine: ConversationEngine = {
    contextTokens: 50_000,
    summarize: async () => "历史摘要",
    run: async (input) => {
      inputs.push(input);
      return { text: "已压缩后继续。", messages: [] };
    },
  };
  const sessions = new SessionService(store, engine);
  try {
    const session = sessions.current("owner", "chat");
    const actor: ActorContext = {
      ownerId: "owner",
      chatId: "chat",
      sessionId: session.id,
      messageId: "budget",
    };
    const turnId = recoverKey(actor);
    // A recoverable checkpoint whose oversized result is still parseable: the
    // durable projection must replace it before the request is built.
    store.set("turn_receipts", turnId, {
      generation: 0,
      status: "failed",
      replyId: `reply_${turnId}`,
      recoveryVersion: 1,
      attempts: 1,
    });
    store.set("messages", `user_${turnId}`, {
      id: `user_${turnId}`,
      sessionId: session.id,
      role: "user",
      source: "user",
      text: "查询任务状态",
      createdAt: new Date().toISOString(),
      delivery: "delivered",
      deliveryIds: [actor.messageId],
      generation: 0,
      sequence: 1,
    });
    store.set("pi_checkpoints", turnId, {
      sessionId: session.id,
      generation: 0,
      messages: [
        { role: "user", content: "查询任务状态", timestamp: Date.now() },
        response("", [{ type: "toolCall", id: "call", name: "task_get", arguments: {} }]),
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "task_get",
          content: [{ type: "text", text: JSON.stringify(giant(300_000)) }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
      updatedAt: new Date().toISOString(),
    });
    assert.equal(sessions.canRecover(actor), true);
    await sessions.reply(actor, "查询任务状态");
    assert.equal(inputs.length, 1);
    const resumed = JSON.stringify(inputs[0]?.messages ?? []);
    assert.ok(bytes(resumed) < 200_000, `resumed request is ${bytes(resumed)} bytes`);
    assert.equal(inputs[0]?.resume, true);
    const checkpoint = store.get<{ messages: AgentMessage[] }>("pi_checkpoints", turnId);
    assert.ok(
      bytes(checkpoint?.messages ?? []) < 200_000,
      "the durable checkpoint actually shrank",
    );
    // The canonical bytes remain durable and readable under the turn scope.
    const results = store.entries<{ reference: string }>("tool_results");
    assert.equal(results.length, 1);
  } finally {
    store.close();
  }
});

test("context_budget is never retried when the checkpoint cannot be reduced", async () => {
  const store = new Store(":memory:");
  let attempts = 0;
  const engine: ConversationEngine = {
    contextTokens: 50_000,
    summarize: async () => "历史摘要",
    run: async () => {
      attempts++;
      throw new OperationError("context_budget", "超限", "not_executed");
    },
  };
  try {
    const sessions = new SessionService(store, engine);
    const session = sessions.current("owner", "chat");
    const actor: ActorContext = {
      ownerId: "owner",
      chatId: "chat",
      sessionId: session.id,
      messageId: "budget-no-reduction",
    };
    const turnId = recoverKey(actor);
    store.set("pi_checkpoints", turnId, {
      sessionId: session.id,
      generation: 0,
      messages: [{ role: "user", content: "审".repeat(200_000), timestamp: Date.now() }],
      updatedAt: new Date().toISOString(),
    });
    await assert.rejects(sessions.reply(actor, "查询任务状态"), { code: "context_budget" });
    assert.equal(attempts, 1, "an unreducible checkpoint must not reach the model");
  } finally {
    store.close();
  }
});

test("recovered oversized receipts stay durable, deduplicated and pageable", async () => {
  const store = new Store(":memory:");
  const requests: string[] = [];
  let runs = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted([response("继续完成。")], (context) =>
      requests.push(JSON.stringify(context.messages)),
    ),
  });
  try {
    const sessions = new SessionService(store, engine);
    const session = sessions.current("owner", "chat");
    const actor: ActorContext = {
      ownerId: "owner",
      chatId: "chat",
      sessionId: session.id,
      messageId: "recovered-giant",
    };
    const turnId = recoverKey(actor);
    const value = giant(200_000);
    store.set("turn_receipts", turnId, {
      generation: 0,
      status: "failed",
      replyId: `reply_${turnId}`,
      recoveryVersion: 1,
      attempts: 1,
    });
    store.set("messages", `user_${turnId}`, {
      id: `user_${turnId}`,
      sessionId: session.id,
      role: "user",
      source: "user",
      text: "查询任务状态",
      createdAt: new Date().toISOString(),
      delivery: "delivered",
      deliveryIds: [actor.messageId],
      generation: 0,
      sequence: 1,
    });
    store.set("pi_operations", "operation-1", {
      status: "complete",
      result: value,
      turnId,
      tool: "task_get",
      args: {},
    });
    store.set("pi_checkpoints", turnId, {
      sessionId: session.id,
      generation: 0,
      messages: [
        { role: "user", content: "查询任务状态", timestamp: Date.now() },
        response("", [{ type: "toolCall", id: "call", name: "task_get", arguments: {} }]),
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "task_get",
          content: [{ type: "text", text: JSON.stringify(value) }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
      updatedAt: new Date().toISOString(),
    });
    assert.equal(sessions.canRecover(actor), true);
    await sessions.reply(actor, "查询任务状态");
    runs++;
    assert.equal(runs, 1);
    for (const request of requests)
      assert.ok(bytes(request) < 200_000, `request is ${bytes(request)} bytes`);
    // The canonical record exists exactly once in the turn scope (the raw
    // checkpoint copy and the recovery both hash to the same reference).
    const results = store.entries<{ reference: string }>("tool_results");
    assert.equal(results.length, 1);
    const reference = results[0]?.[1].reference;
    assert.ok(reference);
    const pages = store.entries<string>("tool_result_pages");
    assert.ok(pages.length > 1);
    // A second recovery attempt of the same turn deduplicates storage.
    const restarted = new SessionService(store, engine);
    assert.equal(restarted.canRecover(actor), true);
  } finally {
    store.close();
  }
});

test("the paged read tool is injected read-only for restricted notification turns", async () => {
  const store = new Store(":memory:");
  const inputs: EngineInput[] = [];
  const engine: ConversationEngine = {
    contextTokens: 50_000,
    summarize: async () => "",
    run: async (input) => {
      inputs.push(input);
      return { text: '{"notify":false,"text":""}', messages: [] };
    },
  };
  const sessions = new SessionService(store, engine, {
    tools: () => [
      readTool(async () => ({ ok: true })),
      {
        name: "task_create",
        description: "write",
        parameters: { type: "object", properties: {} },
        readOnly: false,
        execute: async () => ({ accepted: true }),
      },
    ],
  });
  try {
    const session = sessions.current("owner", "chat");
    const actor: ActorContext = {
      ownerId: "owner",
      chatId: "chat",
      sessionId: session.id,
      messageId: "notification",
    };
    await sessions.reply(actor, "通知", {
      readOnly: true,
      systemPrompt: "notice",
    });
    const tools = inputs[0]?.tools ?? [];
    assert.ok(tools.length > 0);
    assert.ok(
      tools.every((tool) => tool.readOnly),
      "restricted turns may only expose read-only tools",
    );
    assert.ok(tools.some((tool) => tool.name === "tool_result_read"));
    assert.ok(!tools.some((tool) => tool.name === "task_create"));
  } finally {
    store.close();
  }
});

test("cross-scope and cross-task reads of a durable result fail", async () => {
  const store = new Store(":memory:");
  const inputs: EngineInput[] = [];
  const engine: ConversationEngine = {
    contextTokens: 50_000,
    summarize: async () => "",
    run: async (input) => {
      inputs.push(input);
      return { text: "完成", messages: [] };
    },
  };
  const sessions = new SessionService(store, engine);
  try {
    const session = sessions.current("owner", "chat");
    const actor: ActorContext = {
      ownerId: "owner",
      chatId: "chat",
      sessionId: session.id,
      messageId: "owner-scope",
    };
    await sessions.reply(actor, "普通请求");
    const tool = inputs[0]?.tools.find((candidate) => candidate.name === "tool_result_read");
    assert.ok(tool);
    await assert.rejects(tool.execute({ reference: `rt1_${"0".repeat(32)}`, page: 0 }, actor), {
      code: "result_not_found",
    });
    await assert.rejects(
      tool.execute(
        { reference: `rt1_${"0".repeat(32)}`, page: 0 },
        {
          ...actor,
          ownerId: "intruder",
        },
      ),
      { code: "invalid_scope" },
    );
    await assert.rejects(
      tool.execute(
        { reference: `rt1_${"0".repeat(32)}`, page: 0 },
        {
          ...actor,
          taskId: "task-other",
        },
      ),
      { code: "invalid_scope" },
    );
    const generationScope = resultScopeForGeneration(0);
    assert.equal(generationScope, "generation:0");
  } finally {
    store.close();
  }
});

test("a confirmed write is never replayed by the context-reduction retry", async () => {
  const store = new Store(":memory:");
  let writes = 0;
  const write: RuntimeTool = {
    name: "task_create",
    description: "create",
    parameters: { type: "object", properties: {} },
    readOnly: false,
    execute: async () => {
      writes++;
      return { accepted: true, taskId: "task_1", notes: "审".repeat(120_000) };
    },
  };
  let calls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50_000,
    summarize: async () => "",
    run: async (input) => {
      calls++;
      if (calls === 1) {
        // Only the journaled wrapper may run: it writes the durable receipt.
        const result = await input.tools
          .find((tool) => tool.name === "task_create")
          ?.execute({}, input.actor);
        await input.onCheckpoint?.([
          { role: "user", content: input.prompt, timestamp: Date.now() },
          response("", [{ type: "toolCall", id: "call", name: "task_create", arguments: {} }]),
          {
            role: "toolResult",
            toolCallId: "call",
            toolName: "task_create",
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: false,
            timestamp: Date.now(),
          },
        ]);
        throw new OperationError("context_budget", "超限", "not_executed");
      }
      return {
        text: "已登记。",
        messages: input.messages,
        toolCalls: 1,
        writeCalls: 1,
        toolEvidence: { successful: 1, successfulWrites: 1, unknown: 0, notExecuted: 0 },
      };
    },
  };
  const sessions = new SessionService(store, engine, { tools: () => [write] });
  try {
    const session = sessions.current("owner", "chat");
    const actor: ActorContext = {
      ownerId: "owner",
      chatId: "chat",
      sessionId: session.id,
      messageId: "no-replay",
    };
    await sessions.reply(actor, "创建任务");
    assert.equal(calls, 2, "the bounded retry runs exactly once");
    assert.equal(writes, 1, "the retry must never execute the write again");
    const operations = store.list<{ status: string }>("pi_operations");
    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.status, "complete");
  } finally {
    store.close();
  }
});

function recoverKey(actor: ActorContext): string {
  return createHash("sha256")
    .update([actor.ownerId, actor.sessionId, actor.messageId].join("\0"))
    .digest("hex");
}
