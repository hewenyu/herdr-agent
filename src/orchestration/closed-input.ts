import { canonical, stableId } from "../core/ids.js";
import type { Participant, Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import type { Store } from "../storage/store.js";
import type { InputDelivery } from "../tasks/input-delivery.js";

/** A closed execution no longer reserves files; its input outcome stays unknown. */
export function inputExecutionClosed(
  store: Store,
  task: Task,
  operationId: string,
  receipt: OperationReceipt,
): boolean {
  if (
    !["destroying", "destroyed"].includes(task.status) ||
    !task.discussion.paused ||
    receipt.state !== "uncertain" ||
    receipt.id !== operationId
  )
    return false;
  const delivery = store.get<InputDelivery>("input_deliveries", operationId);
  if (
    !delivery ||
    delivery.operationId !== operationId ||
    delivery.taskId !== task.id ||
    !delivery.fingerprint ||
    delivery.fingerprint !== receipt.fingerprint ||
    !task.participantIds.includes(delivery.participantId)
  )
    return false;
  const participant = store.get<Participant>("participants", delivery.participantId);
  if (
    !participant ||
    participant.id !== delivery.participantId ||
    participant.taskId !== task.id ||
    !["gone", "removed"].includes(participant.status) ||
    !participant.execution ||
    !delivery.execution?.paneId ||
    !delivery.execution.workspaceId ||
    canonical(participant.execution) !== canonical(delivery.execution)
  )
    return false;
  const closeId = `${participant.id}:close`;
  const close = store.get<OperationReceipt>("operations", closeId);
  const inputAt = Date.parse(receipt.updatedAt);
  const closedAt = Date.parse(close?.updatedAt ?? "");
  return (
    close?.id === closeId &&
    close.state === "done" &&
    close.fingerprint === stableId(canonical(delivery.execution)) &&
    Number.isFinite(inputAt) &&
    Number.isFinite(closedAt) &&
    closedAt > inputAt
  );
}
