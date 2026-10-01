import assert from "node:assert/strict";
import test from "node:test";
import { reconcileLeaderReceipts } from "../../src/app/leader-receipts.js";
import type { Task } from "../../src/core/types.js";
import { leaderRuntime } from "../../src/orchestration/leader-session.js";
import {
  LEADER_OPERATIONS,
  leaderSessionId,
} from "../../src/orchestration/leader-session-types.js";
import { Operations } from "../../src/storage/operations.js";
import { actor, discussion, setup } from "../tasks/helpers.js";
import {
  AT,
  EVENT,
  leaderOperation,
  nativeRow,
  OWNER,
  REVISION,
  runNativeSend as runNativeSendAgainst,
  seedDispatch as seedDispatchInto,
  seedInputDelivery as seedInputDeliveryInto,
  seedOperation as seedOperationInto,
  seedParticipant as seedParticipantInto,
  seedSession as seedSessionInto,
} from "./leader-receipts-helpers.js";

/**
 * `TaskService.reconcile` owns the task lock and the existing native/attention
 * flow. The Leader receipt hook runs synchronously inside that same locked
 * section, right after the task-existence/authorization guard and before any
 * native work, so a provable receipt is closed even while an attention event
 * blocks further activations. Closing a receipt is not business completion, and
 * the hook never calls a native tool or replays an effect.
 */

/** A task fixture whose owner is authorized and whose native work is inert. */
async function taskFixture() {
  const h = setup();
  const task = await h.service.create(actor, { ...discussion, createGroup: false });
  // The shared native-send double counts effects on a Harness-shaped object.
  const counter = { store: h.store, effects: 0, close: () => {} };
  return { ...h, task, counter };
}

test("TaskService.reconcile closes a provable Leader receipt before any native work", async () => {
  const h = await taskFixture();
  try {
    const taskId = h.task.id;
    seedSessionInto(h.store, taskId, h.task.ownerId);
    const participantId = `${taskId}:p1`;
    seedParticipantInto(h.store, taskId, participantId);
    const spec = { taskId, participantId, text: "请继续推进。" };
    const nativeId = await runNativeSendAgainst(h.counter, spec);
    const operation = seedOperationInto(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId, text: spec.text },
      state: "pending",
    });
    assert.equal(leaderRuntime(h.store).blockedWrites(taskId).length, 1);
    await h.service.reconcile(taskId);
    const closed = leaderOperation(h.store, taskId, operation.id);
    assert.equal(closed.state, "complete");
    assert.equal(closed.resolution?.choice, "treat_done");
    assert.equal(leaderRuntime(h.store).blockedWrites(taskId).length, 0);
    assert.equal(nativeRow(h.store, nativeId).state, "done");
    assert.equal(h.counter.effects, 1, "no second native effect");
  } finally {
    h.close();
  }
});

test("the hook runs before the early returns that attention and destroyed tasks take", async () => {
  const h = await taskFixture();
  try {
    const taskId = h.task.id;
    seedSessionInto(h.store, taskId, h.task.ownerId);
    const participantId = `${taskId}:p1`;
    seedParticipantInto(h.store, taskId, participantId);
    const spec = { taskId, participantId, text: "请继续推进。" };
    await runNativeSendAgainst(h.counter, spec);
    const operation = seedOperationInto(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId, text: spec.text },
      state: "pending",
    });
    // A pre-existing attention state must not stop the receipt reconciliation.
    const current = h.store.get<Task>("tasks", taskId);
    assert.ok(current);
    h.store.set("tasks", taskId, { ...current, status: "attention", error: "先前失败" });
    await h.service.reconcile(taskId);
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "complete");
    // A destroyed task still reconciles its own durable receipts.
    const second = seedOperationInto(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId, text: spec.text },
      state: "pending",
      id: "lo_destroyed_hook",
    });
    h.store.set("tasks", taskId, {
      ...(h.store.get<Task>("tasks", taskId) as Task),
      status: "destroyed",
      groupDeleted: true,
    });
    await h.service.reconcile(taskId);
    assert.equal(leaderOperation(h.store, taskId, second.id).state, "complete");
  } finally {
    h.close();
  }
});

