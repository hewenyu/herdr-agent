import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import {
  boundCheckpointMessages,
  boundRecoveryValue,
  RECOVERY_RESULT_MAX_BYTES,
  recoverMessagesDetailed,
  type TurnEffect,
} from "../../src/runtime/recovery.js";
import { SessionService } from "../../src/runtime/sessions.js";
import {
  createResultProjection,
  readCanonicalResult,
  resultScopeForGeneration,
} from "../../src/runtime/tool-results.js";
import type { ConversationEngine, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { response } from "./helpers.js";

/**
 * Follow-up review of the recovery envelope bound: the whole serialized
 * tool-result message must fit — nested escaping, `details` and legacy
 * non-JSON text included — and a completed canonical receipt must never be
 * presented to the model as an unexecuted call.
 */
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");

const actor: ActorContext = {
  ownerId: "owner",
  chatId: "chat",
  sessionId: "session",
  messageId: "turn",
};

function result(
  text: string,
  extra: Record<string, unknown> = {},
): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: "call",
    toolName: "inspect",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
    ...extra,
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

function body(message: AgentMessage): Record<string, unknown> {
  assert.equal(message.role, "toolResult");
  const part = (message as Extract<AgentMessage, { role: "toolResult" }>).content.find(
    (entry) => entry.type === "text",
  );
  assert.ok(part?.type === "text");
  return JSON.parse(part.text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Legacy non-JSON text: the durable source is consulted before any bound.
// ---------------------------------------------------------------------------

test("legacy non-JSON text is preserved losslessly instead of being truncated", async () => {
  const store = new Store(":memory:");
  try {
    const projection = createResultProjection(store, actor, resultScopeForGeneration(0));
    const text = `legacy ${"\u0000".repeat(6000)}`;
    let seen: string | undefined;
    const [bounded] = boundCheckpointMessages([result(text)], {
      projectLegacy: (input) => {
        seen = input.text;
        return projection.projectToolResult({
          tool: input.tool,
          args: {},
          toolCallId: input.toolCallId,
          result: input.text,
          isError: input.isError,
        });
      },
    });
    assert.ok(bounded);
    assert.equal(seen, text, "the projection receives the raw text, not an excerpt");
    assert.ok(bytes(bounded) <= RECOVERY_RESULT_MAX_BYTES, `envelope is ${bytes(bounded)} bytes`);
    const envelope = body(bounded) as { reference?: string; outcome?: string; persisted?: boolean };
    assert.equal(typeof envelope.reference, "string", "the durable reference must be returned");
    assert.equal(envelope.persisted, true);
    // The legacy bytes remain retrievable byte for byte through the scoped reader.
    assert.equal(typeof envelope.reference, "string");
    const canonical = readCanonicalResult(
      store,
      actor,
      resultScopeForGeneration(0),
      String(envelope.reference),
    );
    assert.equal(canonical, JSON.stringify(text));
  } finally {
    store.close();
  }
});

test("legacy text without a durable projection fails closed instead of claiming storage", () => {
  const [bounded] = boundCheckpointMessages([result(`legacy ${"\u0000".repeat(6000)}`)]);
  assert.ok(bounded);
  assert.ok(bytes(bounded) <= RECOVERY_RESULT_MAX_BYTES);
  const envelope = body(bounded);
  assert.equal(envelope.outcome, "unknown", "an omitted body is never a success");
  assert.equal(envelope.isError, false, "the original error flag is preserved exactly");
  assert.equal(envelope.reference, undefined, "no durable reference may be invented");
  assert.notEqual(envelope.persisted, true, "persistence may not be claimed without proof");
  assert.ok(
    typeof envelope.omitted === "string" && envelope.omitted.length > 0,
    "the omission is explicit",
  );
  // A truncating bound cannot satisfy this fixture: the whole message is bounded.
  assert.equal((bounded as { toolCallId: string }).toolCallId, "call");
});

test("an error legacy result keeps its error semantics through the envelope bound", () => {
  const [bounded] = boundCheckpointMessages([
    result(`boom ${"\u0000".repeat(6000)}`, { isError: true }),
  ]);
  assert.ok(bounded);
  assert.ok(bytes(bounded) <= RECOVERY_RESULT_MAX_BYTES);
  assert.equal((bounded as { isError: boolean }).isError, true);
  const envelope = body(bounded);
  assert.equal(envelope.isError, true);
  assert.equal(envelope.outcome, "unknown");
});

// ---------------------------------------------------------------------------
// 2. Irreducible identity: typed fail-closed, never a rewritten call id.
// ---------------------------------------------------------------------------

test("irreducible call identity fails closed without altering the original message", () => {
  for (const id of ["🔒".repeat(5000), "c".repeat(20000), "\\".repeat(9000)]) {
    const message = result(JSON.stringify({ observed: true }), { toolCallId: id });
    assert.ok(bytes(message) > RECOVERY_RESULT_MAX_BYTES, "fixture must exceed the budget");
    const snapshot = JSON.stringify(message);
    assert.throws(
      () => boundCheckpointMessages([message]),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, "context_budget");
        assert.equal(error.outcome, "not_executed");
        return true;
      },
      `identity of ${id.length} characters must fail closed`,
    );
    assert.equal(JSON.stringify(message), snapshot, "the refused message stays untouched");
  }
});

test("a matched batch keeps its identity when only the body is oversized", () => {
  const call = response("", [{ type: "toolCall", id: "call", name: "inspect", arguments: {} }]);
  const bounded = boundCheckpointMessages([
    { role: "user", content: "查询", timestamp: 1 },
    call,
    result(JSON.stringify({ body: "\\".repeat(6000) })),
  ]);
  assert.equal(bounded.length, 3, "no message of a matched batch is dropped");
  assert.equal((bounded[1] as { content: unknown[] }).content.length, 1);
  const recovered = bounded[2];
  assert.ok(recovered);
  assert.equal((recovered as { toolCallId: string }).toolCallId, "call");
  assert.equal(bounded[1], call, "the assistant call identity is never rewritten");
  const envelope = body(recovered);
  assert.equal(envelope.outcome, "unknown");
});

// ---------------------------------------------------------------------------
// 3. Whole-envelope bytes: details, escaping and custom projections.
// ---------------------------------------------------------------------------

test("a giant details field cannot smuggle a message past the envelope budget", () => {
  const [bounded] = boundCheckpointMessages([
    result(JSON.stringify({ outcome: "successful", accepted: true }), {
      details: { blob: "d".repeat(40000) },
      usage: { tokens: "u".repeat(20000) },
    } as Record<string, unknown>),
  ]);
  assert.ok(bounded);
  assert.ok(bytes(bounded) <= RECOVERY_RESULT_MAX_BYTES, `envelope is ${bytes(bounded)} bytes`);
  assert.equal((bounded as { toolCallId: string }).toolCallId, "call");
  const envelope = body(bounded);
  assert.equal(envelope.outcome, "successful", "the canonical outcome is preserved");
  assert.equal(envelope.accepted, true, "scalar facts survive the reduction");
});

test("a custom projection is bounded rather than trusted", () => {
  const preserved: unknown[] = [];
  const [bounded] = boundCheckpointMessages(
    [result(JSON.stringify({ outcome: "not_executed", body: "x".repeat(30000) }))],
    {
      project: () => ({ outcome: "successful", body: "\\".repeat(60000) }),
      preserve: (input) => preserved.push(input.value),
    },
  );
  assert.ok(bounded);
  assert.ok(bytes(bounded) <= RECOVERY_RESULT_MAX_BYTES, `envelope is ${bytes(bounded)} bytes`);
  assert.equal(preserved.length, 1, "the canonical value is preserved before any bound");
  const envelope = body(bounded);
  // The projection is not trusted to reclassify the effect: its own oversized
  // envelope is reduced, and the outcome comes from the canonical value.
  assert.equal(envelope.outcome, "not_executed", "a refusal is never promoted to success");
});

test("an oversized legacy projection is bounded instead of reaching the checkpoint", () => {
  const [bounded] = boundCheckpointMessages([result(`legacy ${"\u0000".repeat(6000)}`)], {
    projectLegacy: () => ({ body: "\\".repeat(60000) }),
  });
  assert.ok(bounded);
  assert.ok(bytes(bounded) <= RECOVERY_RESULT_MAX_BYTES, `envelope is ${bytes(bounded)} bytes`);
  assert.equal(body(bounded).outcome, "unknown");
});

test("nested error metadata is bounded by escaped bytes and keeps its outcome", () => {
  const canonical = {
    outcome: "not_executed",
    error: { code: "🔒".repeat(10000), message: "failed", outcome: "not_executed" },
  };
  for (const budget of [512, 4096, RECOVERY_RESULT_MAX_BYTES]) {
    const bounded = boundRecoveryValue(canonical, budget) as Record<string, unknown>;
    assert.ok(bytes(bounded) <= budget, `marker is ${bytes(bounded)} bytes for budget ${budget}`);
    assert.equal(bounded.outcome, "not_executed", "a refusal is never promoted to success");
    const error = bounded.error;
    assert.equal(typeof error, "string", "the nested error stays readable as JSON");
    const parsed = JSON.parse(String(error)) as Record<string, unknown>;
    assert.equal(parsed.outcome, "not_executed");
    assert.equal(parsed.message, "failed", "small error facts survive beside a giant code");
  }
});

test("an irreducible marker budget fails closed instead of overshooting", () => {
  assert.throws(
    () => boundRecoveryValue({ outcome: "unknown", body: "x".repeat(4000) }, 2),
    (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "context_budget");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Canonical receipts: restore, never reclassify, never reissue.
// ---------------------------------------------------------------------------

function opId(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`;
}

test("recoverMessagesDetailed restores a completed receipt as a successful value", () => {
  const store = new Store(":memory:");
  try {
    store.set<TurnEffect>("pi_operations", opId("write", {}), {
      status: "complete",
      result: { accepted: true, id: "committed" },
      turnId: "turn",
      tool: "write",
      args: {},
    });
    const messages: AgentMessage[] = [
      response("", [{ type: "toolCall", id: "small", name: "write", arguments: {} }]),
    ];
    const outcome = recoverMessagesDetailed(store, "turn", messages, opId, { maxBytes: 16384 });
    assert.equal(outcome.restored.total, 1);
    assert.equal(outcome.restored.completed, 1);
    const recovered = outcome.messages.find((message) => message.role === "toolResult");
    assert.ok(recovered?.role === "toolResult");
    assert.equal(recovered.isError, false, "a completed receipt is not an unexecuted call");
    assert.deepEqual(body(recovered), { accepted: true, id: "committed" });
  } finally {
    store.close();
  }
});

test("recoverMessagesDetailed closes a call with no receipt as not_executed", () => {
  const store = new Store(":memory:");
  try {
    const outcome = recoverMessagesDetailed(
      store,
      "turn",
      [response("", [{ type: "toolCall", id: "gone", name: "write", arguments: {} }])],
      opId,
      { maxBytes: 16384 },
    );
    assert.equal(outcome.restored.total, 1);
    assert.equal(outcome.restored.completed, 0);
    const recovered = outcome.messages.find((message) => message.role === "toolResult");
    assert.ok(recovered?.role === "toolResult");
    assert.equal(recovered.isError, true);
    assert.equal(body(recovered).code, "interrupted_before_result");
  } finally {
    store.close();
  }
});

test("a pending effect anywhere blocks inference even for another completed call", () => {
  const store = new Store(":memory:");
  try {
    store.set<TurnEffect>("pi_operations", opId("write", { n: 1 }), {
      status: "complete",
      result: { accepted: true },
      turnId: "turn",
      tool: "write",
      args: { n: 1 },
    });
    store.set<TurnEffect>("pi_operations", opId("write", { n: 2 }), {
      status: "pending",
      turnId: "turn",
      tool: "write",
      args: { n: 2 },
    });
    assert.throws(
      () =>
        recoverMessagesDetailed(
          store,
          "turn",
          [response("", [{ type: "toolCall", id: "a", name: "write", arguments: { n: 1 } }])],
          opId,
          { maxBytes: 16384 },
        ),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, "operation_unconfirmed");
        assert.equal(error.outcome, "unknown");
        return true;
      },
    );
  } finally {
    store.close();
  }
});

test("an unknown recorded result blocks recovery before any not_executed marker", () => {
  const store = new Store(":memory:");
  try {
    store.set<TurnEffect>("pi_operations", opId("write", {}), {
      status: "complete",
      result: { outcome: "unknown" },
      turnId: "turn",
      tool: "write",
      args: {},
    });
    assert.throws(
      () =>
        recoverMessagesDetailed(
          store,
          "turn",
          [response("", [{ type: "toolCall", id: "a", name: "write", arguments: {} }])],
          opId,
          { maxBytes: 16384 },
        ),
      { code: "operation_unconfirmed" },
    );
  } finally {
    store.close();
  }
});

test("an oversized restored receipt becomes a durable reference, not a bare marker", () => {
  const store = new Store(":memory:");
  try {
    const scope = resultScopeForGeneration(0);
    const projection = createResultProjection(store, actor, scope);
    const value = { accepted: true, body: "x".repeat(100000) };
    store.set<TurnEffect>("pi_operations", opId("write", {}), {
      status: "complete",
      result: value,
      turnId: "turn",
      tool: "write",
      args: {},
    });
    const outcome = recoverMessagesDetailed(
      store,
      "turn",
      [response("", [{ type: "toolCall", id: "restored", name: "write", arguments: {} }])],
      opId,
      {
        maxBytes: RECOVERY_RESULT_MAX_BYTES,
        project: (input) => projection.projectToolResult(input),
      },
    );
    const recovered = outcome.messages.find((message) => message.role === "toolResult");
    assert.ok(recovered);
    assert.ok(bytes(recovered) <= RECOVERY_RESULT_MAX_BYTES);
    assert.equal((recovered as { toolCallId: string }).toolCallId, "restored");
    const envelope = body(recovered) as { reference?: string; outcome?: string };
    assert.equal(typeof envelope.reference, "string", "the body stays retrievable");
    assert.equal(envelope.outcome, "successful");
    assert.equal(
      readCanonicalResult(store, actor, scope, String(envelope.reference)),
      JSON.stringify(value),
    );
  } finally {
    store.close();
  }
});

test("an oversized restored error receipt keeps its typed outcome without a durable claim", () => {
  const store = new Store(":memory:");
  try {
    store.set<TurnEffect>("pi_operations", opId("write", {}), {
      status: "complete",
      result: { outcome: "not_executed", error: { code: "E".repeat(40000) } },
      turnId: "turn",
      tool: "write",
      args: {},
    });
    const outcome = recoverMessagesDetailed(
      store,
      "turn",
      [response("", [{ type: "toolCall", id: "restored", name: "write", arguments: {} }])],
      opId,
      { maxBytes: RECOVERY_RESULT_MAX_BYTES },
    );
    const recovered = outcome.messages.find((message) => message.role === "toolResult");
    assert.ok(recovered);
    assert.ok(bytes(recovered) <= RECOVERY_RESULT_MAX_BYTES);
    assert.equal(body(recovered).outcome, "not_executed");
    assert.equal(body(recovered).persisted, undefined, "persistence is never invented");
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 5. SessionService reduction retry: exact operation identity, durable first.
// ---------------------------------------------------------------------------

function writeTool(name: string, value: unknown, counter: { writes: number }): RuntimeTool {
  return {
    name,
    description: name,
    readOnly: false,
    parameters: { type: "object", properties: {} },
    execute: async () => {
      counter.writes++;
      return value;
    },
  };
}

test("the reduction retry restores a missing second result from its exact receipt", async () => {
  const store = new Store(":memory:");
  const counter = { writes: 0 };
  const large = { accepted: true, body: "x".repeat(100000) };
  const confirmed = { accepted: true, id: "committed-second-write" };
  let engineCalls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      engineCalls++;
      if (engineCalls === 1) {
        for (const name of ["large_write", "small_write"])
          await input.tools.find((tool) => tool.name === name)?.execute({}, input.actor);
        await input.onCheckpoint?.([
          { role: "user", content: input.prompt, timestamp: 1 },
          response("", [
            { type: "toolCall", name: "large_write", id: "large", arguments: {} },
            { type: "toolCall", name: "small_write", id: "small", arguments: {} },
          ]),
          result(JSON.stringify(large), { toolCallId: "large", toolName: "large_write" }),
        ]);
        throw new OperationError("context_budget", "reduce the durable context", "not_executed");
      }
      assert.equal(input.resume, true, "the retry resumes the repaired checkpoint");
      const recovered = input.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "small",
      );
      assert.ok(recovered?.role === "toolResult");
      assert.equal(recovered.isError, false, "a completed receipt is not an unexecuted call");
      assert.deepEqual(body(recovered), confirmed);
      return {
        text: "两次操作均已确认。",
        messages: input.messages,
        toolCalls: 2,
        writeCalls: 2,
        toolEvidence: { successful: 2, successfulWrites: 2, unknown: 0, notExecuted: 0 },
      };
    },
  };
  try {
    const sessions = new SessionService(store, engine, {
      tools: () => [
        writeTool("large_write", large, counter),
        writeTool("small_write", confirmed, counter),
      ],
    });
    const session = sessions.current("owner", "chat");
    await sessions.reply(
      { ownerId: "owner", chatId: "chat", sessionId: session.id, messageId: "request" },
      "记录两次操作",
    );
    assert.equal(engineCalls, 2);
    assert.equal(counter.writes, 2, "the retry never reissues a completed write");
  } finally {
    store.close();
  }
});

test("the reduction retry is refused when an effect of the turn is unconfirmed", async () => {
  const store = new Store(":memory:");
  const counter = { writes: 0 };
  let engineCalls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      engineCalls++;
      await input.tools.find((tool) => tool.name === "write")?.execute({}, input.actor);
      if (engineCalls > 1) throw new Error("the retry must not reach the engine");
      // Force the journal into the unconfirmed state a crash after the side
      // effect and before its receipt would leave behind: the turn id in the
      // effect is the real one, so a pending record blocks the whole turn.
      const [entry] = store.entries<TurnEffect>("pi_operations");
      assert.ok(entry);
      store.set<TurnEffect>("pi_operations", entry[0], { ...entry[1], status: "pending" });
      throw new OperationError("context_budget", "reduce the durable context", "not_executed");
    },
  };
  try {
    const sessions = new SessionService(store, engine, {
      tools: () => [writeTool("write", { accepted: true }, counter)],
    });
    const session = sessions.current("owner", "chat");
    await assert.rejects(
      sessions.reply(
        { ownerId: "owner", chatId: "chat", sessionId: session.id, messageId: "request" },
        "记录",
      ),
      { code: "operation_unconfirmed" },
    );
    assert.equal(engineCalls, 1, "an unconfirmed turn is never retried for the model");
    assert.equal(counter.writes, 1);
  } finally {
    store.close();
  }
});

test("an unchanged context is never retried after a budget failure", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async () => {
      calls++;
      throw new OperationError("context_budget", "超限", "not_executed");
    },
  };
  try {
    const sessions = new SessionService(store, engine, {
      tools: () => [writeTool("write", { accepted: true }, { writes: 0 })],
    });
    const session = sessions.current("owner", "chat");
    await assert.rejects(
      sessions.reply(
        { ownerId: "owner", chatId: "chat", sessionId: session.id, messageId: "request" },
        "记录",
      ),
      { code: "context_budget" },
    );
    assert.equal(calls, 1, "a budget failure without a real reduction is not sent again");
  } finally {
    store.close();
  }
});
