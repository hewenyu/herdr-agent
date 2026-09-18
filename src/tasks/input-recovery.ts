import { canonical, now, stableId } from "../core/ids.js";
import type { Delivery, Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import { assertActive, type TaskContext } from "./context.js";
import { participantPrompt } from "./prompts.js";

/** Resolve only a unique initial delivery proved by native user input; never send again. */
export async function recoverInitialInputs(context: TaskContext, task: Task): Promise<void> {
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
    const prefix = participantPrompt(task, participant);
    const initialFingerprint = stableId(canonical({ receipt: participant.initialReceipt }));
    const legacyPrefix = `${prefix}\n\n本轮安排：\n`;
    const receiptSuffix = `\n\n投递标识（无需复述）：\n${participant.initialReceipt}`;
    const arrangedPrefix = `${prefix.slice(0, -receiptSuffix.length)}\n\n本轮安排：\n`;
    const arrangement = input.startsWith(legacyPrefix)
      ? input.slice(legacyPrefix.length)
      : input.startsWith(arrangedPrefix) && input.endsWith(receiptSuffix)
        ? input.slice(arrangedPrefix.length, -receiptSuffix.length)
        : undefined;
    const fingerprint =
      arrangement === undefined
        ? undefined
        : stableId(canonical({ participant: participant.id, text: arrangement }));
    const matches = operations.filter(([id, operation]) =>
      id === `${participant.id}:initial`
        ? input === prefix && operation.fingerprint === initialFingerprint
        : fingerprint !== undefined && operation.fingerprint === fingerprint,
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
            key.startsWith(`${task.id}:`) && ["pending", "uncertain"].includes(entry.state),
        );
      if (!unknown) task.pending = undefined;
      context.records.save(task);
    });
  }
}
