import assert from "node:assert/strict";
import test from "node:test";
import { LEADER_DECISION_ACTION, reconcileLeaderReceipts } from "../../src/app/leader-receipts.js";
import { canonical, stableId } from "../../src/core/ids.js";
import { leaderSessionId } from "../../src/orchestration/leader-session-types.js";
import {
  AT,
  EVENT,
  harness,
  leaderOperation,
  nativeRow,
  OWNER,
  runNativeSend,
  seedDecidedEvent,
  seedDispatch,
  seedInputDelivery,
  seedOperation,
  seedParticipant,
  seedSession,
  seedSettledOutput,
  seedUnsettledNative,
} from "./leader-receipts-helpers.js";

/**
 * Real model calls carry the arguments the production tools actually declare.
 * `task-orchestrator.scopedTools` keeps the global `participant_send` schema and
 * only scopes `taskId`, so a valid call may include it; the Leader action tools
 * omit `candidateId` for wait/deliver; and `orchestration_decide` records the
 * trimmed reason plus the validated settled output for deliver. Everything here
 * uses those exact shapes, and nothing here may weaken the identity,
 * fingerprint, event, dispatch or input-delivery checks.
 */

/** The durable session and task identity the proof requires, then one participant. */
function seedLeaderTask(
  h: ReturnType<typeof harness>,
  taskId: string,
  participantId: string,
): void {
  seedSession(h.store, taskId);
  seedParticipant(h.store, taskId, participantId);
}

test("an explicit same-task taskId is a valid real participant_send call and resolves", async () => {
  const h = harness();
  try {
    const taskId = "task-real-send";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "请实现并给出证据。" };
    const nativeId = await runNativeSend(h, spec);
    // Exactly what the scoped orchestrator passes through to TaskService.send.
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { taskId, participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => [entry.operationId, entry.resolution]),
      [[operation.id, "treat_done"]],
    );
    const resolved = leaderOperation(h.store, taskId, operation.id);
    assert.equal(resolved.state, "complete");
    assert.equal((resolved.result as { verified?: boolean }).verified, true);
    assert.equal(nativeRow(h.store, nativeId).state, "done");
    assert.equal(h.effects, 1);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a foreign taskId or an undeclared field keeps a real-looking send blocked", async () => {
  const h = harness();
  try {
    const taskId = "task-real-send-negative";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "请实现并给出证据。" };
    await runNativeSend(h, spec);
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "foreign taskId",
        { taskId: "other-task", participantId: spec.participantId, text: spec.text },
      ],
      ["non-string taskId", { taskId: 7, participantId: spec.participantId, text: spec.text }],
      ["null taskId", { taskId: null, participantId: spec.participantId, text: spec.text }],
      ["undeclared field", { participantId: spec.participantId, text: spec.text, reason: "extra" }],
      [
        "extra field beside taskId",
        { taskId, participantId: spec.participantId, text: spec.text, readOnly: true },
      ],
      ["blank text", { participantId: spec.participantId, text: "   " }],
      ["foreign participant", { participantId: `${taskId}:p9`, text: spec.text }],
    ];
    const seeded = cases.map(
      ([name, args]) =>
        [name, seedOperation(h.store, { taskId, tool: "participant_send", args })] as const,
    );
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId).sort(),
      seeded.map(([, operation]) => operation.id).sort(),
    );
    for (const [name, operation] of seeded)
      assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending", name);
    assert.equal(h.effects, 1);
  } finally {
    h.store.close();
    h.close();
  }
});

