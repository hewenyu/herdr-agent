import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import {
  createLeaderRuntime,
  type LeaderRuntime,
  runTaskLeader,
} from "../../src/orchestration/leader-session.js";
import {
  assertLeaderRecordVersion,
  LEADER_CHECKPOINTS,
  LEADER_EVENTS,
  LEADER_INBOX,
  LEADER_JOURNAL,
  LEADER_MESSAGES,
  LEADER_OPERATIONS,
  LEADER_RUNTIME_VERSION,
  LEADER_SESSIONS,
  type LeaderCheckpointRecord,
  type LeaderOperationRecord,
  type LeaderSessionRecord,
  leaderCheckpointId,
  leaderEventKey,
  leaderInboxId,
  leaderOperationId,
  leaderSessionId,
} from "../../src/orchestration/leader-session-types.js";
import type { EngineInput, EngineResult, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

/**
 * Strict durable record version/identity readers at the recovery boundaries.
 *
 * The reviewed defect: a record written by a future runtime (for example
 * `version: 999`) was accepted wherever `version` was never checked — the
 * existing-session path (which then reused it instead of recreating the
 * session), `readLeaderCheckpoint` and `leaderOperations`. The tests below run
 * the ACTUAL runtime recovery path: reject unsupported recovery state before
 * inference, and reject late unsupported receipts before their dependent write.
 * Supported versions still recover normally; original records are not rewritten.
 */

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "leader-versions-"));
  const store = new Store(join(directory, "state.sqlite"));
  return {
    directory,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function actor(taskId: string, ownerId = "owner"): ActorContext {
  return {
    source: "system",
    ownerId,
    chatId: `chat-${taskId}`,
    sessionId: `orchestration:${taskId}`,
    taskId,
    messageId: "event",
  };
}

/** Scripted engine: deterministic, records every request, never touches network. */
function engine(
  handler: (
    input: EngineInput,
    calls: number,
  ) => Promise<Partial<EngineResult>> | Partial<EngineResult>,
) {
  const calls: EngineInput[] = [];
  return {
    calls,
    contextTokens: 50000,
    async run(input: EngineInput): Promise<EngineResult> {
      calls.push(input);
      const partial = await handler(input, calls.length);
      return { text: partial.text ?? "", messages: partial.messages ?? [], ...partial };
    },
    async summarize() {
      return "summary";
    },
  };
}

function writeTool(name: string, execute: RuntimeTool["execute"]): RuntimeTool {
  return {
    name,
    description: `${name} write`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: false,
    execute,
  };
}

/** An activation that makes one durable write, checkpoints, then dies. */
async function interruptWithCheckpoint(
  runtime: LeaderRuntime,
  store: Store,
  taskId: string,
): Promise<void> {
  await assert.rejects(
    runtime.runTaskLeader({
      store,
      engine: engine(async (input) => {
        await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
        await input.onCheckpoint?.([
          { role: "user", content: input.prompt, timestamp: 1 },
        ] as never);
        throw new OperationError("model_failed", "连接中断。", "unknown");
      }),
      actor: actor(taskId),
      eventId: "evt-interrupted",
      revision: "rev",
      systemPrompt: "",
      prompt: "派发",
      tools: [writeTool("dispatch", async () => ({ outcome: "ok", dispatchId: "d-1" }))],
    }),
    { code: "model_failed" },
  );
}

test("a late unsupported write receipt refuses only the dependent operation without denying prior inference", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    const taskId = "late-receipt";
    const sessionId = leaderSessionId(taskId);
    const id = leaderOperationId(taskId, sessionId, "evt", "rev", "dispatch", {});
    const future = { version: 999, id, taskId, sessionId, state: "complete" };
    let writes = 0;
    const model = engine(async (input) => {
      h.store.set(LEADER_OPERATIONS, id, future);
      const tool = input.tools.find((entry) => entry.name === "dispatch");
      assert.ok(tool);
      await tool.execute({}, input.actor);
      return { text: "unreachable" };
    });
    await assert.rejects(
      runtime.runTaskLeader({
        store: h.store,
        engine: model,
        actor: actor(taskId),
        eventId: "evt",
        revision: "rev",
        systemPrompt: "",
        prompt: "派发",
        tools: [writeTool("dispatch", async () => ({ writes: ++writes }))],
      }),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, "leader_record_version_unsupported");
        assert.equal(error.outcome, "not_executed");
        assert.match(error.message, /本次读取/);
        assert.doesNotMatch(error.message, /本轮未调用模型|未执行任何动作/);
        return true;
      },
    );
    assert.equal(model.calls.length, 1, "the refusal can occur after inference has started");
    assert.equal(writes, 0, "the exact write callback was never entered");
    assert.deepEqual(h.store.get(LEADER_OPERATIONS, id), future);
  } finally {
    h.close();
  }
});

