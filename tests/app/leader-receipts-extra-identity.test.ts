import assert from "node:assert/strict";
import test from "node:test";
import { reconcileLeaderReceipts } from "../../src/app/leader-receipts.js";
import { leaderSessionId } from "../../src/orchestration/leader-session-types.js";
import {
  harness,
  journalKinds,
  leaderOperation,
  nativeRow,
  OWNER,
  runNativeSend,
  seedOperation,
  seedParticipant,
  seedRawSession,
  seedSession,
  seedTask,
} from "./leader-receipts-helpers.js";

/**
 * Identity is closed by default. A receipt may only ever be judged against a
 * session record that proves `task-leader:<taskId>` for exactly this task with a
 * non-empty owner, and against a task record owned by that same owner. Every
 * malformed or foreign shape below must stay blocked; none of them may be
 * reconciled by falling back to an empty owner or to the receipt's own fields.
 */

/** A confirmed native send plus one pending Leader receipt for it. */
async function confirmedSendFixture(taskId: string) {
  const h = harness();
  seedSession(h.store, taskId);
  seedParticipant(h.store, taskId, `${taskId}:p1`);
  const spec = { taskId, participantId: `${taskId}:p1`, text: "请按当前授权继续。" };
  const nativeId = await runNativeSend(h, spec);
  const operation = seedOperation(h.store, {
    taskId,
    tool: "participant_send",
    args: { participantId: spec.participantId, text: spec.text },
    state: "pending",
  });
  return { h, nativeId, operation };
}

test("a missing task-leader session blocks every receipt instead of using an empty owner", async () => {
  const taskId = "task-no-session";
  const { h, nativeId, operation } = await confirmedSendFixture(taskId);
  try {
    seedRawSession(h.store, taskId, undefined);
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.equal(report.resolved.length, 0);
    assert.deepEqual(
      report.inspected.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.match(report.blocked[0]?.reason ?? "", /会话身份不成立/);
    // The proof itself is intact: the receipt stays pending only because the
    // session identity cannot be established.
    assert.equal(nativeRow(h.store, nativeId).state, "done");
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
    assert.equal(leaderOperation(h.store, taskId, operation.id).resolution, undefined);
    assert.equal(report.sessionId, leaderSessionId(taskId));
  } finally {
    h.store.close();
    h.close();
  }
});

test("an empty, malformed or foreign-owner session never authorizes reconciliation", async () => {
  const taskId = "task-bad-session";
  const { h, operation } = await confirmedSendFixture(taskId);
  try {
    const sessionKey = leaderSessionId(taskId);
    const valid = h.store.get<Record<string, unknown>>("leader_sessions", sessionKey);
    assert.ok(valid);
    const malformed: Array<[string, Record<string, unknown> | undefined]> = [
      ["empty owner", { ...valid, ownerId: "" }],
      ["blank owner", { ...valid, ownerId: "   " }],
      ["missing owner", { ...valid, ownerId: undefined }],
      ["non-string owner", { ...valid, ownerId: 7 }],
      ["foreign task", { ...valid, taskId: "other-task" }],
      ["missing task", { ...valid, taskId: undefined }],
      ["wrong stored id", { ...valid, id: "task-leader:other-task" }],
      ["missing stored id", { ...valid, id: undefined }],
      ["no session at all", undefined],
    ];
    for (const [name, record] of malformed) {
      seedRawSession(h.store, taskId, record);
      const report = reconcileLeaderReceipts(h.store, taskId);
      assert.equal(report.changed, false, `${name} must not reconcile`);
      assert.equal(report.resolved.length, 0, `${name} must resolve nothing`);
      assert.deepEqual(
        report.blocked.map((entry) => entry.operationId),
        [operation.id],
        `${name} must leave the receipt blocked`,
      );
      assert.equal(leaderOperation(h.store, taskId, operation.id).resolution, undefined, name);
      assert.equal(journalKinds(h.store, taskId).includes("recovery_receipt"), false, name);
    }
    // A valid session under a foreign key proves the derived key is the only one.
    seedRawSession(h.store, taskId, undefined);
    seedRawSession(h.store, taskId, valid, "task-leader:other-task");
    assert.equal(reconcileLeaderReceipts(h.store, taskId).changed, false);
    // With the exact session restored the same receipt resolves, so the negative
    // cases above cannot pass vacuously.
    seedRawSession(h.store, taskId, valid, "task-leader:other-task");
    seedRawSession(h.store, taskId, valid);
    const restored = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      restored.resolved.map((entry) => entry.resolution),
      ["treat_done"],
    );
  } finally {
    h.store.close();
    h.close();
  }
});