test("every real prompt version's first-turn body is accepted in its exact writer shape", async () => {
  // v3 joins prompt lines with a blank line; v1/v2 append with a single newline;
  // v2 then appends its protocol footer AFTER the receipt token. All three are
  // real writer shapes and all three must resolve; the marker+token section is
  // required, not a trailing position.
  for (const promptVersion of [undefined, 2, 3] as const) {
    const h = harness();
    try {
      const taskId = `task-initial-v${promptVersion ?? 1}`;
      seedLeaderTask(h, taskId, `${taskId}:p1`);
      const spec = {
        taskId,
        participantId: `${taskId}:p1`,
        text: "首轮完整要求。",
        initial: true as const,
        ...(promptVersion ? { promptVersion } : {}),
      };
      const nativeId = await runNativeSend(h, spec);
      const operation = seedOperation(h.store, {
        taskId,
        tool: "participant_send",
        args: { participantId: spec.participantId, text: spec.text },
        state: "pending",
      });
      const report = reconcileLeaderReceipts(h.store, taskId);
      assert.deepEqual(
        report.resolved.map((entry) => entry.operationId),
        [operation.id],
        `prompt v${promptVersion ?? 1}: ${JSON.stringify(report.blocked)}`,
      );
      // The fixture must really carry that version's writer shape.
      const delivery = h.store.get<{ prompt?: string; receipt?: string }>(
        "input_deliveries",
        nativeId,
      );
      const token = delivery?.receipt as string;
      const blankLineShape = delivery?.prompt?.includes(`投递标识（无需复述）：\n\n${token}`);
      const singleLineShape = delivery?.prompt?.includes(`投递标识（无需复述）：\n${token}`);
      assert.ok(
        promptVersion === 3 ? blankLineShape : singleLineShape,
        `prompt v${promptVersion ?? 1} shape`,
      );
      if (promptVersion === 2)
        assert.equal(delivery?.prompt?.endsWith(token), false, "the v2 footer follows the token");
      else assert.equal(delivery?.prompt?.endsWith(token), true);
    } finally {
      h.store.close();
      h.close();
    }
  }
});

test("a first-turn delivery resolves only with its own receipt envelope and fingerprint", async () => {
  const h = harness();
  try {
    const taskId = "task-initial";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const spec = {
      taskId,
      participantId: `${taskId}:p1`,
      text: "首轮完整要求。",
      initial: true,
    };
    const nativeId = await runNativeSend(h, spec);
    const valid = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.operationId),
      [valid.id],
    );
    assert.equal(leaderOperation(h.store, taskId, valid.id).state, "complete");
    assert.equal(nativeRow(h.store, nativeId).state, "done");
    assert.equal(h.effects, 1);

    // A first-turn body whose token is not this participant's own receipt, or
    // whose recorded text is absent, is a different native input.
    const other = { taskId, participantId: `${taskId}:p1`, text: "另一段首轮要求。" };
    const otherId = await runNativeSend(h, { ...other, initial: true });
    const seeded: string[] = [];
    for (const [name, mutate] of [
      [
        "foreign receipt token",
        (row: Record<string, unknown>) => ({ ...row, receipt: "HERDR_RECEIPT_foreign" }),
      ],
      [
        "recorded text absent",
        (row: Record<string, unknown>) => ({ ...row, prompt: "不相干的正文。", fingerprint: "x" }),
      ],
      [
        "trailing token line removed",
        (row: Record<string, unknown>) => ({
          ...row,
          prompt: String(row.prompt)
            .split("\n")
            .filter((line) => line !== row.receipt)
            .join("\n"),
        }),
      ],
    ] as const) {
      const original = h.store.get<Record<string, unknown>>("input_deliveries", otherId);
      assert.ok(original);
      h.store.set("input_deliveries", otherId, mutate(original));
      const operation = seedOperation(h.store, {
        taskId,
        tool: "participant_send",
        args: { participantId: other.participantId, text: other.text },
        state: "pending",
      });
      seeded.push(operation.id);
      const blocked = reconcileLeaderReceipts(h.store, taskId);
      assert.equal(blocked.changed, false, name);
      assert.ok(
        blocked.inspected.some((entry) => entry.operationId === operation.id),
        name,
      );
      assert.deepEqual(
        blocked.resolved.map((entry) => entry.operationId),
        [],
        name,
      );
      assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending", name);
      h.store.set("input_deliveries", otherId, original);
      // The restored body proves the receipt, so each mutation really was the
      // cause. Re-arm the same receipt for the next mutation.
      const restoredOne = reconcileLeaderReceipts(h.store, taskId);
      assert.ok(
        restoredOne.resolved.some((entry) => entry.operationId === operation.id),
        name,
      );
      h.store.set("leader_operations", operation.id, {
        ...leaderOperation(h.store, taskId, operation.id),
        state: "pending",
        resolution: undefined,
        result: undefined,
        error: undefined,
      });
    }
    // A final receipt for the same prepared body proves the body itself was
    // never the reason the mutations above stayed blocked.
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: other.participantId, text: other.text },
      state: "pending",
    });
    const restored = reconcileLeaderReceipts(h.store, taskId);
    assert.ok(
      restored.resolved.some((entry) => entry.operationId === operation.id),
      JSON.stringify(restored.blocked),
    );
    assert.equal(nativeRow(h.store, otherId).state, "done");
  } finally {
    h.store.close();
    h.close();
  }
});

