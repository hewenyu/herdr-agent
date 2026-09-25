import { canonical, now, stableId } from "../core/ids.js";
import type { Delivery, Participant, Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import { assertActive, type TaskContext } from "./context.js";
import type { InputDelivery } from "./input-delivery.js";
import { ownsTaskOperation } from "./operation-scope.js";
import { participantPromptCandidates } from "./prompts.js";

/** Resolve only a unique initial delivery proved by native user input; never send again. */
export async function recoverInitialInputs(context: TaskContext, task: Task): Promise<void> {
  await recoverPreparedInputs(context, task);
  if (!context.herdr.initialInput) return;
  for (const participant of context.records.participants(task)) {
    if (
      !participant.execution ||
      !participant.started ||
      participant.initialSent ||
      ["removed", "gone"].includes(participant.status)
    )
      continue;
    const execution = participant.execution;
    const operations = context.store
      .entries<OperationReceipt>("operations")
      .filter(
        ([id, operation]) =>
          (id === `${participant.id}:initial` ||
            id.startsWith(`${task.id}:send:`) ||
            id.startsWith(`${task.id}:relay:`)) &&
          ["pending", "uncertain"].includes(operation.state),
      );
    if (!operations.length) continue;
    const input = await context.herdr.initialInput(
      participant.execution,
      participant.initialReceipt,
    );
    assertActive(context);
    if (!input) continue;
    const prefixes = participantPromptCandidates(task, participant);
    const initialFingerprint = stableId(canonical({ receipt: participant.initialReceipt }));
    const receiptSuffix = `\n\n投递标识（无需复述）：\n${participant.initialReceipt}`;
    const fingerprints = new Set<string>();
    for (const prefix of prefixes) {
      const legacyPrefix = `${prefix}\n\n本轮安排：\n`;
      const arrangedPrefix = `${prefix.slice(0, -receiptSuffix.length)}\n\n本轮安排：\n`;
      const arrangement = input.startsWith(legacyPrefix)
        ? input.slice(legacyPrefix.length)
        : input.startsWith(arrangedPrefix) && input.endsWith(receiptSuffix)
          ? input.slice(arrangedPrefix.length, -receiptSuffix.length)
          : undefined;
      if (arrangement !== undefined)
        fingerprints.add(stableId(canonical({ participant: participant.id, text: arrangement })));
    }
    const matches = operations.filter(([id, operation]) =>
      id === `${participant.id}:initial`
        ? prefixes.includes(input) && operation.fingerprint === initialFingerprint
        : fingerprints.has(operation.fingerprint),
    );
    if (matches.length !== 1) continue;
    const [id, operation] = matches[0] as [string, OperationReceipt];
    const delivery: Delivery = {
      status: "delivered",
      acked: false,
      verified: true,
      attempts: 1,
      detail: "原生会话 user 记录已确认初始输入；未重新投递。",
    };
    context.store.transaction(() => {
      const current = context.store.get<OperationReceipt>("operations", id);
      if (
        !current ||
        current.fingerprint !== operation.fingerprint ||
        !["pending", "uncertain"].includes(current.state)
      )
        return;
      context.store.set("operations", id, {
        ...current,
        state: "done",
        result: delivery,
        error: undefined,
        updatedAt: now(),
      });
      participant.initialSent = true;
      execution.transcriptReceipt = participant.initialReceipt;
      participant.error = undefined;
      context.store.set("participant_awaiting_output", participant.id, {
        operationId: id,
        at: now(),
      });
      context.store.set("task_input_applied", id, { at: now() });
      context.records.saveParticipant(participant);
      task.discussion.activeParticipant = participant.id;
      if (id.startsWith(`${task.id}:relay:`)) {
        task.discussion.nextParticipant = context.records
          .participants(task)
          .filter((entry) => entry.status !== "removed")
          .findIndex((entry) => entry.id === participant.id);
      }
      task.discussion.startedAt ??= now();
      const unknown = context.store
        .entries<OperationReceipt>("operations")
        .some(
          ([key, entry]) =>
            ownsTaskOperation(task, key) && ["pending", "uncertain"].includes(entry.state),
        );
      if (!unknown) task.pending = undefined;
      context.records.save(task);
    });
  }
}

/** Reconcile a lost reply from native user records; never replay an unknown write. */
async function recoverPreparedInputs(context: TaskContext, task: Task): Promise<void> {
  for (const [id, delivery] of context.store.entries<InputDelivery>("input_deliveries")) {
    if (delivery.taskId !== task.id || delivery.operationId !== id) continue;
    const operation = context.store.get<OperationReceipt>("operations", id);
    const unapplied =
      operation?.state === "done" &&
      (operation.result as Delivery | undefined)?.verified === true &&
      !context.store.get("task_input_applied", id);
    if (
      !operation ||
      (!unapplied && !["pending", "uncertain"].includes(operation.state)) ||
      operation.fingerprint !== delivery.fingerprint
    )
      continue;
    const participant = context.store.get<Participant>("participants", delivery.participantId);
    const execution = participant?.execution;
    if (
      !participant ||
      participant.taskId !== task.id ||
      !task.participantIds.includes(participant.id) ||
      !execution ||
      !participant.started ||
      participant.status === "removed" ||
      execution.paneId !== delivery.execution.paneId ||
      execution.workspaceId !== delivery.execution.workspaceId ||
      execution.kind !== delivery.execution.kind ||
      execution.cwd !== delivery.execution.cwd ||
      (execution.sessionId &&
        delivery.execution.sessionId &&
        execution.sessionId !== delivery.execution.sessionId)
    )
      continue;
    // Initial markers predate per-operation receipts. Preserve the existing
    // uniqueness guard for legacy operations that could share the same input.
    if (
      delivery.initial &&
      context.store
        .entries<OperationReceipt>("operations")
        .some(
          ([key, candidate]) =>
            key !== id &&
            ownsTaskOperation(task, key) &&
            ["pending", "uncertain"].includes(candidate.state) &&
            candidate.fingerprint === delivery.fingerprint,
        )
    )
      continue;
    const input = unapplied
      ? delivery.prompt
      : await context.herdr.initialInput?.(delivery.execution, delivery.receipt);
    assertActive(context);
    if (input !== delivery.prompt) continue;
    const result: Delivery = {
      status: "delivered",
      acked: false,
      verified: true,
      attempts: 1,
      detail: "原生会话 user 记录已确认本轮输入；未重新投递。",
    };
    context.store.transaction(() => {
      const current = context.store.get<OperationReceipt>("operations", id);
      if (
        !current ||
        current.fingerprint !== delivery.fingerprint ||
        (!unapplied && !["pending", "uncertain"].includes(current.state)) ||
        (unapplied && (current.state !== "done" || context.store.get("task_input_applied", id)))
      )
        return;
      context.store.set("operations", id, {
        ...current,
        state: "done",
        result: unapplied ? current.result : result,
        error: undefined,
        updatedAt: now(),
      });
      participant.initialSent = true;
      participant.error = undefined;
      execution.transcriptReceipt = participant.initialReceipt;
      const alreadySettled = context.store
        .list<{
          taskId: string;
          participantId: string;
          sequence?: number;
        }>("task_settled_outputs")
        .some(
          (output) =>
            output.taskId === task.id &&
            output.participantId === participant.id &&
            output.sequence !== undefined &&
            output.sequence > delivery.outputSequence,
        );
      if (!alreadySettled)
        context.store.set("participant_awaiting_output", participant.id, {
          operationId: id,
          at: now(),
        });
      context.store.set("task_input_applied", id, { at: now() });
      context.records.saveParticipant(participant);
      task.discussion.activeParticipant = participant.id;
      if (id.startsWith(`${task.id}:relay:`)) {
        task.discussion.nextParticipant = context.records
          .participants(task)
          .filter((entry) => entry.status !== "removed")
          .findIndex((entry) => entry.id === participant.id);
      }
      task.discussion.startedAt ??= now();
      const unknown = context.store
        .entries<OperationReceipt>("operations")
        .some(
          ([key, entry]) =>
            ownsTaskOperation(task, key) && ["pending", "uncertain"].includes(entry.state),
        );
      if (!unknown) {
        task.pending = undefined;
        if (
          !delivery.discussionWasPaused &&
          task.status === "attention" &&
          (delivery.pauseRevision ?? 0) ===
            (context.store.get<number>("task_pause_revision", task.id) ?? 0)
        ) {
          task.discussion.paused = false;
          task.error = undefined;
        }
      }
      context.records.save(task);
    });
  }
}