test("a foreign receipt owner or session is rejected even when the name matches the task", async () => {
  const taskId = "task-foreign-receipt";
  const { h, operation } = await confirmedSendFixture(taskId);
  try {
    // The session and owner are already valid; only the receipt identity varies.
    const valid = h.store.get<Record<string, unknown>>("leader_sessions", leaderSessionId(taskId));
    assert.ok(valid);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["empty owner", { ownerId: "" }],
      ["missing owner", { ownerId: undefined }],
      ["foreign owner", { ownerId: "someone-else" }],
      ["foreign session", { sessionId: "task-leader:other-task" }],
      ["missing session", { sessionId: "" }],
    ];
    for (const [name, patch] of cases) {
      h.store.set("leader_operations", operation.id, {
        ...leaderOperation(h.store, taskId, operation.id),
        ...patch,
      });
      const report = reconcileLeaderReceipts(h.store, taskId);
      assert.equal(report.changed, false, name);
      assert.deepEqual(
        report.blocked.map((entry) => entry.operationId),
        [operation.id],
        name,
      );
      assert.match(report.blocked[0]?.reason ?? "", /身份与当前任务不一致/, name);
      assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending", name);
    }
    // A receipt recorded for another task is not even part of this task's journal.
    h.store.set("leader_operations", operation.id, {
      ...leaderOperation(h.store, taskId, operation.id),
      taskId: "other-task",
    });
    const scoped = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(scoped.inspected.length, 0);
    assert.equal(scoped.changed, false);
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
    // Only the exact recorded identity resolves it, proving the checks above are
    // not vacuously blocking everything.
    h.store.set("leader_operations", operation.id, {
      ...leaderOperation(h.store, taskId, operation.id),
      ownerId: OWNER,
      sessionId: leaderSessionId(taskId),
      taskId,
    });
    const restored = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      restored.resolved.map((entry) => entry.resolution),
      ["treat_done"],
    );
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "complete");
  } finally {
    h.store.close();
    h.close();
  }
});

test("an empty or foreign task owner blocks resolution while the exact owner resolves it", async () => {
  const taskId = "task-owner-proof";
  const { h, operation } = await confirmedSendFixture(taskId);
  try {
    for (const [name, owner] of [
      ["empty", ""],
      ["blank", "  "],
      ["missing", undefined],
      ["foreign", "someone-else"],
    ] as const) {
      seedTask(h.store, taskId, { ownerId: owner, participantIds: [`${taskId}:p1`] });
      const report = reconcileLeaderReceipts(h.store, taskId);
      assert.equal(report.changed, false, name);
      assert.deepEqual(
        report.blocked.map((entry) => entry.operationId),
        [operation.id],
        name,
      );
      assert.equal(leaderOperation(h.store, taskId, operation.id).resolution, undefined, name);
    }
    // A missing task record must not authorize either.
    h.store.delete("tasks", taskId);
    assert.equal(reconcileLeaderReceipts(h.store, taskId).changed, false);
    // The exact owner does resolve, so the negative cases prove a real check.
    seedTask(h.store, taskId, { ownerId: OWNER, participantIds: [`${taskId}:p1`] });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "complete");
  } finally {
    h.store.close();
    h.close();
  }
});

test("a pending receipt is never resolved from its own invocation result", () => {
  const h = harness();
  try {
    const taskId = "task-self-proof";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    // A recorded pending write whose args claim success proves nothing: only an
    // authoritative native record can close it.
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: {
        participantId: `${taskId}:p1`,
        text: "自证请求。",
        status: "done",
        verified: true,
      },
      state: "pending",
    });
    h.store.set("leader_operations", operation.id, {
      ...leaderOperation(h.store, taskId, operation.id),
      result: { status: "delivered", verified: true, acked: true, attempts: 1 },
      invocationResult: { status: "delivered", verified: true, acked: true, attempts: 1 },
      error: { code: "anything", message: "self asserted", outcome: "not_executed" },
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
    assert.equal(journalKinds(h.store, taskId).includes("recovery_receipt"), false);
    assert.equal(h.store.get("operations", operation.id), undefined);
    assert.equal(h.store.get("input_deliveries", operation.id), undefined);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a resolution is journaled once and re-reading never re-resolves it", async () => {
  const taskId = "task-once";
  const { h, operation } = await confirmedSendFixture(taskId);
  try {
    const first = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(first.changed, true);
    assert.equal(
      journalKinds(h.store, taskId).filter((kind) => kind === "recovery_receipt").length,
      1,
    );
    const resolved = leaderOperation(h.store, taskId, operation.id);
    assert.equal(resolved.resolution?.decidedBy, "evidence");
    assert.equal(typeof resolved.resolution?.at, "string");
    assert.ok(resolved.resolution?.reason);
    for (const _ of [0, 1, 2]) {
      const again = reconcileLeaderReceipts(h.store, taskId);
      assert.equal(again.changed, false);
      assert.equal(again.inspected.length, 0);
      assert.equal(again.resolved.length, 0);
    }
    assert.equal(
      journalKinds(h.store, taskId).filter((kind) => kind === "recovery_receipt").length,
      1,
    );
  } finally {
    h.store.close();
    h.close();
  }
});