test("a supported version-1 session recovers normally through the real runtime path", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    const result = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "已完成本轮" })),
      actor: actor("t1"),
      eventId: "evt",
      revision: "rev",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    assert.equal(result.text, "已完成本轮");
    // Everything the runtime writes is interpretable by this same runtime.
    assert.equal(
      h.store.get<LeaderSessionRecord>(LEADER_SESSIONS, leaderSessionId("t1"))?.version,
      LEADER_RUNTIME_VERSION,
    );
    assert.equal(runtime.summary("t1").inbox.recorded, 1);
    assert.equal(runtime.session("t1")?.status, "idle");
  } finally {
    h.close();
  }
});

test("a supported version-1 checkpoint is still resumed from (the positive control)", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    await interruptWithCheckpoint(runtime, h.store, "t1");
    const checkpoint = h.store.list<LeaderCheckpointRecord>(LEADER_CHECKPOINTS);
    assert.equal(checkpoint.length, 1);
    assert.equal(checkpoint[0]?.version, LEADER_RUNTIME_VERSION);
    const resumed = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async (input) => {
        assert.equal(input.resume, true, "a version-1 checkpoint must still resume");
        return { text: "已恢复" };
      }),
      actor: actor("t1"),
      eventId: "evt-interrupted",
      revision: "rev",
      systemPrompt: "",
      prompt: "派发",
      tools: [],
    });
    assert.equal(resumed.text, "已恢复");
  } finally {
    h.close();
  }
});

test("an existing future-version session is refused before any engine call and is never recreated", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    const id = leaderSessionId("t1");
    const foreign: LeaderSessionRecord = {
      version: 999,
      id,
      taskId: "t1",
      ownerId: "owner",
      generation: 7,
      status: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    h.store.set(LEADER_SESSIONS, id, foreign);
    const before = structuredClone(h.store.get(LEADER_SESSIONS, id));
    const scripted = engine(async () => ({ text: "不应执行" }));
    await assert.rejects(
      runtime.runTaskLeader({
        store: h.store,
        engine: scripted,
        actor: actor("t1"),
        eventId: "evt",
        revision: "rev",
        systemPrompt: "",
        prompt: "推进",
        tools: [],
      }),
      (error: unknown) =>
        error instanceof OperationError && error.code === "leader_record_version_unsupported",
    );
    assert.equal(
      scripted.calls.length,
      0,
      "an uninterpretable session must refuse before inference",
    );
    // The future record is preserved verbatim; it is not downgraded and not
    // replaced by a fresh current-version session.
    assert.deepEqual(h.store.get(LEADER_SESSIONS, id), before);
    assert.equal(h.store.list(LEADER_INBOX).length, 0, "no inbox receipt may be created");
    assert.equal(h.store.list(LEADER_OPERATIONS).length, 0, "no write receipt may be created");
  } finally {
    h.close();
  }
});

