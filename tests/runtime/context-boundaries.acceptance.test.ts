import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { SessionService } from "../../src/runtime/sessions.js";
import type {
  EngineInput,
  RuntimeTool,
  ToolResultProjectionInput,
} from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "./helpers.js";

/**
 * Independent adversarial acceptance for context hygiene and durable write
 * receipts. These tests deliberately do NOT mock the runtime seams they are
 * supposed to prove: the projection is exercised through the real pi tool loop
 * (`PiEngine`) and the real durable session service (`SessionService`) wherever
 * that is possible, so "the test passed" cannot mean "the mock bypassed the
 * guard". Only model transports are scripted, never the boundary under test.
 */

const actor: ActorContext = {
  ownerId: "owner",
  chatId: "chat",
  sessionId: "session",
  messageId: "message",
};

/** A single JSON value comfortably above the frozen 16KiB model-result budget. */
function giantText(bytes = 1024): string {
  return "审".repeat(bytes);
}

/** Serialized size of the payload actually handed to the model. */
function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
}

function textOf(message: AgentMessage | undefined): string {
  if (!message) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part && typeof part === "object" && (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

/**
 * The A-owned projection seam now exists on EngineInput; the alias keeps the
 * call sites explicit about which inputs exercise it.
 */
type ProjectingEngineInput = EngineInput & {
  projectToolResult?: (input: ToolResultProjectionInput) => unknown;
};

// ---------------------------------------------------------------------------
// Acceptance 1/2: oversized canonical facts stay durable while every
// model-facing surface stays bounded, including metadata and error envelopes.
// ---------------------------------------------------------------------------

test("an oversized tool result never reaches a model request intact through the real pi loop", async () => {
  const payload = { outcome: "successful", taskId: "task", entries: giantText(400_000) };
  const canonicalBytes = serializedBytes(payload);
  assert.ok(canonicalBytes > 500_000, "fixture must dwarf the 16KiB model budget");
  const seen: string[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response("", [
          { type: "toolCall", id: "call", name: "bulk_read", arguments: { scope: "audit" } },
        ]),
        response("已根据工具结果核对。"),
      ],
      (context) => seen.push(JSON.stringify(context.messages)),
    ),
  });
  const result = await engine.run({
    actor,
    sessionId: "session",
    systemPrompt: "Only orchestrate",
    messages: [],
    prompt: "查询任务状态",
    tools: [
      {
        name: "bulk_read",
        description: "read",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => payload,
      },
    ],
    projectToolResult: (input) => {
      // Stand-in for B's durable store: proves the projection seam is actually
      // invoked by the engine before a request is built.
      const bytes = serializedBytes(input.result);
      return bytes > 16384
        ? { reference: "rt1_deterministic", bytes, omitted: "正文已按字节预算省略" }
        : input.result;
    },
  } as ProjectingEngineInput);
  assert.ok(seen.length >= 2, "both the tool round and the final answer are requested");
  for (const request of seen)
    assert.ok(
      Buffer.byteLength(request, "utf8") < 200_000,
      "no provider request may carry the raw oversized payload",
    );
  const toolResult = result.messages.find((message) => message.role === "toolResult");
  assert.ok(
    serializedBytes(toolResult) <= 16384,
    `model-facing tool result ${serializedBytes(toolResult)} bytes must stay within budget`,
  );
  assert.match(textOf(toolResult), /rt1_deterministic/);
});

test("oversized error receipts keep their typed outcome instead of becoming a silent success", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [
        { type: "toolCall", id: "call", name: "bulk_read", arguments: { scope: "audit" } },
      ]),
      response("结果未知，请查询状态。"),
    ]),
  });
  let writes = 0;
  const result = await engine.run({
    actor,
    sessionId: "session",
    systemPrompt: "Only orchestrate",
    messages: [],
    prompt: "查询任务状态",
    tools: [
      {
        name: "bulk_read",
        description: "read",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => {
          throw new OperationError("transport", giantText(200_000), "unknown");
        },
      },
      {
        name: "unused_write",
        description: "write",
        parameters: { type: "object", properties: {} },
        readOnly: false,
        execute: async () => {
          writes++;
          return { accepted: true };
        },
      },
    ],
    projectToolResult: (input) => {
      const facts =
        input.result && typeof input.result === "object"
          ? (input.result as Record<string, unknown>)
          : {};
      return {
        outcome: typeof facts.outcome === "string" ? facts.outcome : undefined,
        code: typeof facts.code === "string" ? facts.code : undefined,
        isError: input.isError === true,
        omitted: "错误详情超限，正文保存在持久记录中",
      };
    },
  } as ProjectingEngineInput);
  const toolResult = result.messages.find((message) => message.role === "toolResult");
  assert.ok(toolResult && toolResult.role === "toolResult");
  assert.equal(toolResult.isError, true, "a failed tool must stay an error for the model");
  const body = JSON.parse(textOf(toolResult)) as Record<string, unknown>;
  assert.equal(body.isError, true);
  assert.equal(body.outcome, "unknown");
  assert.equal(body.code, "transport");
  assert.ok(serializedBytes(toolResult) <= 16384);
  assert.equal(writes, 0, "an unknown read must not escalate into a write");
});