test("a native fingerprint that disagrees with the recorded text is never a match", async () => {
  const h = harness();
  try {
    const taskId = "task-fingerprint";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "指纹检查。" };
    const nativeId = await runNativeSend(h, spec);
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    // The native receipt was written for different parameters under the key the
    // recorded text derives: proof fails before any resolution.
    h.store.set("operations", nativeId, {
      ...nativeRow(h.store, nativeId),
      fingerprint: "tampered",
    });
    assert.equal(reconcileLeaderReceipts(h.store, taskId).changed, false);
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
    // A delivery row whose own fingerprint disagrees is equally not this send.
    h.store.set("operations", nativeId, {
      ...nativeRow(h.store, nativeId),
      fingerprint: stableId(canonical({ participant: spec.participantId, text: spec.text })),
    });
    const delivery = h.store.get<Record<string, unknown>>("input_deliveries", nativeId);
    assert.ok(delivery);
    h.store.set("input_deliveries", nativeId, { ...delivery, fingerprint: "tampered" });
    assert.equal(reconcileLeaderReceipts(h.store, taskId).changed, false);
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
    h.store.set("input_deliveries", nativeId, delivery);
    assert.deepEqual(
      reconcileLeaderReceipts(h.store, taskId).resolved.map((entry) => entry.operationId),
      [operation.id],
    );
  } finally {
    h.store.close();
    h.close();
  }
});

test("the dispatch link must name this operation and participant for this event revision", async () => {
  const h = harness();
  try {
    const taskId = "task-link-negative";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "派发链接检查。" };
    const nativeId = await runNativeSend(h, spec);
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    const wrongParticipant = `${taskId}:p2`;
    for (const [name, mutate] of [
      [
        "foreign participant in the link",
        (row: Record<string, unknown>) => ({
          ...row,
          dispatches: [{ operationId: nativeId, participantId: wrongParticipant, state: "sent" }],
        }),
      ],
      [
        "foreign operation in the link",
        (row: Record<string, unknown>) => ({
          ...row,
          dispatches: [{ operationId: "other", participantId: spec.participantId, state: "sent" }],
        }),
      ],
      ["no link at all", (row: Record<string, unknown>) => ({ ...row, dispatches: [] })],
    ] as const) {
      const original = h.store.get<Record<string, unknown>>("task_orchestration_events", EVENT);
      assert.ok(original);
      h.store.set("task_orchestration_events", EVENT, mutate(original));
      assert.equal(reconcileLeaderReceipts(h.store, taskId).changed, false, name);
      assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending", name);
      h.store.set("task_orchestration_events", EVENT, original);
    }
    seedDispatch(h.store, taskId, nativeId, spec.participantId);
    assert.deepEqual(
      reconcileLeaderReceipts(h.store, taskId).resolved.map((entry) => entry.operationId),
      [operation.id],
    );
  } finally {
    h.store.close();
    h.close();
  }
});

test("a deliver decision resolves only with the settled output the tool validated", async () => {
  const h = harness();
  try {
    const taskId = "task-decision-deliver";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const outputId = `${taskId}:p1:out-1`;
    const participantId = `${taskId}:p1`;
    seedSettledOutput(h.store, { taskId, participantId, outputId });
    seedDecidedEvent(h.store, taskId, {
      action: "deliver",
      reason: "参与者已给出完整结论。",
      outputId,
      participantId,
    });
    const valid = seedOperation(h.store, {
      taskId,
      tool: LEADER_DECISION_ACTION,
      args: { action: "deliver", reason: "参与者已给出完整结论。", outputId },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => [entry.operationId, entry.resolution]),
      [[valid.id, "treat_done"]],
    );
    const resolved = leaderOperation(h.store, taskId, valid.id);
    assert.deepEqual(resolved.result, {
      action: "deliver",
      reason: "参与者已给出完整结论。",
      outputId,
      participantId,
      recorded: true,
      note: "决定记录已持久化；本结果不代表参与者已收到输入、已开始执行或任务已完成。",
    });
    // Only the decision is recorded: no delivery is claimed anywhere.
    const note = (resolved.result as { note: string }).note;
    assert.match(note, /不代表参与者已收到输入/);
    assert.equal(
      h.store.get<{ entry?: { text?: string } }>("task_settled_outputs", outputId)?.entry?.text,
      "参与者最终交付正文",
    );
  } finally {
    h.store.close();
    h.close();
  }
});