test("a future-version checkpoint is refused before inference and left unmodified", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    await interruptWithCheckpoint(runtime, h.store, "t1");
    const id = leaderCheckpointId("t1", "evt-interrupted", "rev");
    const stored = h.store.get<LeaderCheckpointRecord>(LEADER_CHECKPOINTS, id);
    assert.ok(stored);
    h.store.set(LEADER_CHECKPOINTS, id, { ...stored, version: 999 });
    const before = structuredClone(h.store.get(LEADER_CHECKPOINTS, id));
    const journalBefore = h.store.list(LEADER_JOURNAL).length;
    const scripted = engine(async () => ({ text: "不应恢复" }));
    await assert.rejects(
      runtime.runTaskLeader({
        store: h.store,
        engine: scripted,
        actor: actor("t1"),
        eventId: "evt-interrupted",
        revision: "rev",
        systemPrompt: "",
        prompt: "派发",
        tools: [],
      }),
      (error: unknown) =>
        error instanceof OperationError && error.code === "leader_record_version_unsupported",
    );
    assert.equal(scripted.calls.length, 0, "recovery must refuse before the recovery inference");
    assert.deepEqual(h.store.get(LEADER_CHECKPOINTS, id), before);
    assert.equal(h.store.list(LEADER_JOURNAL).length, journalBefore, "no new journal entry");
  } finally {
    h.close();
  }
});

test("a future-version write receipt fails closed instead of being silently ignored or replayed", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "已建立会话" })),
      actor: actor("t1"),
      eventId: "evt-setup",
      revision: "rev",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    const session = h.store.get<LeaderSessionRecord>(LEADER_SESSIONS, leaderSessionId("t1"));
    assert.ok(session);
    // A durable write receipt recorded by a later runtime: this runtime cannot
    // know whether it committed, so it must block rather than decide it absent.
    const id = "lo_future_receipt";
    const future: LeaderOperationRecord = {
      version: 999,
      id,
      taskId: "t1",
      sessionId: session.id,
      ownerId: session.ownerId,
      tool: "dispatch",
      readOnly: false,
      args: "{}",
      argsCanonical: "{}",
      eventId: "evt-setup",
      revision: "rev",
      activationId: "la_future",
      state: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    h.store.set(LEADER_OPERATIONS, id, future);
    const before = structuredClone(h.store.get(LEADER_OPERATIONS, id));
    const unsupported = (error: unknown) =>
      error instanceof OperationError && error.code === "leader_record_version_unsupported";
    assert.throws(() => runtime.operations("t1"), unsupported);
    assert.throws(() => runtime.blockedWrites("t1"), unsupported);
    const scripted = engine(async () => ({ text: "不应执行" }));
    await assert.rejects(
      runtime.runTaskLeader({
        store: h.store,
        engine: scripted,
        actor: actor("t1"),
        eventId: "evt-later",
        revision: "rev",
        systemPrompt: "",
        prompt: "继续",
        tools: [],
      }),
      unsupported,
    );
    assert.equal(scripted.calls.length, 0, "an uninterpretable receipt blocks before inference");
    assert.deepEqual(h.store.get(LEADER_OPERATIONS, id), before);
  } finally {
    h.close();
  }
});

test("missing, malformed and future versions are all refused typed by the shared reader", () => {
  for (const version of [999, 2, 0, -1, "1", null, undefined, Number.NaN]) {
    assert.throws(
      () => assertLeaderRecordVersion({ version }, "记录", "ref"),
      (error: unknown) =>
        error instanceof OperationError && error.code === "leader_record_version_unsupported",
      `version ${String(version)} must be refused`,
    );
  }
  // A non-object record can never carry a version this runtime understands.
  for (const record of [undefined, null, 1, "v1", true, []]) {
    assert.throws(
      () => assertLeaderRecordVersion(record, "记录", "ref"),
      (error: unknown) =>
        error instanceof OperationError && error.code === "leader_record_version_unsupported",
    );
  }
  assert.doesNotThrow(() =>
    assertLeaderRecordVersion({ version: LEADER_RUNTIME_VERSION }, "记录", "r"),
  );
});