test("an unauthorized or missing task never triggers receipt reconciliation", async () => {
  const h = await taskFixture();
  try {
    const taskId = h.task.id;
    seedSessionInto(h.store, taskId, h.task.ownerId);
    const participantId = `${taskId}:p1`;
    seedParticipantInto(h.store, taskId, participantId);
    const spec = { taskId, participantId, text: "请继续推进。" };
    await runNativeSendAgainst(h.counter, spec);
    const operation = seedOperationInto(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId, text: spec.text },
      state: "pending",
    });
    // Revoke the owner: the service guard must return before the hook.
    const current = h.store.get<Task>("tasks", taskId);
    assert.ok(current);
    h.store.set("tasks", taskId, { ...current, ownerId: "revoked-owner" });
    await h.service.reconcile(taskId);
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
    // A foreign owner inside the allowed list still gets no reconciliation for
    // this task's Leader journal, because the durable identity no longer matches.
    h.store.set("tasks", taskId, { ...current, ownerId: OWNER });
    h.store.set("leader_sessions", leaderSessionId(taskId), {
      ...(h.store.get<Record<string, unknown>>(
        "leader_sessions",
        leaderSessionId(taskId),
      ) as Record<string, unknown>),
      ownerId: "",
    });
    await h.service.reconcile(taskId);
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
    // A missing task record returns before any Leader state is touched.
    h.store.delete("tasks", taskId);
    await h.service.reconcile(taskId);
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
  } finally {
    h.close();
  }
});

test("the hook never replays, resends or creates a native operation of its own", async () => {
  const h = await taskFixture();
  try {
    const taskId = h.task.id;
    seedSessionInto(h.store, taskId, h.task.ownerId);
    const participantId = `${taskId}:p1`;
    seedParticipantInto(h.store, taskId, participantId);
    // A never-settled native send: the hook must leave it untouched and blocked.
    const spec = { taskId, participantId, text: "未确认的投递。" };
    const operationId = `${taskId}:send:${(await import("../../src/core/ids.js")).stableId(
      EVENT,
      participantId,
      spec.text,
    )}`;
    seedDispatchInto(h.store, taskId, operationId, participantId);
    seedInputDeliveryInto(h.store, spec, operationId);
    h.store.set("operations", operationId, {
      id: operationId,
      fingerprint: "unknown-fingerprint",
      state: "uncertain",
      error: { code: "delivery_unconfirmed", message: "未确认", outcome: "unknown" },
      updatedAt: AT,
    });
    const operation = seedOperationInto(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId, text: spec.text },
      state: "unknown",
    });
    await h.service.reconcile(taskId);
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "unknown");
    assert.equal(leaderOperation(h.store, taskId, operation.id).resolution, undefined);
    assert.equal(h.counter.effects, 0, "no native send may be attempted");
    assert.equal(h.store.get<{ state?: string }>("operations", operationId)?.state, "uncertain");
    const task = h.service.get(actor, taskId);
    assert.equal(task.completedAt, undefined);
    assert.notEqual(task.status, "completed");
  } finally {
    h.close();
  }
});

test("the hook is scoped to its own task and never touches another task's receipts", async () => {
  const h = await taskFixture();
  try {
    const first = h.task.id;
    const second = (
      await h.service.create(actor, { ...discussion, title: "第二个任务", createGroup: false })
    ).id;
    for (const taskId of [first, second]) {
      seedSessionInto(h.store, taskId, h.task.ownerId);
      seedParticipantInto(h.store, taskId, `${taskId}:p1`);
    }
    const spec = { taskId: second, participantId: `${second}:p1`, text: "第二个任务。" };
    await runNativeSendAgainst(h.counter, spec);
    const foreign = seedOperationInto(h.store, {
      taskId: second,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    await h.service.reconcile(first);
    assert.equal(leaderOperation(h.store, second, foreign.id).state, "pending");
    await h.service.reconcile(second);
    assert.equal(leaderOperation(h.store, second, foreign.id).state, "complete");
  } finally {
    h.close();
  }
});

test("reconciling twice is idempotent and never double-journals a receipt", async () => {
  const h = await taskFixture();
  try {
    const taskId = h.task.id;
    seedSessionInto(h.store, taskId, h.task.ownerId);
    const participantId = `${taskId}:p1`;
    seedParticipantInto(h.store, taskId, participantId);
    const spec = { taskId, participantId, text: "幂等检查。" };
    await runNativeSendAgainst(h.counter, spec);
    seedOperationInto(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId, text: spec.text },
      state: "pending",
    });
    await h.service.reconcile(taskId);
    const kinds = () =>
      h.store
        .entries<{ kind: string; taskId: string }>("leader_journal")
        .filter(([, entry]) => entry.taskId === taskId)
        .map(([, entry]) => entry.kind);
    const afterFirst = kinds().filter((kind) => kind === "recovery_receipt").length;
    assert.equal(afterFirst, 1);
    await h.service.reconcile(taskId);
    await h.service.reconcile(taskId, { forceRemote: false });
    assert.equal(kinds().filter((kind) => kind === "recovery_receipt").length, 1);
    assert.equal(h.counter.effects, 1, "no second native effect");
  } finally {
    h.close();
  }
});