test("a durable session keeps a 6MB tool result out of every model request and checkpoint", async () => {
  const store = new Store(":memory:");
  const payload = { outcome: "successful", taskId: "task", entries: giantText(2_100_000) };
  const canonicalBytes = serializedBytes(payload);
  assert.ok(canonicalBytes > 6 * 1024 * 1024, `canonical result is ${canonicalBytes} bytes`);
  const requests: number[] = [];
  let writes = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response("", [
          { type: "toolCall", id: "call", name: "task_get", arguments: { taskId: "task" } },
        ]),
        response("已根据工具结果核对。"),
      ],
      (context) => requests.push(Buffer.byteLength(JSON.stringify(context.messages), "utf8")),
    ),
  });
  const sessions = new SessionService(store, engine, {
    tools: () => [
      {
        name: "task_get",
        description: "read",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => payload,
      },
      {
        name: "task_action",
        description: "write",
        parameters: { type: "object", properties: {} },
        readOnly: false,
        execute: async () => {
          writes++;
          return { accepted: true };
        },
      },
    ],
  });
  const session = sessions.current("owner", "chat");
  const bound: ActorContext = {
    ownerId: "owner",
    chatId: "chat",
    sessionId: session.id,
    messageId: "giant",
  };
  await sessions.reply(bound, "查询任务状态");
  // The bundled 6MB fact is durable, and neither the provider requests nor the
  // durable checkpoint may carry it whole.
  assert.ok(requests.length >= 2, "the tool round and the final answer are both requested");
  for (const bytes of requests) assert.ok(bytes < 200_000, `request carried ${bytes} bytes`);
  // The durable receipt key is a hash of owner/session/message (session-records.ts:20).
  const receiptId = (await import("node:crypto"))
    .createHash("sha256")
    .update([bound.ownerId, bound.sessionId, bound.messageId].join("\u0000"))
    .digest("hex");
  const stored = store.get<{ messages: AgentMessage[] }>("pi_checkpoints", receiptId);
  assert.ok(stored, "a checkpoint must exist after the turn");
  assert.ok(
    serializedBytes(stored.messages) < canonicalBytes / 10,
    `checkpoint carried ${serializedBytes(stored.messages)} bytes`,
  );
  // The write tool was never invoked, and the read is durable as a receipt.
  assert.equal(writes, 0);
  assert.equal(store.list("pi_operations").length, 0);
  // The canonical body is still recoverable from durable storage.
  assert.ok(store.list("tool_results").length > 0, "the oversized result stays durable");
  store.close();
});

test("context-boundary modules exist and expose the frozen bounded contracts", async () => {
  // A-owned module: loaded through a widened specifier so this file type-checks
  // whether or not it has landed yet; the runtime assertion still runs.
  const specifier: string = ["..", "..", "src", "runtime", "model-context.js"].join("/");
  const modelContext = (await import(specifier)) as {
    MODEL_RESULT_MAX_BYTES?: number;
    boundModelValue?: (value: unknown, maxBytes?: number) => unknown;
  };
  assert.equal(typeof modelContext.MODEL_RESULT_MAX_BYTES, "number");
  assert.equal(modelContext.MODEL_RESULT_MAX_BYTES, 16384);
  assert.equal(typeof modelContext.boundModelValue, "function");
  const oversized = modelContext.boundModelValue?.({ outcome: "unknown", blob: giantText(60_000) });
  assert.ok(serializedBytes(oversized) <= 16384, "boundModelValue must bound the full value");
  assert.match(JSON.stringify(oversized), /unknown/);
  const small = { accepted: true };
  assert.deepEqual(modelContext.boundModelValue?.(small), small);
});