test("a future-version journal entry is refused by the journal reader", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "已记录" })),
      actor: actor("t1"),
      eventId: "evt",
      revision: "rev",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    const entries = h.store
      .entries<Record<string, unknown>>(LEADER_JOURNAL)
      .filter(([key]) => key.startsWith("t1:") && !key.endsWith(":sequence"));
    const [key, entry] = entries.at(-1) ?? [];
    assert.ok(key && entry, "a journal entry must exist for this task");
    h.store.set(LEADER_JOURNAL, key, { ...entry, version: 999 });
    assert.throws(
      () => runtime.journal("t1"),
      (error: unknown) =>
        error instanceof OperationError && error.code === "leader_record_version_unsupported",
    );
    // The original entry is left byte-for-byte as written.
    assert.equal(h.store.get<{ version: number }>(LEADER_JOURNAL, key)?.version, 999);
  } finally {
    h.close();
  }
});

test("a foreign-task future-version receipt never blocks an unrelated task", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "t1 ok" })),
      actor: actor("t1"),
      eventId: "evt",
      revision: "rev",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    // The future record is scoped to another task, so it is not this Leader's
    // state at all: the derived key and task filter still isolate it.
    h.store.set(LEADER_OPERATIONS, "lo_other", {
      version: 999,
      id: "lo_other",
      taskId: "t2",
      state: "pending",
    });
    assert.deepEqual(runtime.operations("t1"), []);
    const result = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "t1 继续" })),
      actor: actor("t1"),
      eventId: "evt-2",
      revision: "rev",
      systemPrompt: "",
      prompt: "继续",
      tools: [],
    });
    assert.equal(result.text, "t1 继续");
  } finally {
    h.close();
  }
});

test("a future-version durable message row is refused before it can enter a request", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "已记录" })),
      actor: actor("t1"),
      eventId: "evt",
      revision: "rev",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    const messages = h.store.list<{ id: string; taskId: string }>(LEADER_MESSAGES);
    const own = messages.find((message) => message.taskId === "t1");
    assert.ok(own, "the activation must have written a durable message row");
    const stored = h.store.get<Record<string, unknown>>(LEADER_MESSAGES, own.id);
    assert.ok(stored);
    h.store.set(LEADER_MESSAGES, own.id, { ...stored, version: 999 });
    const unsupported = (error: unknown) =>
      error instanceof OperationError && error.code === "leader_record_version_unsupported";
    assert.throws(() => runtime.messages("t1"), unsupported);
    assert.throws(() => runtime.summary("t1"), unsupported);
    const scripted = engine(async () => ({ text: "不应执行" }));
    await assert.rejects(
      runtime.runTaskLeader({
        store: h.store,
        engine: scripted,
        actor: actor("t1"),
        eventId: "evt-next",
        revision: "rev",
        systemPrompt: "",
        prompt: "继续",
        tools: [],
      }),
      unsupported,
    );
    assert.equal(scripted.calls.length, 0, "an uninterpretable history row blocks inference");
  } finally {
    h.close();
  }
});

test("runTaskLeader refuses a future-version session without recreating the derived record", async () => {
  const h = fixture();
  try {
    const id = leaderSessionId("t1");
    h.store.set(LEADER_SESSIONS, id, {
      version: 999,
      id,
      taskId: "t1",
      ownerId: "owner",
    });
    const before = structuredClone(h.store.get(LEADER_SESSIONS, id));
    await assert.rejects(
      runTaskLeader({
        store: h.store,
        engine: engine(async () => ({ text: "x" })),
        actor: actor("t1"),
        eventId: "evt",
        revision: "rev",
        systemPrompt: "",
        prompt: "推进",
        tools: [],
      }),
      (error: unknown) =>
        error instanceof OperationError && error.code === "leader_record_version_unsupported",
    );
    assert.deepEqual(h.store.get(LEADER_SESSIONS, id), before);
    assert.equal(h.store.get(LEADER_EVENTS, leaderEventKey("t1", "evt")), undefined);
    assert.equal(h.store.get(LEADER_INBOX, leaderInboxId("t1", "evt", "rev")), undefined);
  } finally {
    h.close();
  }
});
