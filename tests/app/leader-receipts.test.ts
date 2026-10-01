import assert from "node:assert/strict";
import test from "node:test";
import { LEADER_DECISION_ACTION, reconcileLeaderReceipts } from "../../src/app/leader-receipts.js";
import { OperationError } from "../../src/core/errors.js";
import { stableId } from "../../src/core/ids.js";
import { leaderRuntime } from "../../src/orchestration/leader-session.js";
import {
  LEADER_OPERATIONS,
  leaderSessionId,
} from "../../src/orchestration/leader-session-types.js";
import { Operations } from "../../src/storage/operations.js";
import {
  AT,
  EVENT,
  harness,
  journalKinds,
  leaderOperation,
  nativeRow,
  OWNER,
  REVISION,
  reopen,
  runNativeSend,
  type SeedOperationInput,
  seedDispatch,
  seedInputDelivery,
  seedOperation,
  seedParticipant,
  seedSession,
  seedUnsettledNative,
  sendIds,
} from "./leader-receipts-helpers.js";

test("confirmed native send after crash/reopen unblocks the Leader without a second effect", async () => {
  const h = harness();
  try {
    const taskId = "task-confirmed";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "请实现 X 并给出证据。" };
    const nativeId = await runNativeSend(h, spec);
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    const before = structuredClone(nativeRow(h.store, nativeId));
    assert.equal(h.effects, 1);

    const store = reopen(h);
    const report = reconcileLeaderReceipts(store, taskId);

    assert.deepEqual(
      report.inspected.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.deepEqual(
      report.resolved.map((entry) => [entry.operationId, entry.resolution]),
      [[operation.id, "treat_done"]],
    );
    assert.equal(report.blocked.length, 0);
    assert.equal(report.changed, true);
    const resolved = leaderOperation(store, taskId, operation.id);
    assert.equal(resolved.state, "complete");
    assert.equal(resolved.resolution?.decidedBy, "evidence");
    assert.equal(resolved.resolution?.choice, "treat_done");
    assert.match(resolved.resolution?.reason ?? "", /原生操作回执/);
    assert.equal((resolved.result as { verified?: boolean }).verified, true);
    assert.equal((resolved.result as { status?: string }).status, "delivered");
    // The native record is untouched and nothing was sent a second time.
    assert.deepEqual(nativeRow(store, nativeId), before);
    assert.equal(h.effects, 1);
    assert.equal(leaderRuntime(store).blockedWrites(taskId).length, 0);
    // Idempotent: a second reconciliation has nothing left to resolve.
    const second = reconcileLeaderReceipts(store, taskId);
    assert.equal(second.changed, false);
    assert.equal(second.resolved.length, 0);
    assert.equal(second.inspected.length, 0);
    assert.equal(h.effects, 1);
    assert.equal(
      journalKinds(store, taskId).filter((kind) => kind === "recovery_receipt").length,
      1,
    );
  } finally {
    h.store.close();
    h.close();
  }
});

test("a never-settled or native-uncertain receipt stays blocked and never replays", async () => {
  const h = harness();
  try {
    for (const nativeState of ["pending", "uncertain"] as const) {
      const taskId = `task-${nativeState}`;
      seedSession(h.store, taskId);
      seedParticipant(h.store, taskId, `${taskId}:p1`);
      const spec = { taskId, participantId: `${taskId}:p1`, text: "执行本轮工作。" };
      const nativeId = seedUnsettledNative(h.store, spec, nativeState);
      const operation = seedOperation(h.store, {
        taskId,
        tool: "participant_send",
        args: { participantId: spec.participantId, text: spec.text },
        state: nativeState === "pending" ? "pending" : "unknown",
      });
      const report = reconcileLeaderReceipts(h.store, taskId);
      assert.equal(report.changed, false);
      assert.equal(report.resolved.length, 0);
      assert.deepEqual(
        report.blocked.map((entry) => entry.operationId),
        [operation.id],
      );
      assert.equal(leaderOperation(h.store, taskId, operation.id).state, operation.state);
      assert.equal(leaderOperation(h.store, taskId, operation.id).resolution, undefined);
      assert.equal(nativeRow(h.store, nativeId).state, nativeState);
      assert.equal(h.effects, 0);
    }
  } finally {
    h.store.close();
    h.close();
  }
});