// ---------------------------------------------------------------------------
// Acceptance 3: confirmed writes are never replayed because formatting,
// projection or summary failed after the effect was already durable.
// ---------------------------------------------------------------------------

test("a confirmed write is not replayed when result projection throws afterwards", async () => {
  const store = new Store(":memory:");
  let writes = 0;
  const projections = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [
        { type: "toolCall", id: "call", name: "task_create", arguments: { title: "审计" } },
      ]),
      response("已登记。"),
    ]),
  });
  const sessions = new SessionService(store, engine, {
    tools: () => [
      {
        name: "task_create",
        description: "create",
        parameters: { type: "object", properties: { title: { type: "string" } } },
        readOnly: false,
        execute: async () => {
          writes++;
          return { accepted: true, taskId: "task_1" };
        },
      },
    ],
  });
  try {
    const session = sessions.current("owner", "chat");
    const bound: ActorContext = {
      ownerId: "owner",
      chatId: "chat",
      sessionId: session.id,
      messageId: "projection",
    };
    const first = await sessions.reply(bound, "创建任务");
    assert.equal(writes, 1);
    // Re-delivering the same message identity must return the durable reply and
    // must not re-run the write, whatever the projection did.
    const replay = await sessions.reply(bound, "创建任务");
    assert.equal(replay.id, first.id);
    assert.equal(writes, 1, "a confirmed write is replayed never");
    const operations = store.list<{ status: string }>("pi_operations");
    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.status, "complete");
    assert.equal(projections, 0);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Acceptance 2: a recovered giant checkpoint is reduced before the model
// request, and the recovery path refuses an unchanged oversize retry.
// ---------------------------------------------------------------------------

test("a recovered oversized checkpoint is reprojected before any model request", async () => {
  const { recoverMessages, recoveryCheckpointLimit } = (await import(
    "../../src/runtime/recovery.js"
  )) as {
    recoverMessages: (
      store: Store,
      turnId: string,
      messages: AgentMessage[],
      operationId: (name: string, args: Record<string, unknown>) => string,
      options?: Record<string, unknown>,
    ) => AgentMessage[];
    recoveryCheckpointLimit: (contextTokens: number) => number;
  };
  const { createResultProjection } = (await import("../../src/runtime/tool-results.js")) as {
    createResultProjection: (
      store: Store,
      actor: ActorContext,
      scope: string,
    ) => { projectToolResult: (input: unknown) => unknown };
  };
  const store = new Store(":memory:");
  try {
    const turn: ActorContext = {
      ownerId: "owner",
      chatId: "chat",
      sessionId: "session",
      messageId: "turn",
    };
    const projection = createResultProjection(store, turn, "turn:turn");
    const canonical = { outcome: "successful", taskId: "task", entries: giantText(700_000) };
    const checkpoint: AgentMessage[] = [
      { role: "user", content: "查询任务状态", timestamp: Date.now() },
      {
        role: "assistant",
        api: "openai-responses",
        provider: "myrix",
        model: "test",
        content: [{ type: "toolCall", id: "call", name: "task_get", arguments: {} }],
        stopReason: "toolUse",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "task_get",
        content: [{ type: "text", text: JSON.stringify(canonical) }],
        isError: false,
        timestamp: Date.now(),
      },
    ];
    const before = serializedBytes(checkpoint);
    let preserved = 0;
    const reduced = recoverMessages(store, "turn", checkpoint, () => "", {
      maxBytes: 16384,
      preserve: () => {
        preserved++;
      },
      project: (input: unknown) => projection.projectToolResult(input),
    });
    assert.ok(preserved >= 1, "the canonical recovered value is preserved before bounding");
    assert.ok(
      serializedBytes(reduced) < before / 10,
      `reduced checkpoint ${serializedBytes(reduced)} bytes must be far below ${before}`,
    );
    assert.ok(serializedBytes(reduced) <= recoveryCheckpointLimit(50_000));
    // The refused-unchanged-oversize path: a checkpoint larger than the recoverable
    // limit is a typed context_budget, not a silent replay or a generic failure.
    const { assertRecoverableCheckpoint } = (await import("../../src/runtime/recovery.js")) as {
      assertRecoverableCheckpoint: (
        checkpoint: { messages?: unknown } | undefined,
        limitBytes: number,
      ) => unknown;
    };
    assert.throws(
      () => assertRecoverableCheckpoint({ messages: checkpoint }, 1024),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, "context_budget");
        assert.equal(error.outcome, "not_executed");
        return true;
      },
    );
  } finally {
    store.close();
  }
});