test("a stale hook value is re-read by downstream code rather than treated as completion", async () => {
  const h = await taskFixture();
  try {
    const taskId = h.task.id;
    seedSessionInto(h.store, taskId, h.task.ownerId);
    const participantId = `${taskId}:p1`;
    seedParticipantInto(h.store, taskId, participantId);
    const spec = { taskId, participantId, text: "下游重读。" };
    const nativeId = await runNativeSendAgainst(h.counter, spec);
    const operation = seedOperationInto(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId, text: spec.text },
      state: "pending",
    });
    // The hook closes the receipt in place; the receiver must see the durable state.
    const before = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(before.changed, true);
    const after = h.store.get<{ state: string }>("leader_operations", operation.id);
    assert.equal(after?.state, "complete");
    assert.equal(nativeRow(h.store, nativeId).state, "done");
    // The task record is untouched: a closed write receipt is not an acceptance.
    const task = h.service.get(actor, taskId);
    assert.notEqual(task.status, "completed");
    assert.equal(task.completedAt, undefined);
    assert.equal(h.store.get("task_input_applied", nativeId), undefined);
    assert.equal(
      h.store.get("participant_awaiting_output", participantId),
      undefined,
      "a reconciled native send is never claimed as an applied input",
    );
  } finally {
    h.close();
  }
});

test("the hook closes an abandon receipt without enabling a replay", async () => {
  const h = await taskFixture();
  try {
    const taskId = h.task.id;
    seedSessionInto(h.store, taskId, h.task.ownerId);
    const participantId = `${taskId}:p1`;
    seedParticipantInto(h.store, taskId, participantId);
    const spec = { taskId, participantId, text: "已放弃的投递。" };
    const operationId = `${taskId}:send:${(await import("../../src/core/ids.js")).stableId(
      EVENT,
      participantId,
      spec.text,
    )}`;
    seedDispatchInto(h.store, taskId, operationId, participantId);
    seedInputDeliveryInto(h.store, spec, operationId);
    h.store.set("operations", operationId, {
      id: operationId,
      fingerprint: (await import("../../src/app/leader-receipts.js")).nativeSendFingerprint(
        participantId,
        spec.text,
      ),
      state: "uncertain",
      error: { code: "delivery_unconfirmed", message: "未确认", outcome: "unknown" },
      updatedAt: AT,
    });
    new Operations(h.store).resolve(operationId, {
      choice: "abandon",
      decidedBy: "evidence",
      reason: "现场证明未送达",
      at: AT,
    });
    const operation = seedOperationInto(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId, text: spec.text },
      state: "unknown",
    });
    await h.service.reconcile(taskId);
    const closed = leaderOperation(h.store, taskId, operation.id);
    assert.equal(closed.state, "not_executed");
    assert.equal(closed.resolution?.choice, "abandon");
    // The native row keeps its own explicit decision and is never rewritten.
    assert.equal(
      h.store.get<{ resolution?: { choice?: string } }>("operations", operationId)?.resolution
        ?.choice,
      "abandon",
    );
    assert.equal(h.store.get<{ state: string }>("operations", operationId)?.state, "uncertain");
    assert.equal(h.counter.effects, 0, "no native send may be attempted");
    assert.equal(
      h.store.get<{ resolution?: { decidedBy?: string } }>(LEADER_OPERATIONS, operation.id)
        ?.resolution?.decidedBy,
      "evidence",
    );
    assert.equal(REVISION.length > 0, true);
  } finally {
    h.close();
  }
});