test("generic and unknown tools stay blocked even with a settled native record", async () => {
  const h = harness();
  try {
    const taskId = "task-generic";
    seedSession(h.store, taskId);
    const unknownTool = seedOperation(h.store, {
      taskId,
      tool: "task_action",
      args: { action: "pause" },
      state: "pending",
    });
    // A settled native receipt under the journal key must still not be adopted.
    h.store.set("operations", unknownTool.id, {
      id: unknownTool.id,
      fingerprint: "whatever",
      state: "done",
      result: { accepted: true },
      updatedAt: AT,
    });
    const unknownGeneric = seedOperation(h.store, {
      taskId,
      tool: "some_custom_tool",
      args: { anything: true },
      state: "unknown",
    });
    h.store.set("operations", unknownGeneric.id, {
      id: unknownGeneric.id,
      fingerprint: "whatever",
      state: "done",
      result: { ok: true },
      updatedAt: AT,
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.deepEqual(
      report.blocked.map((entry) => entry.tool),
      ["task_action", "some_custom_tool"],
    );
    for (const entry of report.blocked) assert.match(entry.reason ?? "", /永不自动对账/);
    assert.equal(leaderOperation(h.store, taskId, unknownTool.id).state, "pending");
    assert.equal(leaderOperation(h.store, taskId, unknownGeneric.id).state, "unknown");
  } finally {
    h.store.close();
    h.close();
  }
});

test("mismatched owner, session, task, event, revision or args never resolve", async () => {
  const h = harness();
  try {
    const taskId = "task-mismatch";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "请复核这份计划。" };
    const nativeId = await runNativeSend(h, spec);
    const good = { participantId: spec.participantId, text: spec.text };
    const cases: Array<[string, SeedOperationInput]> = [
      ["owner", { taskId, tool: "participant_send", args: good, ownerId: "someone-else" }],
      ["session", { taskId, tool: "participant_send", args: good, sessionId: "task-leader:other" }],
      [
        "task",
        { taskId, tool: "participant_send", args: good, eventId: "orchestrate:other-event" },
      ],
      ["revision", { taskId, tool: "participant_send", args: good, revision: "rev-2" }],
      [
        "args",
        {
          taskId,
          tool: "participant_send",
          args: { participantId: spec.participantId, text: "请复核这份计划。 " },
        },
      ],
    ];
    const seeded = cases.map(([name, input]) => [name, seedOperation(h.store, input)] as const);
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.equal(report.resolved.length, 0);
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId).sort(),
      seeded.map(([, operation]) => operation.id).sort(),
    );
    for (const [, operation] of seeded)
      assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
    assert.equal(nativeRow(h.store, nativeId).state, "done");
    assert.equal(h.effects, 1);
    // Identity is re-derived from event + participant + exact text, so a journal
    // record carrying an event-scoped id still reconciles by the same proof.
    const scoped = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: good,
      state: "unknown",
      id: "lo_event_scoped_identity",
    });
    const scopedReport = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      scopedReport.resolved.map((entry) => [entry.operationId, entry.resolution]),
      [[scoped.id, "treat_done"]],
    );
    assert.equal(h.effects, 1);
  } finally {
    h.store.close();
    h.close();
  }
});

test("unreadable journal args, foreign task receipts and user dispositions are left alone", async () => {
  const h = harness();
  try {
    const taskId = "task-damaged";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "继续。" };
    await runNativeSend(h, spec);
    const damaged = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
    });
    h.store.set(LEADER_OPERATIONS, damaged.id, {
      ...leaderOperation(h.store, taskId, damaged.id),
      args: "{not json",
    });
    const foreign = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      resolution: { choice: "abandon", decidedBy: "user", reason: "用户已决定", at: AT },
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.equal(report.inspected.length, 1);
    assert.equal(report.inspected[0]?.operationId, damaged.id);
    assert.equal(leaderOperation(h.store, taskId, damaged.id).state, "pending");
    assert.deepEqual(leaderOperation(h.store, taskId, foreign.id).resolution, {
      choice: "abandon",
      decidedBy: "user",
      reason: "用户已决定",
      at: AT,
    });
    assert.equal(leaderOperation(h.store, taskId, foreign.id).state, "pending");
    assert.equal(h.effects, 1);
  } finally {
    h.store.close();
    h.close();
  }
});