test("a changed reason, replaced outputId or missing settled output stays blocked", async () => {
  const h = harness();
  try {
    const taskId = "task-decision-negative";
    seedSession(h.store, taskId);
    const outputId = `${taskId}:p1:out-1`;
    seedSettledOutput(h.store, { taskId, participantId: `${taskId}:p1`, outputId });
    seedDecidedEvent(h.store, taskId, {
      action: "deliver",
      reason: "参与者已给出完整结论。",
      outputId,
      participantId: `${taskId}:p1`,
    });
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "different outputId",
        { action: "deliver", reason: "参与者已给出完整结论。", outputId: `${taskId}:p1:out-2` },
      ],
      ["no outputId", { action: "deliver", reason: "参与者已给出完整结论。" }],
      ["changed reason", { action: "deliver", reason: "另一段理由。", outputId }],
      ["foreign action", { action: "continue", reason: "参与者已给出完整结论。", outputId }],
      [
        "undeclared field",
        {
          action: "deliver",
          reason: "参与者已给出完整结论。",
          outputId,
          candidateId: "deliver:report",
        },
      ],
    ];
    const seeded = cases.map(
      ([name, args]) =>
        [name, seedOperation(h.store, { taskId, tool: LEADER_DECISION_ACTION, args })] as const,
    );
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId).sort(),
      seeded.map(([, operation]) => operation.id).sort(),
    );
    for (const [name, operation] of seeded)
      assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending", name);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a decision resolved from a workflow selection event is never adopted as this tool's effect", () => {
  const h = harness();
  try {
    const taskId = "task-decision-candidate";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    // The workflow commit path writes a candidate-bearing decision. An
    // `orchestration_decide` receipt with identical text is not that effect.
    seedDecidedEvent(h.store, taskId, {
      action: "continue",
      reason: "派发节点 1",
      candidateId: "dispatch:node-1",
      source: "leader",
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: LEADER_DECISION_ACTION,
      args: { action: "continue", reason: "派发节点 1" },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
  } finally {
    h.store.close();
    h.close();
  }
});

test("a documented reason.trim() normalization is accepted while real prose stays exact", () => {
  const h = harness();
  try {
    const taskId = "task-decision-trim";
    seedSession(h.store, taskId);
    // The tool persists `args.reason.trim()`; a model call that carried padding
    // still recorded exactly this decision.
    seedDecidedEvent(h.store, taskId, { action: "wait", reason: "缺少用户必需信息" });
    const padded = seedOperation(h.store, {
      taskId,
      tool: LEADER_DECISION_ACTION,
      args: { action: "wait", reason: "  缺少用户必需信息\n" },
      state: "pending",
    });
    const inner = seedOperation(h.store, {
      taskId,
      tool: LEADER_DECISION_ACTION,
      args: { action: "wait", reason: "缺少用户 必需信息" },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.operationId),
      [padded.id],
    );
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [inner.id],
    );
    assert.equal(
      (leaderOperation(h.store, taskId, padded.id).result as { reason: string }).reason,
      "缺少用户必需信息",
    );
    assert.equal(leaderOperation(h.store, taskId, inner.id).state, "pending");
  } finally {
    h.store.close();
    h.close();
  }
});

test("a send recorded with the receipt envelope of another operation never resolves", async () => {
  const h = harness();
  try {
    const taskId = "task-envelope";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "信封检查。" };
    const operationId = await runNativeSend(h, spec);
    // Rewrite the envelope to a token that no operation of this participant
    // could have derived, keeping everything else identical.
    const delivery = h.store.get<Record<string, unknown>>("input_deliveries", operationId);
    assert.ok(delivery);
    const prompt = String(delivery.prompt);
    h.store.set("input_deliveries", operationId, {
      ...delivery,
      receipt: "HERDR_RECEIPT_other",
      prompt: prompt.replace(String(delivery.receipt), "HERDR_RECEIPT_other"),
    });
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, false);
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
    assert.equal(nativeRow(h.store, operationId).state, "done");
  } finally {
    h.store.close();
    h.close();
  }
});