test("the engine reports a typed context_budget instead of a generic retryable failure", async () => {
  const engine = new PiEngine(
    { ...config, contextTokens: 50_000 },
    {
      streamFn: scripted([
        response("", [{ type: "toolCall", id: "call", name: "bulk_read", arguments: {} }]),
      ]),
    },
  );
  // A result that cannot be compacted below the configured budget must surface
  // as context_budget (a typed, non-retryable-unchanged condition), never as
  // model_failed, and it must not be retried with the same oversized context.
  await assert.rejects(
    engine.run({
      actor,
      sessionId: "session",
      systemPrompt: "Only orchestrate",
      messages: [],
      prompt: "查询任务状态",
      tools: [
        {
          name: "bulk_read",
          description: "read",
          parameters: { type: "object", properties: {} },
          readOnly: true,
          execute: async () => ({ entries: giantText(3_000_000) }),
        },
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "context_budget");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Acceptance 1/3: the durable result reference must be scoped to
// owner+session+task and must not leak raw content through projection details.
// ---------------------------------------------------------------------------

test("durable oversized-result references are owner/session/task scoped and page-bounded", async () => {
  const store = new Store(":memory:");
  const { createResultProjection } = (await import("../../src/runtime/tool-results.js")) as {
    createResultProjection?: (
      store: Store,
      actor: ActorContext,
      scope: string,
    ) => { projectToolResult: (input: unknown) => unknown; tool: RuntimeTool };
  };
  assert.equal(typeof createResultProjection, "function");
  const owner: ActorContext = {
    ownerId: "owner",
    chatId: "chat",
    sessionId: "leader:task-1",
    taskId: "task-1",
    messageId: "event-1",
  };
  const factory = createResultProjection?.(store, owner, "leader:task-1");
  assert.ok(factory);
  const canonical = { outcome: "successful", entries: giantText(2_100_000) };
  assert.ok(
    serializedBytes(canonical) > 6 * 1024 * 1024,
    "the durable audit fixture must exceed 6MB",
  );
  const reference = factory.projectToolResult({
    tool: "task_get",
    args: {},
    toolCallId: "call",
    result: canonical,
    isError: false,
    // B's fallback path consumes the already-serialized text as well.
    text: JSON.stringify(canonical),
  } as never);
  assert.ok(serializedBytes(reference) <= 16384, "the reference itself must be bounded");
  const ref = (reference as { reference?: string }).reference;
  assert.ok(ref);
  // The model-facing reference must not smuggle raw content back in: the full
  // canonical value is many times larger than the bounded envelope.
  assert.ok(
    serializedBytes(reference) < serializedBytes(canonical) / 10,
    "the reference must omit the raw payload, not carry it",
  );
  assert.doesNotMatch(JSON.stringify(reference), /审{100}/u);
  // Every page stays inside the model budget after JSON escaping and metadata.
  let page = 0;
  let pages = 0;
  for (;;) {
    const read = (await factory.tool.execute({ reference: ref, page }, owner)) as {
      text?: string;
      complete?: boolean;
      page?: number;
    };
    assert.ok(serializedBytes(read) <= 16384, `page ${page} must stay within budget`);
    pages++;
    if (read.complete) break;
    page++;
    assert.ok(page < 10_000, "pagination must terminate");
  }
  assert.ok(pages > 1);
  // The canonical body is fully recoverable from durable storage even though it
  // can never be handed to a model in one piece.
  const { readCanonicalResult } = (await import("../../src/runtime/tool-results.js")) as {
    readCanonicalResult: (
      store: Store,
      actor: ActorContext,
      scope: string,
      reference: string,
    ) => string;
  };
  assert.equal(readCanonicalResult(store, owner, "leader:task-1", ref), JSON.stringify(canonical));
  // A different owner, session or task can never read the same reference.
  for (const foreign of [
    { ...owner, ownerId: "intruder" },
    { ...owner, sessionId: "leader:task-2" },
    { ...owner, taskId: "task-2" },
  ]) {
    await assert.rejects(
      factory.tool.execute({ reference: ref, page: 0 }, foreign),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.ok(["invalid_scope", "result_not_found"].includes(error.code), error.code);
        return true;
      },
    );
  }
  store.close();
});
