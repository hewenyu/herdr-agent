import assert from "node:assert/strict";
import test from "node:test";
import {
  leaderActionRecordId,
  reconcileLeaderReceipts,
  WORKFLOW_SELECTION_NOTE,
} from "../../src/app/leader-receipts.js";
import {
  AT,
  EVENT,
  harness,
  leaderOperation,
  OWNER,
  REVISION,
  seedDecidedEvent,
  seedLeaderTask,
  seedOperation,
  seedWorkflowAction,
} from "./leader-receipts-helpers.js";

/**
 * The workflow action tools persist their selection through `commitAction` +
 * `persistAction` in one store transaction. These tests reproduce exactly what
 * those writers record — including `textArg`'s trim, the instruction field only
 * on `workflow_dispatch`, the omitted `candidateId` of wait/deliver, the
 * raw-prefix rework selection, `source: "leader"` and the `user` kind's
 * description-derived reason — and require the proof to fail closed on every
 * deviation. Nothing here proves dispatch, delivery or business completion.
 */

const DISPATCH_TOOLS = ["workflow_dispatch", "workflow_verify", "workflow_replan"] as const;

test("a committed dispatch selection resolves as a recorded selection only", () => {
  const h = harness();
  try {
    const taskId = "task-wf-dispatch";
    seedLeaderTask(h.store, taskId, `${taskId}:p1`);
    const candidateId = "dispatch:opening-1:p1";
    seedWorkflowAction(h.store, {
      taskId,
      action: "dispatch",
      candidateId,
      candidateKind: "dispatch",
      reason: "节点已就绪",
      instruction: "请实现并给出证据。",
      assignments: [{ nodeId: "opening-1", participantId: `${taskId}:p1` }],
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪", instruction: "请实现并给出证据。" },
      state: "pending",
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
      nodeIds: ["opening-1"],
      participantIds: [`${taskId}:p1`],
      selected: true,
      dispatched: "unknown",
      businessCompletion: "unknown",
      note: WORKFLOW_SELECTION_NOTE,
    });
    // The proof claims the selection, never an execution.
    const result = resolved.result as { note: string; dispatched: string };
    assert.equal(result.dispatched, "unknown");
    assert.match(result.note, /未确认/);
  } finally {
    h.store.close();
    h.close();
  }
});

test("commit-time trimming of the recorded reason and instruction is reproduced exactly", () => {
  const h = harness();
  try {
    const taskId = "task-wf-trim";
    seedLeaderTask(h.store, taskId, `${taskId}:p1`);
    const candidateId = "dispatch:opening-1:p1";
    // `commit()` stores the normalized request: textArg trims both fields.
    seedWorkflowAction(h.store, {
      taskId,
      action: "dispatch",
      candidateId,
      candidateKind: "dispatch",
      reason: "节点已就绪",
      instruction: "请实现并给出证据。",
      assignments: [{ nodeId: "opening-1", participantId: `${taskId}:p1` }],
    });
    const padded = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: {
        candidateId,
        reason: "  节点已就绪\n",
        instruction: "\t请实现并给出证据。 ",
      },
      state: "pending",
    });
    // A reason that differs in its actual content is a different action.
    const different = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点 已就绪", instruction: "请实现并给出证据。" },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.operationId),
      [padded.id],
    );
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [different.id],
    );
  } finally {
    h.store.close();
    h.close();
  }
});