test("a retired operation is closed as an explicit retirement, not as historical non-execution", async () => {
  const h = harness();
  try {
    const taskId = "task-retire-wording";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "旧现场输入。" };
    const nativeId = await runNativeSend(h, spec);
    h.store.set("task_restarts", "restart-9", {
      id: "restart-9",
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
      report.resolved.map((entry) => entry.operationId),
      [operation.id],
    );
    const resolved = leaderOperation(h.store, taskId, operation.id);
    assert.equal(resolved.state, "not_executed");
    const reason = resolved.resolution?.reason ?? "";
    assert.match(reason, /restart-9/);
    assert.match(reason, /不重放/);
    // The wording must not assert that the historical attempt never happened.
    assert.doesNotMatch(reason, /未执行|没有发送|从未/);
    // The native history is untouched: it still records the real outcome.
    assert.equal(nativeRow(h.store, nativeId).state, "done");
    assert.equal(h.effects, 1);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a retirement whose restart record is not completed never closes the receipt", async () => {
  const h = harness();
  try {
    const taskId = "task-retire-incomplete";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "旧现场输入。" };
    // The native outcome itself stays unknown, so only a proven retirement could
    // close this receipt; every incomplete variant must leave it blocked.
    const nativeId = seedUnsettledNative(h.store, spec, "uncertain");
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "unknown",
    });
    for (const [name, restart, tag] of [
      ["closing restart", { key: "restart-pending", state: "closing", taskId }, undefined],
      [
        "unknown restart tag",
        { key: "restart-pending", state: "closing", taskId },
        "no-such-restart",
      ],
      [
        "foreign-task restart",
        { key: "restart-foreign", state: "done", taskId: "other-task" },
        "restart-foreign",
      ],
    ] as const) {
      for (const [key] of h.store.entries("task_restarts")) h.store.delete("task_restarts", key);
      h.store.set("task_restarts", restart.key, {
        id: "restart-x",
        taskId: restart.taskId,
        state: restart.state,
        operationIds: [nativeId],
        participants: [],
        replacements: {},
        eventIds: [],
        materialPath: "",
        at: AT,
      });
      h.store.set("operations", nativeId, {
        ...nativeRow(h.store, nativeId),
        ...(tag ? { retiredByRestart: tag } : { retiredByRestart: undefined }),
      });
      const report = reconcileLeaderReceipts(h.store, taskId);
      assert.equal(report.changed, false, name);
      assert.deepEqual(
        report.blocked.map((entry) => entry.operationId),
        [operation.id],
        name,
      );
      assert.equal(leaderOperation(h.store, taskId, operation.id).state, "unknown", name);
    }
    // The same operation under a completed restart of this task is closed as a
    // retirement, proving the cases above failed for the recorded reason.
    h.store.set("task_restarts", "restart-ok", {
      id: "restart-ok",
      taskId,
      state: "done",
      operationIds: [nativeId],
      participants: [],
      replacements: {},
      eventIds: [],
      materialPath: "",
      at: AT,
    });
    h.store.set("operations", nativeId, {
      ...nativeRow(h.store, nativeId),
      retiredByRestart: "restart-ok",
    });
    assert.deepEqual(
      reconcileLeaderReceipts(h.store, taskId).resolved.map((entry) => entry.resolution),
      ["abandon"],
    );
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "not_executed");
  } finally {
    h.store.close();
    h.close();
  }
});

test("operation args that cannot be parsed never resolve and never throw", () => {
  const h = harness();
  try {
    const taskId = "task-unparseable";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: {},
      state: "pending",
    });
    for (const raw of ["{not json", "[]", "null", '"text"', ""]) {
      h.store.set("leader_operations", operation.id, {
        ...leaderOperation(h.store, taskId, operation.id),
        args: raw,
      });
      const report = reconcileLeaderReceipts(h.store, taskId);
      assert.equal(report.changed, false, raw);
      assert.deepEqual(
        report.blocked.map((entry) => entry.operationId),
        [operation.id],
      );
    }
  } finally {
    h.store.close();
    h.close();
  }
});

test("a second task's records never authorize this task's reconciliation", async () => {
  const h = harness();
  try {
    const first = "task-scope-a";
    const second = "task-scope-b";
    seedLeaderTask(h, first, `${first}:p1`);
    seedLeaderTask(h, second, `${second}:p1`);
    const foreign = { taskId: second, participantId: `${second}:p1`, text: "另一个任务。" };
    const foreignId = await runNativeSend(h, foreign);
    // A receipt this task cannot own, written with this task's session id.
    const operation = seedOperation(h.store, {
      taskId: first,
      tool: "participant_send",
      args: { participantId: foreign.participantId, text: foreign.text },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, first);
    assert.equal(report.changed, false);
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.equal(leaderOperation(h.store, first, operation.id).state, "pending");
    assert.equal(nativeRow(h.store, foreignId).state, "done");
    assert.equal(leaderSessionId(first), report.sessionId);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a task whose receipt identity is valid but whose task record is gone stays blocked", async () => {
  const h = harness();
  try {
    const taskId = "task-record-gone";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "记录缺失。" };
    await runNativeSend(h, spec);
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    h.store.set("tasks", taskId, { id: "other-task", ownerId: OWNER, participantIds: [] });
    assert.equal(reconcileLeaderReceipts(h.store, taskId).changed, false);
    h.store.delete("tasks", taskId);
    assert.equal(reconcileLeaderReceipts(h.store, taskId).changed, false);
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "pending");
  } finally {
    h.store.close();
    h.close();
  }
});

