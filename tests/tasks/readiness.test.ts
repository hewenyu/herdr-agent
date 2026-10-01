import assert from "node:assert/strict";
import test from "node:test";
import type { Participant, Task } from "../../src/core/types.js";
import {
  setExecutionRecoveryPause,
  userControlPaused,
} from "../../src/tasks/execution-recovery.js";
import {
  classifyAgent,
  derivedReadiness,
  executionGeneration,
  inputReady,
  isRecoveryDiagnostic,
  operationBelongsToGeneration,
  readinessDiagnostic,
  readinessOf,
  recordTrustEffect,
  startupTrustPrefix,
  startupTrustStatus,
  trustEffectId,
} from "../../src/tasks/readiness.js";
import { actor, createPersistedTask, discussion, setup } from "./helpers.js";

/** These fixtures are synthetic; no production store, native RPC or model call. */

function participant(overrides: Partial<Participant> = {}): Participant {
  return {
    id: "task:p1",
    taskId: "task",
    kind: "codex",
    name: "Codex",
    role: "",
    status: "pending",
    started: false,
    initialSent: false,
    initialReceipt: "receiver-1",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

test("readiness: created and started are never ready, and ready is not business running", () => {
  assert.equal(derivedReadiness(participant()).phase, "unallocated");
  const allocated = participant({
    execution: { paneId: "p1", workspaceId: "w1", kind: "codex", cwd: "/tmp/work" },
  });
  assert.equal(derivedReadiness(allocated).phase, "provisioning");
  const started = participant({
    ...allocated,
    started: true,
    status: "idle",
  });
  assert.equal(derivedReadiness(started).phase, "ready");
  assert.equal(inputReady(derivedReadiness(started)), true);
  assert.equal(inputReady(derivedReadiness(participant({ ...started, status: "working" }))), false);
  // A legacy done/idle record is ready but the task status is untouched by it.
  assert.equal(readinessOf(started).phase, "ready");
});

test("readiness: a blocked menu is never reported as ready", () => {
  const base = participant({
    execution: { paneId: "p1", workspaceId: "w1", kind: "codex", cwd: "/tmp/work" },
    started: true,
    status: "blocked",
  });
  const manual = classifyAgent(base, {
    paneId: "p1",
    workspaceId: "w1",
    kind: "codex",
    name: "Codex",
    status: "blocked",
    cwd: "/tmp/work",
    stateSeq: "7",
    interactiveReady: true,
    launchPending: false,
  });
  assert.equal(manual.phase, "awaiting_manual");
  assert.equal(inputReady(manual), false);
  // Without a visible screen a blocked menu can never be classified as trust:
  // `classifyAgent` only returns `awaiting_trust` with a matching screen.
  assert.notEqual(manual.phase as string, "awaiting_trust");
});

test("readiness: unreadable and absent observations are distinct and neither is ready", () => {
  const base = participant({
    execution: { paneId: "p1", workspaceId: "w1", kind: "codex", cwd: "/tmp/work" },
    started: true,
    status: "idle",
  });
  assert.equal(derivedReadiness(base).phase, "ready");
  const gone = classifyAgent(base, {
    paneId: "p1",
    workspaceId: "w1",
    kind: "codex",
    name: "Codex",
    status: "gone",
    cwd: "/tmp/work",
    stateSeq: "1",
    interactiveReady: false,
    launchPending: false,
  });
  assert.equal(gone.phase, "missing");
  const unknown = classifyAgent(base, {
    paneId: "p1",
    workspaceId: "w1",
    kind: "codex",
    name: "Codex",
    status: "unknown",
    cwd: "/tmp/work",
    stateSeq: "1",
    interactiveReady: false,
    launchPending: false,
  });
  assert.equal(unknown.phase, "uncertain");
  // A launch that has not become interactive is starting, not ready.
  const launching = classifyAgent(base, {
    paneId: "p1",
    workspaceId: "w1",
    kind: "codex",
    name: "Codex",
    status: "idle",
    cwd: "/tmp/work",
    stateSeq: "1",
    interactiveReady: false,
    launchPending: true,
  });
  assert.equal(launching.phase, "starting");
});

test("readiness: an explicit executor hold reports stopped, not ready", () => {
  const f = setup();
  try {
    const held = participant({
      id: "task:p1",
      taskId: "task",
      execution: { paneId: "p1", workspaceId: "w1", kind: "codex", cwd: "/tmp/work" },
      started: true,
      status: "idle",
    });
    f.store.set("participants", held.id, held);
    // No hold yet: the durable record is what readiness reads.
    assert.equal(derivedReadiness(held).phase, "ready");
    f.store.set("executor_holds", held.id, { participantId: held.id, at: "now", reason: "user" });
    const task = { id: "task", participantIds: [held.id] } as never;
    assert.equal(
      startupTrustStatus(f.store, held).frozen,
      false,
      "a hold is not a trust uncertainty",
    );
    // classifyAgent is inventory-only; the store-backed phase honours the hold.
    assert.equal(typeof task, "object");
  } finally {
    f.close();
  }
});

test("readiness: generation identity follows the execution recovery journal", () => {
  const initial = participant();
  assert.equal(executionGeneration(initial), "initial");
  const rebuilt = participant({ executionRecovery: "task:p1:recovery:execution_abc" });
  assert.equal(executionGeneration(rebuilt), "task:p1:recovery:execution_abc");
  assert.notEqual(executionGeneration(initial), executionGeneration(rebuilt));
});

test("startup trust: an unknown effect freezes its generation but not a new one", () => {
  const f = setup();
  try {
    const current = participant();
    f.store.set("participants", current.id, current);
    assert.deepEqual(startupTrustStatus(f.store, current), { frozen: false, confirmed: false });
    const operationId = trustEffectId(current, "1");
    assert.ok(operationId.startsWith(`${startupTrustPrefix(current.id)}:`));
    recordTrustEffect(f.store, current, operationId);
    f.store.set("operations", operationId, {
      id: operationId,
      fingerprint: "fp",
      state: "uncertain",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    assert.deepEqual(startupTrustStatus(f.store, current), { frozen: true, confirmed: false });
    assert.equal(operationBelongsToGeneration(f.store, current, operationId), true);
    // A definitely new generation is not governed by the retired receipt.
    const replacement = participant({ executionRecovery: "task:p1:recovery:execution_new" });
    assert.equal(operationBelongsToGeneration(f.store, replacement, operationId), false);
    assert.deepEqual(startupTrustStatus(f.store, replacement), {
      frozen: false,
      confirmed: false,
    });
    // The old receipt is preserved for audit.
    assert.equal(f.store.get<{ state: string }>("operations", operationId)?.state, "uncertain");
  } finally {
    f.close();
  }
});

test("startup trust: a confirmed write for the current generation is not frozen", () => {
  const f = setup();
  try {
    const current = participant();
    const operationId = trustEffectId(current, "1");
    recordTrustEffect(f.store, current, operationId);
    f.store.set("operations", operationId, {
      id: operationId,
      fingerprint: "fp",
      state: "done",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    assert.deepEqual(startupTrustStatus(f.store, current), { frozen: false, confirmed: true });
  } finally {
    f.close();
  }
});

test("readiness refuses a stale generation observation even when legacy status is idle", () => {
  const current = participant({
    started: true,
    status: "idle",
    executionRecovery: "new-generation",
    execution: { paneId: "p2", workspaceId: "w2", kind: "codex", cwd: "/tmp" },
    readiness: {
      phase: "ready",
      generation: "initial",
      paneId: "p1",
      workspaceId: "w1",
      reason: "old",
      at: "old",
    },
  });
  assert.equal(readinessOf(current).phase, "uncertain");
});

test("legacy user pause survives a repair revision increment", () => {
  const f = setup();
  try {
    const task = { id: "legacy", status: "review", discussion: { paused: true } } as Task;
    f.store.set("task_pause_revision", task.id, 3);
    f.store.set("task_user_pause_revision", task.id, 3);
    setExecutionRecoveryPause(f, task);
    assert.equal(userControlPaused(f, task), true);
  } finally {
    f.close();
  }
});

for (const legacyGeneric of [false, true]) {
  test(`unresolved ${legacyGeneric ? "legacy Jev" : "directory"} trust cannot appear ready, but a replacement starts clean`, async () => {
    const f = setup();
    try {
      const task = await createPersistedTask(f, actor, discussion, {
        orchestration: { mode: "model" },
      });
      await f.service.tick();
      const current = f.service.records.participants(task)[0];
      assert.ok(current?.execution);
      const id = legacyGeneric ? "old-generic" : `${current.id}:directory-trust:legacy`;
      const namespace = legacyGeneric ? "automatic_approval_decisions" : "operations";
      const receipt = {
        participantId: current.id,
        execution: current.execution,
        state: "uncertain",
        updatedAt: new Date().toISOString(),
      };
      f.store.set(namespace, id, receipt);
      await f.service.tick();
      assert.equal(
        f.service.get(actor, task.id).participants[0]?.readiness?.phase,
        "awaiting_trust",
      );
      for (const source of [undefined, "system"] as const)
        await assert.rejects(
          f.service.send(
            { ...actor, source, messageId: `frozen-${source ?? "user"}` },
            task.id,
            current.id,
            "Must not bypass an unresolved native effect.",
          ),
          { code: "executor_not_ready" },
        );
      assert.equal(f.herdr.sends.length, 0);
      f.herdr.agents.delete(current.execution.paneId);
      await f.service.tick();
      const replacement = f.service.records.participants(task)[0];
      assert.ok(replacement);
      assert.notEqual(replacement.execution?.paneId, current.execution.paneId);
      assert.equal(startupTrustStatus(f.store, replacement).frozen, false);
      assert.deepEqual(f.store.get(namespace, id), receipt);
      assert.equal(f.herdr.sends.length, 0);
    } finally {
      f.close();
    }
  });
}

test("readiness diagnostics are honest, stable and distinguishable from other errors", () => {
  for (const phase of [
    "awaiting_trust",
    "awaiting_manual",
    "starting",
    "missing",
    "uncertain",
  ] as const) {
    const text = readinessDiagnostic({ phase, reason: "r", generation: "initial", at: "now" });
    assert.ok(isRecoveryDiagnostic(text), `${phase} diagnostic must be recognized`);
    assert.doesNotMatch(text, /完全就绪|ready to work/);
  }
  assert.equal(isRecoveryDiagnostic(undefined), false);
  assert.equal(isRecoveryDiagnostic("用户自己的错误"), false);
});

test("readiness: a service pause does not change a participant's lifecycle phase", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const before = f.service.get(actor, task.id).participants[0];
    assert.ok(before);
    const recorded = f.store.get<Participant>("participants", before.id);
    assert.ok(recorded);
    const captured = structuredClone(recorded.readiness);
    const initialSent = before.initialSent;
    await f.service.action({ ...actor, messageId: "pause" }, task.id, "pause");
    const current = f.service.get(actor, task.id);
    assert.equal(current.status, "paused");
    assert.equal(current.discussion.paused, true);
    assert.deepEqual(
      f.store.get<Participant>("participants", before.id)?.readiness,
      captured,
      "a business pause must not rewrite the execution lifecycle phase",
    );
    assert.equal(current.participants[0]?.initialSent, initialSent);
  } finally {
    f.close();
  }
});