test("an omitted candidateId is required for wait and deliver, and rejected where it is declared", () => {
  const h = harness();
  try {
    const taskId = "task-wf-omitted";
    seedLeaderTask(h.store, taskId, `${taskId}:p1`);
    // One selection record per event+revision: wait and deliver are separate events.
    const waitEvent = EVENT;
    const deliverEvent = "orchestrate:event-deliver";
    seedWorkflowAction(h.store, {
      taskId,
      action: "wait",
      candidateId: "user:blocked",
      candidateKind: "user",
      reason: "缺少用户必需信息",
      description: "只有确需用户决定、权限或必需信息时等待用户。",
      eventId: waitEvent,
    });
    seedWorkflowAction(h.store, {
      taskId,
      action: "deliver",
      candidateId: "deliver:report",
      candidateKind: "deliver",
      reason: "报告合同满足",
      eventId: deliverEvent,
    });
    const wait = seedOperation(h.store, {
      taskId,
      tool: "workflow_wait",
      args: { reason: "缺少用户必需信息" },
      state: "pending",
      eventId: waitEvent,
    });
    const deliver = seedOperation(h.store, {
      taskId,
      tool: "workflow_deliver",
      args: { reason: "报告合同满足" },
      state: "pending",
      eventId: deliverEvent,
    });
    // A model call that leaked the resolved candidate id is not the recorded request.
    const leakedWait = seedOperation(h.store, {
      taskId,
      tool: "workflow_wait",
      args: { candidateId: "user:blocked", reason: "缺少用户必需信息" },
      state: "pending",
      eventId: waitEvent,
    });
    const leakedDeliver = seedOperation(h.store, {
      taskId,
      tool: "workflow_deliver",
      args: { candidateId: "deliver:report", reason: "报告合同满足" },
      state: "pending",
      eventId: deliverEvent,
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => [entry.operationId, entry.resolution]).sort(),
      [
        [deliver.id, "treat_done"],
        [wait.id, "treat_done"],
      ].sort(),
    );
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId).sort(),
      [leakedDeliver.id, leakedWait.id].sort(),
    );
    // The `user` kind persists the candidate description as the event reason.
    const waitResult = leaderOperation(h.store, taskId, wait.id).result as { action: string };
    assert.equal(waitResult.action, "wait");
  } finally {
    h.store.close();
    h.close();
  }
});

test("dispatch vs rework follows the raw candidate prefix exactly as the tool selects it", () => {
  const h = harness();
  try {
    const taskId = "task-wf-rework";
    seedLeaderTask(h.store, taskId, `${taskId}:p1`);
    const reworkId = "rework:opening-1:p1";
    seedWorkflowAction(h.store, {
      taskId,
      action: "rework",
      candidateId: reworkId,
      candidateKind: "rework",
      reason: "补充证据",
      assignments: [{ nodeId: "opening-1", participantId: `${taskId}:p1` }],
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId: reworkId, reason: "补充证据" },
      state: "pending",
    });
    // A record that claims "dispatch" for a rework candidate is inconsistent.
    h.store.set("workflow_leader_actions", leaderActionRecordId(EVENT, REVISION), {
      ...(h.store.get<Record<string, unknown>>(
        "workflow_leader_actions",
        leaderActionRecordId(EVENT, REVISION),
      ) as Record<string, unknown>),
      request: { action: "dispatch", candidateId: reworkId, reason: "补充证据" },
    });
    assert.equal(reconcileLeaderReceipts(h.store, taskId).changed, false);
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
    // The real recorded action resolves it.
    seedWorkflowAction(h.store, {
      taskId,
      action: "rework",
      candidateId: reworkId,
      candidateKind: "rework",
      reason: "补充证据",
      assignments: [{ nodeId: "opening-1", participantId: `${taskId}:p1` }],
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.resolution),
      ["treat_done"],
    );
    assert.equal(
      (leaderOperation(h.store, taskId, operation.id).result as { action: string }).action,
      "rework",
    );
  } finally {
    h.store.close();
    h.close();
  }
});