test("read-only receipts never reconcile and never block", () => {
  const h = harness();
  try {
    const taskId = "task-readonly";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const read = seedOperation(h.store, {
      taskId,
      tool: "workflow_status",
      args: {},
      state: "pending",
      readOnly: true,
    });
    h.store.set("operations", read.id, {
      id: read.id,
      fingerprint: "x",
      state: "done",
      result: { ok: true },
      updatedAt: AT,
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.equal(report.inspected.length, 0);
    assert.equal(report.blocked.length, 0);
    assert.equal(leaderOperation(h.store, taskId, read.id).state, "pending");
  } finally {
    h.store.close();
    h.close();
  }
});

test("an explicit native treat_done resolution is adopted without fabricating a send result", () => {
  const h = harness();
  try {
    const taskId = "task-native-decision";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "请提交阶段结论。" };
    const nativeId = seedUnsettledNative(h.store, spec, "uncertain");
    const target = { status: "delivered", verified: true, acked: true, attempts: 1 };
    new Operations(h.store).resolve(nativeId, {
      choice: "treat_done",
      decidedBy: "user",
      reason: "用户确认现场已送达",
      at: AT,
      result: target,
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "unknown",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.resolution),
      ["treat_done"],
    );
    const resolved = leaderOperation(h.store, taskId, operation.id);
    assert.deepEqual(resolved.result, target);
    assert.equal(resolved.resolution?.decidedBy, "user");
    assert.deepEqual(nativeRow(h.store, nativeId).state, "uncertain");
    assert.equal(h.effects, 0);
  } finally {
    h.store.close();
    h.close();
  }
});

test("native abandon resolution and definite refusal close the journal as abandon", async () => {
  const h = harness();
  try {
    const taskId = "task-abandon";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const abandonedSpec = { taskId, participantId: `${taskId}:p1`, text: "旧请求。" };
    const abandonedId = seedUnsettledNative(h.store, abandonedSpec, "uncertain");
    new Operations(h.store).resolve(abandonedId, {
      choice: "abandon",
      decidedBy: "evidence",
      reason: "现场证明未送达",
      at: AT,
    });
    const abandoned = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: abandonedSpec.participantId, text: abandonedSpec.text },
      state: "unknown",
    });
    const failedSpec = { taskId, participantId: `${taskId}:p1`, text: "另一次请求。" };
    const failedId = sendIds(failedSpec).operationId;
    seedDispatch(h.store, taskId, failedId, failedSpec.participantId);
    seedInputDelivery(h.store, failedSpec, failedId);
    await assert.rejects(
      new Operations(h.store).run(failedId, sendIds(failedSpec).parameters, async () => {
        throw new OperationError("delivery_not_executed", "本次未发送。", "not_executed");
      }),
      { code: "delivery_not_executed" },
    );
    const failed = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: failedSpec.participantId, text: failedSpec.text },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => [entry.operationId, entry.resolution]).sort(),
      [
        [abandoned.id, "abandon"],
        [failed.id, "abandon"],
      ].sort(),
    );
    for (const operation of [abandoned, failed]) {
      const closed = leaderOperation(h.store, taskId, operation.id);
      assert.equal(closed.state, "not_executed");
      assert.equal(closed.resolution?.choice, "abandon");
      assert.equal(closed.error?.code, "operation_abandoned");
    }
    // The native refusal is unchanged and still refuses a replay.
    assert.equal(nativeRow(h.store, failedId).state, "failed");
    await assert.rejects(
      new Operations(h.store).run(failedId, sendIds(failedSpec).parameters, async () => {
        h.effects += 1;
        return { status: "delivered", acked: true, verified: true, attempts: 1 };
      }),
      { code: "delivery_not_executed" },
    );
    assert.equal(h.effects, 0);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a completed execution replacement proves the addressed send is moot", async () => {
  const h = harness();
  try {
    const taskId = "task-retired";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "旧现场输入。" };
    const nativeId = await runNativeSend(h, spec);
    h.store.set("task_restarts", "restart-1", {
      id: "restart-1",
      taskId,
      state: "done",
      operationIds: [nativeId],
      participants: [],
      replacements: {},
      eventIds: [],
      materialPath: "",
      at: AT,
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.resolution),
      ["abandon"],
    );
    const resolved = leaderOperation(h.store, taskId, operation.id);
    assert.equal(resolved.state, "not_executed");
    assert.match(resolved.resolution?.reason ?? "", /重启替换/);
    assert.equal(nativeRow(h.store, nativeId).state, "done");
    assert.equal(h.effects, 1);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a persisted orchestration decision closes only its own receipt", () => {
  const h = harness();
  try {
    const taskId = "task-decision";
    seedSession(h.store, taskId);
    const event = {
      id: EVENT,
      taskId,
      trigger: "ready",
      outputIds: [],
      userRevision: REVISION,
      state: "done",
      attempts: 1,
      dispatches: [],
      decision: { action: "wait", reason: "缺少用户必需信息" },
      createdAt: AT,
      updatedAt: AT,
    };
    h.store.set("task_orchestration_events", EVENT, event);
    assert.equal(h.store.get<{ ownerId?: string }>("tasks", taskId)?.ownerId, OWNER);
    const matched = seedOperation(h.store, {
      taskId,
      tool: LEADER_DECISION_ACTION,
      args: { action: "wait", reason: "缺少用户必需信息" },
      state: "pending",
    });
    const mismatched = seedOperation(h.store, {
      taskId,
      tool: LEADER_DECISION_ACTION,
      args: { action: "continue", reason: "缺少用户必需信息" },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.operationId),
      [matched.id],
    );
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [mismatched.id],
    );
    const resolved = leaderOperation(h.store, taskId, matched.id);
    assert.equal(resolved.state, "complete");
    assert.deepEqual(resolved.result, {
      action: "wait",
      reason: "缺少用户必需信息",
      recorded: true,
      note: "决定记录已持久化；本结果不代表参与者已收到输入、已开始执行或任务已完成。",
    });
    // The recorded decision itself is untouched: no dispatch, delivery or completion.
    assert.deepEqual(h.store.get("task_orchestration_events", EVENT), event);
    assert.equal(h.effects, 0);
  } finally {
    h.store.close();
    h.close();
  }
});

