import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import { recoverMessagesDetailed, type TurnEffect } from "../../src/runtime/recovery.js";
import { canonical, key, restoreDeferredRequests } from "../../src/runtime/session-records.js";
import { SessionService } from "../../src/runtime/sessions.js";
import type { ConversationEngine, EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

/**
 * Regression for the runtime effect journal shape hole.
 *
 * `pi_operations` is the replay-authorization boundary: a row for the computed
 * operation identity either confirms the effect (`complete`), keeps it
 * unconfirmed (`pending`), proves it never happened (`not_executed`), or does
 * not exist. A *malformed* existing row is none of those. It is not absence, so
 * it must never authorize a repeated invocation, be folded into a fabricated
 * `not_executed` marker, or be dropped while a barrier is computed. These tests
 * pin the fail-closed shape validation on the real public paths.
 */

const OWNER = "owner";
const CHAT = "chat";
const MESSAGE = "m1";

/** Every value here is an existing row that is NOT a valid absent receipt. */
const malformedRows: Array<{ name: string; row: unknown }> = [
  { name: "null", row: null },
  { name: "false", row: false },
  { name: "zero", row: 0 },
  { name: "empty string", row: "" },
  { name: "array", row: [] },
  { name: "object without status", row: {} },
  { name: "non-string status", row: { status: 7 } },
  { name: "boolean status", row: { status: true } },
  { name: "unknown status token", row: { status: "unknown" } },
  { name: "foreign status token", row: { status: "done" } },
  { name: "metadata-bearing unknown status", row: { status: "unknown", tool: "write", args: {} } },
];

function unknownRefusal(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof OperationError, `expected OperationError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.outcome, "unknown");
    return true;
  };
}

function actorFor(sessionId: string, messageId = MESSAGE): ActorContext {
  return { ownerId: OWNER, chatId: CHAT, sessionId, messageId };
}

/** The exact durable identity `SessionService.wrapTool` computes for generation 0. */
function operationId(sessionId: string, messageId: string, args: Record<string, unknown> = {}) {
  return key(OWNER, sessionId, "0", messageId, "write", canonical(args));
}

function writeTool(run: () => void, result: unknown = { accepted: true }): RuntimeTool {
  return {
    name: "write",
    description: "durable write",
    parameters: { type: "object", properties: {} },
    readOnly: false,
    execute: async () => {
      run();
      return result;
    },
  };
}

/**
 * Fake engine that runs the wrapped tool exactly like a real provider would.
 * `plant` receives the computed operation identity so a corrupt row can be
 * written to the durable store at the exact key `wrapTool` will read.
 */
function toolCallingEngine(
  plant: (operationId: string, input: EngineInput) => void,
  seen?: (result: unknown) => void,
): ConversationEngine {
  return {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      const tool = input.tools.find((entry) => entry.name === "write");
      assert.ok(tool, "the wrapped write tool must reach the engine");
      plant(operationId(input.actor.sessionId, input.actor.messageId), input);
      // Evaluate the call unconditionally: `seen?.(await ...)` would skip the
      // tool entirely when no observer is supplied.
      const result = await tool.execute({}, input.actor);
      seen?.(result);
      return { text: "已记录", messages: input.messages, toolCalls: 1 };
    },
  };
}

// ---------------------------------------------------------------------------
// 1. SessionService.wrapTool: a malformed existing receipt is a barrier.
// ---------------------------------------------------------------------------

for (const { name, row } of malformedRows)
  test(`a malformed (${name}) existing receipt never authorizes the same write again`, async () => {
    const store = new Store(":memory:");
    let executions = 0;
    try {
      const engine = toolCallingEngine((id) => {
        store.set("pi_operations", id, row);
      });
      const sessions = new SessionService(store, engine, {
        tools: () => [writeTool(() => executions++)],
      });
      const session = sessions.current(OWNER, CHAT);
      await assert.rejects(
        sessions.reply(actorFor(session.id), "创建"),
        unknownRefusal("state_invalid"),
      );
      assert.equal(executions, 0, "the side effect must not run");
      const id = operationId(session.id, MESSAGE);
      assert.deepEqual(
        store.entries("pi_operations"),
        [[id, row]],
        "the corrupt row stays untouched and no replacement receipt is written",
      );
    } finally {
      store.close();
    }
  });

test("valid legacy receipts keep their exact semantics: complete caches, pending blocks, not_executed runs", async () => {
  const scenarios: Array<{ name: string; row: unknown; executes: number; rejects?: string }> = [
    {
      name: "complete result is cached",
      row: { status: "complete", result: { cached: true } },
      executes: 0,
    },
    {
      name: "valid pending blocks",
      row: { status: "pending" },
      executes: 0,
      rejects: "operation_unconfirmed",
    },
    { name: "not_executed may run", row: { status: "not_executed" }, executes: 1 },
  ];
  for (const scenario of scenarios) {
    const store = new Store(":memory:");
    let executions = 0;
    let received: unknown;
    try {
      const engine = toolCallingEngine(
        (id) => {
          store.set("pi_operations", id, scenario.row);
        },
        (result) => {
          received = result;
        },
      );
      const sessions = new SessionService(store, engine, {
        tools: () => [writeTool(() => executions++)],
      });
      const session = sessions.current(OWNER, CHAT);
      const reply = sessions.reply(actorFor(session.id), "创建");
      if (scenario.rejects) await assert.rejects(reply, unknownRefusal(scenario.rejects));
      else await reply;
      assert.equal(executions, scenario.executes, scenario.name);
      if (scenario.name === "complete result is cached")
        assert.deepEqual(
          received,
          { cached: true },
          "the confirmed result is returned, not re-run",
        );
    } finally {
      store.close();
    }
  }
});

test("a missing receipt is the only absence that authorizes invocation, under the canonical identity", async () => {
  const store = new Store(":memory:");
  let executions = 0;
  try {
    const engine = toolCallingEngine(() => {});
    const sessions = new SessionService(store, engine, {
      tools: () => [writeTool(() => executions++)],
    });
    const session = sessions.current(OWNER, CHAT);
    const reply = await sessions.reply(actorFor(session.id), "创建");
    assert.equal(reply.text, "已记录");
    assert.equal(executions, 1);
    const id = operationId(session.id, MESSAGE);
    assert.deepEqual(
      store.entries("pi_operations").map(([entry]) => entry),
      [id],
    );
    const receipt = store.get<TurnEffect>("pi_operations", id);
    assert.equal(receipt?.status, "complete");
    assert.deepEqual(receipt?.result, { accepted: true });
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 2. recoverMessagesDetailed / assertNoUnconfirmed: malformed rows are unknown.
// ---------------------------------------------------------------------------

for (const { name, row } of malformedRows)
  test(`recovery refuses a malformed (${name}) journal row instead of inferring a result`, () => {
    const store = new Store(":memory:");
    try {
      store.set("pi_operations", "orphan", row);
      assert.throws(
        () => recoverMessagesDetailed(store, "turn", [], () => "op", { maxBytes: 16384 }),
        unknownRefusal("state_invalid"),
      );
      assert.deepEqual(store.entries("pi_operations"), [["orphan", row]]);
    } finally {
      store.close();
    }
  });

test("a malformed row carrying this turn's metadata is never rewritten as not_executed", () => {
  const store = new Store(":memory:");
  const row = { status: "unknown", turnId: "turn", tool: "write", args: {} };
  try {
    store.set("pi_operations", "op", row);
    assert.throws(
      () => recoverMessagesDetailed(store, "turn", [], () => "op", { maxBytes: 16384 }),
      unknownRefusal("state_invalid"),
    );
    assert.deepEqual(store.entries("pi_operations"), [["op", row]]);
  } finally {
    store.close();
  }
});

test("valid recovery distinctions survive: missing becomes not_executed, complete is restored, unknown result blocks", () => {
  const store = new Store(":memory:");
  try {
    const call = {
      role: "assistant" as const,
      api: "openai-responses",
      provider: "myrix",
      model: "test",
      content: [{ type: "toolCall" as const, id: "call", name: "write", arguments: {} }],
      stopReason: "toolUse" as const,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 1,
    };
    const missing = recoverMessagesDetailed(store, "turn", [call], () => "absent", {
      maxBytes: 16384,
    });
    assert.equal(missing.restored.completed, 0);
    assert.equal(missing.restored.total, 1);

    store.set<TurnEffect>("pi_operations", "done", {
      status: "complete",
      result: { accepted: true },
      turnId: "turn",
      tool: "write",
      args: {},
    });
    const restored = recoverMessagesDetailed(store, "turn", [call], () => "done", {
      maxBytes: 16384,
    });
    assert.equal(restored.restored.completed, 1);

    // A complete receipt with no recorded tool metadata is legacy, not corrupt.
    store.set<TurnEffect>("pi_operations", "legacy", { status: "complete", result: null });
    assert.equal(
      recoverMessagesDetailed(store, "turn", [call], () => "legacy", { maxBytes: 16384 }).restored
        .completed,
      1,
    );

    store.delete("pi_operations", "done");
    store.set<TurnEffect>("pi_operations", "unknown", {
      status: "complete",
      result: { outcome: "unknown" },
      turnId: "turn",
      tool: "write",
      args: {},
    });
    assert.throws(
      () => recoverMessagesDetailed(store, "turn", [call], () => "unknown", { maxBytes: 16384 }),
      unknownRefusal("operation_unconfirmed"),
    );
  } finally {
    store.close();
  }
});

test("a public recovery continuation refuses a corrupt journal row without resuming the turn", async () => {
  const store = new Store(":memory:");
  let resumes = 0;
  try {
    const interrupted: ConversationEngine = {
      contextTokens: 50000,
      summarize: async () => "",
      run: async (input) => {
        const id = operationId(input.actor.sessionId, input.actor.messageId);
        await input.onCheckpoint?.([
          { role: "user", content: input.prompt, timestamp: 1 },
          {
            role: "assistant",
            api: "openai-responses",
            provider: "myrix",
            model: "test",
            content: [{ type: "toolCall", id: "call", name: "write", arguments: {} }],
            stopReason: "toolUse",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: 1,
          },
        ]);
        store.set("pi_operations", id, { status: "unknown", turnId: id, tool: "write", args: {} });
        throw new OperationError("model_failed", "interrupted", "unknown");
      },
    };
    const sessions = new SessionService(store, interrupted, { tools: () => [writeTool(() => {})] });
    const session = sessions.current(OWNER, CHAT);
    const actor = actorFor(session.id);
    await assert.rejects(sessions.reply(actor, "创建"), unknownRefusal("model_failed"));

    const resumed: ConversationEngine = {
      contextTokens: 50000,
      summarize: async () => "",
      run: async (input) => {
        resumes++;
        return { text: "已恢复", messages: input.messages };
      },
    };
    const restarted = new SessionService(store, resumed, { tools: () => [writeTool(() => {})] });
    await assert.rejects(restarted.reply(actor, "创建"), unknownRefusal("turn_unconfirmed"));
    assert.equal(resumes, 0, "a corrupt journal row must not resume the turn");
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 3. restoreDeferredRequests: never reinterpret, never drop the barrier.
// ---------------------------------------------------------------------------

test("restoreDeferredRequests fails closed on a malformed scan row without writing any request", () => {
  const store = new Store(":memory:");
  const actor = actorFor("session");
  const row = {
    status: null,
    turnId: "turn",
    tool: "session_clear",
    args: {},
    deferredReset: { generation: 0, messageId: MESSAGE, mode: "clear", chatId: CHAT },
    deferredArchive: { generation: 0, messageId: MESSAGE },
  };
  const earlierValidIntent = {
    ...row,
    status: "complete",
  };
  try {
    store.set("pi_operations", "aaa-valid-intent", earlierValidIntent);
    store.set("pi_operations", "malformed-deferred", row);
    assert.throws(
      () => restoreDeferredRequests(store, actor, 0, "turn"),
      unknownRefusal("state_invalid"),
    );
    assert.deepEqual(store.list("session_reset_requests"), []);
    assert.deepEqual(store.list("session_archive_requests"), []);
    assert.deepEqual(store.entries("pi_operations"), [
      ["aaa-valid-intent", earlierValidIntent],
      ["malformed-deferred", row],
    ]);
  } finally {
    store.close();
  }
});

test("restoreDeferredRequests still restores valid legacy complete intent and ignores other turns", () => {
  const store = new Store(":memory:");
  const actor = actorFor("session");
  try {
    store.set("pi_operations", "legacy", {
      status: "complete",
      turnId: "turn",
      deferredReset: { generation: 0, messageId: MESSAGE, mode: "clear", chatId: CHAT },
      deferredArchive: { generation: 0, messageId: MESSAGE },
    });
    store.set("pi_operations", "other-turn", {
      status: "complete",
      turnId: "another",
      deferredReset: { generation: 0, messageId: MESSAGE, mode: "clear", chatId: CHAT },
      deferredArchive: { generation: 0, messageId: MESSAGE },
    });
    restoreDeferredRequests(store, actor, 0, "turn");
    assert.deepEqual(store.list("session_reset_requests"), [
      { generation: 0, messageId: MESSAGE, mode: "clear", chatId: CHAT },
    ]);
    assert.deepEqual(store.list("session_archive_requests"), [
      { generation: 0, messageId: MESSAGE },
    ]);
  } finally {
    store.close();
  }
});