test("the report only exposes bounded receipt facts and never model prose", async () => {
  const h = harness();
  try {
    const taskId = "task-report-shape";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "报告形状。" };
    await runNativeSend(h, spec);
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "unknown",
    });
    seedOperation(h.store, {
      taskId,
      tool: "some_custom_tool",
      args: { anything: true },
      state: "pending",
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(Object.keys(report).sort(), [
      "blocked",
      "changed",
      "inspected",
      "resolved",
      "sessionId",
      "taskId",
    ]);
    assert.deepEqual(
      report.inspected.map((entry) => entry.tool),
      ["participant_send", "some_custom_tool"],
    );
    assert.equal(report.inspected[0]?.state, "unknown");
    for (const entry of [...report.inspected, ...report.blocked, ...report.resolved])
      for (const key of Object.keys(entry))
        assert.ok(["operationId", "tool", "state", "resolution", "reason"].includes(key), key);
    // The resolved send never claims business completion.
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "complete");
  } finally {
    h.store.close();
    h.close();
  }
});

test("no reconciliation path ever writes a native record or invokes a tool", async () => {
  const h = harness();
  try {
    const taskId = "task-pure-read";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "纯读取检查。" };
    const nativeId = await runNativeSend(h, spec);
    seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "pending",
    });
    const before = {
      native: structuredClone(nativeRow(h.store, nativeId)),
      delivery: structuredClone(h.store.get("input_deliveries", nativeId)),
      event: structuredClone(h.store.get("task_orchestration_events", EVENT)),
      task: structuredClone(h.store.get("tasks", taskId)),
      session: structuredClone(h.store.get("leader_sessions", leaderSessionId(taskId))),
    };
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(report.changed, true);
    assert.deepEqual(nativeRow(h.store, nativeId), before.native);
    assert.deepEqual(h.store.get("input_deliveries", nativeId), before.delivery);
    assert.deepEqual(h.store.get("task_orchestration_events", EVENT), before.event);
    assert.deepEqual(h.store.get("tasks", taskId), before.task);
    assert.deepEqual(h.store.get("leader_sessions", leaderSessionId(taskId)), before.session);
    assert.equal(h.effects, 1, "no second native effect");
    assert.equal(h.store.list("operations").length, 1);
  } finally {
    h.store.close();
    h.close();
  }
});

test("a crash between the native write and the journal settle resolves on reopen without replay", async () => {
  const h = harness();
  try {
    const taskId = "task-reopen-unknown";
    seedLeaderTask(h, taskId, `${taskId}:p1`);
    const spec = { taskId, participantId: `${taskId}:p1`, text: "崩溃窗口。" };
    // The delivery prep exists but the native run never settled: seed it directly.
    const operationId = `${taskId}:send:${stableId(EVENT, spec.participantId, spec.text)}`;
    seedDispatch(h.store, taskId, operationId, spec.participantId);
    seedInputDelivery(h.store, spec, operationId);
    const operation = seedOperation(h.store, {
      taskId,
      tool: "participant_send",
      args: { participantId: spec.participantId, text: spec.text },
      state: "unknown",
    });
    const pending = reconcileLeaderReceipts(h.store, taskId);
    assert.equal(pending.changed, false);
    assert.deepEqual(
      pending.blocked.map((entry) => entry.operationId),
      [operation.id],
    );
    // The native outcome is now proven; reopening and reconciling closes it once.
    h.store.set("operations", operationId, {
      id: operationId,
      fingerprint: structuredClone(
        (
          h.store.get<Record<string, unknown>>("input_deliveries", operationId) as Record<
            string,
            unknown
          >
        ).fingerprint,
      ),
      state: "done",
      result: { status: "delivered", acked: true, verified: true, attempts: 1 },
      updatedAt: AT,
    });
    const report = reconcileLeaderReceipts(h.store, taskId);
    assert.deepEqual(
      report.resolved.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.equal(leaderOperation(h.store, taskId, operation.id).state, "complete");
    assert.equal(h.effects, 0, "reconciliation never performs the send itself");
  } finally {
    h.store.close();
    h.close();
  }
});