test("a verify selection requires the exact action, kind and candidate of the real commit", () => {
  const h = harness();
  try {
    const taskId = "task-wf-verify";
    seedLeaderTask(h.store, taskId, `${taskId}:p1`);
    const candidateId = "verify:validation:cmd-1";
    seedWorkflowAction(h.store, {
      taskId,
      action: "verify",
      candidateId,
      candidateKind: "verify",
      reason: "在最新代码上验证",
    });
    const valid = seedOperation(h.store, {
      taskId,
      tool: "workflow_verify",
      args: { candidateId, reason: "在最新代码上验证" },
      state: "pending",
    });
    // An instruction is not part of the verify schema.
    const withInstruction = seedOperation(h.store, {
      taskId,
      tool: "workflow_verify",
      args: { candidateId, reason: "在最新代码上验证", instruction: "额外指示" },
      state: "pending",
    });
    // The record's own candidate must equal the requested one.
    const otherCandidate = seedOperation(h.store, {
      taskId,
      tool: "workflow_verify",
      args: { candidateId: "verify:other", reason: "在最新代码上验证" },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.operationId),
      [valid.id],
    );
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId).sort(),
      [otherCandidate.id, withInstruction.id].sort(),
    );
    for (const tool of DISPATCH_TOOLS) assert.ok(tool.startsWith("workflow_"));
  } finally {
    h.store.close();
    h.close();
  }
});

test("an oversized or empty reason is rejected exactly as textArg would reject it", () => {
  const h = harness();
  try {
    const taskId = "task-wf-bounds";
    seedLeaderTask(h.store, taskId, `${taskId}:p1`);
    const candidateId = "dispatch:opening-1:p1";
    const long = "x".repeat(1201);
    seedWorkflowAction(h.store, {
      taskId,
      action: "dispatch",
      candidateId,
      candidateKind: "dispatch",
      reason: long,
    });
    const over = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: long },
      state: "pending",
    });
    seedWorkflowAction(h.store, {
      taskId,
      action: "dispatch",
      candidateId,
      candidateKind: "dispatch",
      reason: "边界内",
      instruction: "y".repeat(2001),
    });
    const instructionOver = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "边界内", instruction: "y".repeat(2001) },
      state: "pending",
    });
    for (const [name, operation] of [
      ["reason over bound", over],
      ["instruction over bound", instructionOver],
    ] as const) {
      const report = reconcileLeaderReceipts(h.store, taskId);
      assert.equal(
        report.resolved.some((entry) => entry.operationId === operation.id),
        false,
        name,
      );
      assert.equal(
        report.inspected.some((entry) => entry.operationId === operation.id),
        true,
        name,
      );
      assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending", name);
    }
    // The exact in-bound shapes resolve, so the bounds are the only reason above.
    seedWorkflowAction(h.store, {
      taskId,
      action: "dispatch",
      candidateId,
      candidateKind: "dispatch",
      reason: "边界内",
      instruction: "y".repeat(2000),
    });
    const exact = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "边界内", instruction: "y".repeat(2000) },
      state: "pending",
    });
    assert.deepEqual(
      reconcileLeaderReceipts(h.store, taskId).resolved.map((entry) => entry.operationId),
      [exact.id],
    );
  } finally {
    h.store.close();
    h.close();
  }
});