test("committed workflow action selection is not proof of dispatch or business completion", () => {
  const h = harness();
  try {
    const taskId = "task-selection";
    seedSession(h.store, taskId);
    const candidateId = "dispatch:node-1:codex";
    h.store.set("workflow_leader_actions", `wla_${taskId}`, {
      version: 1,
      id: `wla_${taskId}`,
      taskId,
      ownerId: OWNER,
      sessionId: leaderSessionId(taskId),
      eventId: EVENT,
      revision: REVISION,
      planVersion: 1,
      artifactRevision: "artifact-rev-1",
      state: "committed",
      request: { action: "dispatch", candidateId, reason: "节点已就绪" },
      candidate: { id: candidateId, kind: "dispatch", description: "派发" },
      createdAt: AT,
      updatedAt: AT,
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪" },
      state: "pending",
    });
    // Even a settled native record under this journal key proves nothing about delivery.
    h.store.set("operations", operation.id, {
      id: operation.id,
      fingerprint: "x",
      state: "done",
      result: { action: "dispatch", accepted: true },
      updatedAt: AT,
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.equal(report.resolved.length, 0);
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
    assert.equal(h.store.get("task_orchestration_events", EVENT), undefined);
    assert.equal(h.effects, 0);
  } finally {
    h.store.close();
    h.close();
  }
});

test("reconciliation is task-scoped and never touches another task's receipts", async () => {
  const h = harness();
  try {
    const first = "task-a";
    const second = "task-b";
    seedSession(h.store, first);
    seedSession(h.store, second);
    seedParticipant(h.store, first, `${first}:p1`);
    seedParticipant(h.store, second, `${second}:p1`);
    const spec = { taskId: second, participantId: `${second}:p1`, text: "第二个任务的输入。" };
    await runNativeSend(h, spec);
    const foreign = seedOperation(h.store, {
      taskId: second,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, first);
    assert.equal(report.changed, false);
    assert.equal(report.inspected.length, 0);
    assert.equal(leaderOperation(h.store, second, foreign.id).state, "pending");
    assert.equal(report.sessionId, leaderSessionId(first));
  } finally {
    h.store.close();
    h.close();
  }
});

test("missing or foreign task ownership blocks resolution instead of guessing", async () => {
  const h = harness();
  try {
    const taskId = "task-ownership";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "归属检查。" };
    await runNativeSend(h, spec);
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    // Another owner's task record must not authorize this receipt.
    h.store.set("tasks", taskId, {
      id: taskId,
      ownerId: "another-owner",
      participantIds: [spec.participantId],
    });
    const foreignOwner = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(foreignOwner.changed, false);
    assert.deepEqual(
      foreignOwner.blocked.map((entry) => entry.operationId),
      [operation.id],
    );
    // A missing task record blocks too.
    h.store.delete("tasks", taskId);
    const missing = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(missing.changed, false);
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
    assert.equal(h.effects, 1);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a send with no authoritative dispatch link or a foreign event revision stays blocked", async () => {
  const h = harness();
  try {
    const taskId = "task-link";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "链接检查。" };
    const nativeId = await runNativeSend(h, spec);
    const linked = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    // Drop the dispatch link: the native receipt can no longer be attributed.
    h.store.set("task_orchestration_events", EVENT, {
      id: EVENT,
      taskId,
      trigger: "ready",
      outputIds: [],
      userRevision: REVISION,
      state: "processing",
      attempts: 1,
      dispatches: [],
      createdAt: AT,
      updatedAt: AT,
    });
    const unlinked = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(unlinked.changed, false);
    assert.deepEqual(
      unlinked.blocked.map((entry) => entry.operationId),
      [linked.id],
    );
    // A revision mismatch on the same event blocks as well.
    seedDispatch(h.store, taskId, nativeId, spec.participantId, EVENT, "rev-2");
    const stale = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(stale.changed, false);
    assert.equal(leaderOperation(h.store, taskId, linked.id).state, "pending");
    assert.equal(h.effects, 1);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a native done receipt without a usable result is not promoted to completion", async () => {
  const h = harness();
  try {
    const taskId = "task-no-result";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "结果缺失。" };
    const nativeId = await runNativeSend(h, spec);
    h.store.set("operations", nativeId, {
      ...nativeRow(h.store, nativeId),
      result: { status: "unconfirmed", acked: false, verified: false, attempts: 1 },
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "unknown",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "unknown");
    assert.equal(h.effects, 1);
  } finally {
    h.store.close();
    h.close();
  }
});

test("an exact workflow selection receipt is recorded as selection only, never as execution", () => {
  const h = harness();
  try {
    const taskId = "task-selection-exact";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const candidateId = "dispatch:node-1";
    seedDispatch(h.store, taskId, "unused", `${taskId}:p1`);
    h.store.set("task_orchestration_events", EVENT, {
      ...(h.store.get<Record<string, unknown>>("task_orchestration_events", EVENT) ?? {}),
      // Exactly what `persistAction` writes for a committed Leader action.
      decision: { action: "continue", reason: "派发节点 1", candidateId, source: "leader" },
    });
    h.store.set("workflow_leader_actions", `wla_${stableId(EVENT, REVISION)}`, {
      version: 1,
      id: `wla_${stableId(EVENT, REVISION)}`,
      taskId,
      ownerId: OWNER,
      sessionId: leaderSessionId(taskId),
      eventId: EVENT,
      revision: REVISION,
      planVersion: 1,
      artifactRevision: "artifact-rev-1",
      state: "requested",
      request: { action: "dispatch", candidateId, reason: "派发节点 1" },
      candidate: {
        id: candidateId,
        kind: "dispatch",
        description: "派发",
        assignments: [{ nodeId: "node-1", participantId: `${taskId}:p1` }],
      },
      createdAt: AT,
      updatedAt: AT,
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "派发节点 1" },
      state: "unknown",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => [entry.operationId, entry.resolution]),
      [[operation.id, "treat_done"]],
    );
    const resolved = leaderOperation(h.store, taskId, operation.id);
    assert.deepEqual(resolved.result, {
      action: "dispatch",
      candidateId,
      accepted: true,
      nodeIds: ["node-1"],
      participantIds: [`${taskId}:p1`],
      selected: true,
      dispatched: "unknown",
      businessCompletion: "unknown",
      note: "选择回执已持久化；派发结果、投递与业务完成均未确认，需按原生回执继续核对。",
    });
    // The proof never claims a delivery and never touches the native send path.
    assert.equal(h.effects, 0);
    assert.equal(h.store.get("input_deliveries", "unused"), undefined);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a resolved abandon keeps blocking replay and is never auto-retried", async () => {
  const h = harness();
  try {
    const taskId = "task-no-retry";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "不再重放。" };
    const nativeId = seedUnsettledNative(h.store, spec, "uncertain");
    new Operations(h.store).resolve(nativeId, {
      choice: "abandon",
      decidedBy: "evidence",
      reason: "执行现场已确认未送达",
      at: AT,
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "unknown",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.resolution),
      ["abandon"],
    );
    const closed = leaderOperation(h.store, taskId, operation.id);
    assert.equal(closed.state, "not_executed");
    assert.equal(closed.resolution?.choice, "abandon");
    // The native operation was not recreated and no new effect happened.
    assert.equal(
      h.store.get<{ resolution?: { choice?: string } }>("operations", nativeId)?.resolution?.choice,
      "abandon",
    );
    assert.equal(h.effects, 0);
    // A second reconciliation is a no-op; abandon receipts are already decided.
    const again = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(again.changed, false);
    assert.equal(again.inspected.length, 0);
    assert.equal(h.effects, 0);
  } finally {
    h.store.close();
    h.close();
  }
});

test("reconciliation survives a crash between the native write and the journal settle", async () => {
  const h = harness();
  try {
    const taskId = "task-crash-settle";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "崩溃窗口检查。" };
    const nativeId = await runNativeSend(h, spec);
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    // The process dies here; the journal entry is still pending while the native
    // receipt already proves the delivery. Reopen and reconcile.
    const store = reopen(h);
    const report = reconcileLeaderReceipts(store, taskId);
    assert.equal(report.changed, true);
    assert.equal(leaderOperation(store, taskId, operation.id).state, "complete");
    assert.equal(nativeRow(store, nativeId).state, "done");
    assert.equal(h.effects, 1);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a real Leader activation proceeds after reconciliation and still refuses before it", async () => {
  const h = harness();
  try {
    const taskId = "task-activation";
    seedSession(h.store, taskId);
    seedParticipant(h.store, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "激活前置检查。" };
    await runNativeSend(h, spec);
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    let engineCalls = 0;
    const engine = {
      contextTokens: 50000,
      async run(input: {
        actor: { taskId?: string };
        messages: unknown[];
      }): Promise<Record<string, unknown>> {
        engineCalls += 1;
        assert.equal(input.actor.taskId, taskId);
        return { text: "已继续", messages: [], toolCalls: 0, writeCalls: 0 };
      },
      async summarize() {
        return "summary";
      },
    };
    const runtime = leaderRuntime(h.store);
    const activation = () =>
      runtime.runTaskLeader({
        store: h.store,
        engine: engine as never,
        actor: {
          source: "system",
          ownerId: OWNER,
          chatId: `chat-${taskId}`,
          sessionId: `orchestration:${taskId}`,
          taskId,
          messageId: EVENT,
        },
        eventId: EVENT,
        revision: REVISION,
        systemPrompt: "s",
        prompt: "p",
        tools: [],
      });
    // Before reconciliation the unresolved write blocks the activation outright.
    await assert.rejects(activation(), { code: "operation_unconfirmed" });
    assert.equal(engineCalls, 0);
    // The exact native receipt is enough to unblock it without any replay.
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, true);
    await activation();
    assert.equal(engineCalls, 1);
    assert.equal(h.effects, 1);
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "complete");
    assert.equal(runtime.blockedWrites(taskId).length, 0);
  } finally {
    h.store.close();
    h.close();
  }
});