test("a selection record whose owner, session, event or revision is foreign never resolves", () => {
  const h = harness();
  try {
    const taskId = "task-wf-identity";
    seedLeaderTask(h.store, taskId, `${taskId}:p1`);
    const candidateId = "dispatch:opening-1:p1";
    seedWorkflowAction(h.store, {
      taskId,
      action: "dispatch",
      candidateId,
      candidateKind: "dispatch",
      reason: "节点已就绪",
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪" },
      state: "pending",
    });
    const recordId = leaderActionRecordId(EVENT, REVISION);
    const original = h.store.get<Record<string, unknown>>("workflow_leader_actions", recordId);
    assert.ok(original);
    const patches: Array<[string, Record<string, unknown>]> = [
      ["owner", { ownerId: "someone-else" }],
      ["owner empty", { ownerId: "" }],
      ["session", { sessionId: "task-leader:other" }],
      ["task", { taskId: "other-task" }],
      ["event", { eventId: "orchestrate:other" }],
      ["revision", { revision: "rev-2" }],
      ["record id", { id: "wla_other" }],
      ["failed state", { state: "failed" }],
      ["unknown state", { state: "pending" }],
      ["missing request", { request: undefined }],
      ["missing candidate", { candidate: undefined }],
      ["candidate kind", { candidate: { id: candidateId, kind: "verify" } }],
      ["candidate id", { candidate: { id: "dispatch:other", kind: "dispatch" } }],
      [
        "request candidate",
        {
          request: { action: "dispatch", candidateId: "dispatch:other", reason: "节点已就绪" },
        },
      ],
      ["request action", { request: { action: "verify", candidateId, reason: "节点已就绪" } }],
      ["request reason", { request: { action: "dispatch", candidateId, reason: "别的理由" } }],
      [
        "unexpected instruction",
        { request: { action: "dispatch", candidateId, reason: "节点已就绪", instruction: "x" } },
      ],
    ];
    for (const [name, patch] of patches) {
      h.store.set("workflow_leader_actions", recordId, { ...original, ...patch });
      h.store.set("leader_operations", operation.id, {
        ...leaderOperation(h.store, taskId, operation.id),
        state: "pending",
        resolution: undefined,
        result: undefined,
      });
      const report = reconcileLeaderReceipts(h.store, taskId);
      assert.equal(report.changed, false, name);
      assert.equal(report.resolved.length, 0, `${name}: ${JSON.stringify(report.resolved)}`);
      assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending", name);
    }
    // The unmodified record resolves, so the patches above were the cause.
    h.store.set("workflow_leader_actions", recordId, original);
    assert.deepEqual(
      reconcileLeaderReceipts(h.store, taskId).resolved.map((entry) => entry.operationId),
      [operation.id],
    );
  } finally {
    h.store.close();
    h.close();
  }
});

test("the event decision must be the record's own leader decision, not a lookalike", () => {
  const h = harness();
  try {
    const taskId = "task-wf-event";
    seedLeaderTask(h.store, taskId, `${taskId}:p1`);
    const candidateId = "dispatch:opening-1:p1";
    seedWorkflowAction(h.store, {
      taskId,
      action: "dispatch",
      candidateId,
      candidateKind: "dispatch",
      reason: "节点已就绪",
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪" },
      state: "pending",
    });
    const patches: Array<[string, Record<string, unknown> | undefined]> = [
      ["no decision", undefined],
      ["rule source", { action: "continue", reason: "节点已就绪", candidateId, source: "rule" }],
      ["pi source", { action: "continue", reason: "节点已就绪", candidateId, source: "pi" }],
      ["missing source", { action: "continue", reason: "节点已就绪", candidateId }],
      ["foreign candidate", { action: "continue", reason: "节点已就绪", source: "leader" }],
      [
        "other candidate",
        {
          action: "continue",
          reason: "节点已就绪",
          candidateId: "dispatch:other",
          source: "leader",
        },
      ],
      ["wrong action", { action: "wait", reason: "节点已就绪", candidateId, source: "leader" }],
      ["changed reason", { action: "continue", reason: "别的理由", candidateId, source: "leader" }],
    ];
    for (const [name, decision] of patches) {
      seedDecidedEvent(h.store, taskId, decision as Record<string, unknown>);
      if (decision === undefined) {
        const event = h.store.get<Record<string, unknown>>("task_orchestration_events", EVENT);
        assert.ok(event);
        h.store.set("task_orchestration_events", EVENT, { ...event, decision: undefined });
      }
      h.store.set("leader_operations", operation.id, {
        ...leaderOperation(h.store, taskId, operation.id),
        state: "pending",
        resolution: undefined,
        result: undefined,
      });
      assert.equal(reconcileLeaderReceipts(h.store, taskId).changed, false, name);
      assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending", name);
    }
    // The exact production decision resolves it.
    seedWorkflowAction(h.store, {
      taskId,
      action: "dispatch",
      candidateId,
      candidateKind: "dispatch",
      reason: "节点已就绪",
    });
    assert.deepEqual(
      reconcileLeaderReceipts(h.store, taskId).resolved.map((entry) => entry.operationId),
      [operation.id],
    );
  } finally {
    h.store.close();
    h.close();
  }
});

test("a selection receipt missing from the journal never resolves from the event alone", () => {
  const h = harness();
  try {
    const taskId = "task-wf-no-record";
    seedLeaderTask(h.store, taskId, `${taskId}:p1`);
    const candidateId = "dispatch:opening-1:p1";
    // The event decision exists (recovery persisted it) but the record does not.
    seedDecidedEvent(h.store, taskId, {
      action: "continue",
      reason: "节点已就绪",
      candidateId,
      source: "leader",
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪" },
      state: "unknown",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [operation.id],
    );
  } finally {
    h.store.close();
    h.close();
  }
});

test("a committed selection is never promoted to a dispatch, delivery or completion claim", () => {
  const h = harness();
  try {
    const taskId = "task-wf-no-promotion";
    seedLeaderTask(h.store, taskId, `${taskId}:p1`);
    const candidateId = "dispatch:opening-1:p1";
    seedWorkflowAction(h.store, {
      taskId,
      action: "dispatch",
      candidateId,
      candidateKind: "dispatch",
      reason: "节点已就绪",
      assignments: [{ nodeId: "opening-1", participantId: `${taskId}:p1` }],
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪" },
      state: "pending",
    });
    // A settled native operation under the journal key proves nothing about delivery.
    h.store.set("operations", operation.id, {
      id: operation.id,
      fingerprint: "x",
      state: "done",
      result: { accepted: true, verified: true, status: "delivered" },
      updatedAt: AT,
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.operationId),
      [operation.id],
    );
    const resolved = leaderOperation(h.store, taskId, operation.id);
    assert.equal(resolved.state, "complete");
    const result = resolved.result as Record<string, unknown>;
    assert.equal(result.dispatched, "unknown");
    assert.equal(result.businessCompletion, "unknown");
    assert.equal(result.selected, true);
    assert.equal("verified" in result, false);
    assert.equal("status" in result, false);
    // The native row is untouched, and no delivery was prepared for it.
    assert.deepEqual(h.store.get("operations", operation.id), {
      id: operation.id,
      fingerprint: "x",
      state: "done",
      result: { accepted: true, verified: true, status: "delivered" },
      updatedAt: AT,
    });
    assert.equal(h.store.get("input_deliveries", operation.id), undefined);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a foreign task never closes this task's committed selection", () => {
  const h = harness();
  try {
    const taskId = "task-wf-scope";
    seedLeaderTask(h.store, taskId, `${taskId}:p1`);
    const candidateId = "dispatch:opening-1:p1";
    const record = seedWorkflowAction(h.store, {
      taskId,
      action: "dispatch",
      candidateId,
      candidateKind: "dispatch",
      reason: "节点已就绪",
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪" },
      state: "pending",
    });
    // The same record id under a foreign task record must not be adopted.
    h.store.set("workflow_leader_actions", record.id as string, {
      ...(h.store.get<Record<string, unknown>>(
        "workflow_leader_actions",
        record.id as string,
      ) as Record<string, unknown>),
      taskId: "other-task",
    });
    assert.equal(reconcileLeaderReceipts(h.store, taskId).changed, false);
    h.store.set("tasks", taskId, { id: taskId, ownerId: OWNER, participantIds: [] });
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
  } finally {
    h.store.close();
    h.close();
  }
});

test("a selection recorded for another event or revision is never reused", () => {
  const h = harness();
  try {
    const taskId = "task-wf-cross-event";
    seedLeaderTask(h.store, taskId, `${taskId}:p1`);
    const candidateId = "dispatch:opening-1:p1";
    seedWorkflowAction(h.store, {
      taskId,
      action: "dispatch",
      candidateId,
      candidateKind: "dispatch",
      reason: "节点已就绪",
      eventId: "orchestrate:other-event",
      revision: REVISION,
    });
    const foreignEvent = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪" },
      state: "pending",
      eventId: "orchestrate:other-event",
    });
    const here = seedOperation(h.store, {
      taskId,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪" },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.operationId),
      [foreignEvent.id],
    );
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [here.id],
    );
  } finally {
    h.store.close();
    h.close();
  }
});
