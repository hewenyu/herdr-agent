import type { Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import type { Store } from "../storage/store.js";

/** Migrated participants have independent IDs; their receipts still belong to this task. */
export function taskOperationPrefixes(task: Pick<Task, "id" | "participantIds">): string[] {
  return [task.id, ...task.participantIds].map((id) => `${id}:`);
}

export function ownsTaskOperation(task: Pick<Task, "id" | "participantIds">, id: string): boolean {
  return taskOperationPrefixes(task).some((prefix) => id.startsWith(prefix));
}

/** Only an audited, completed replacement can retire an unknown native input. */
export function activeTaskOperation(
  store: Store,
  task: Task,
  id: string,
  receipt: OperationReceipt,
): boolean {
  if (!ownsTaskOperation(task, id)) return false;
  const restart = receipt.retiredByRestart
    ? store.get<{ taskId: string; state: string; operationIds: string[] }>(
        "task_restarts",
        receipt.retiredByRestart,
      )
    : undefined;
  return !(
    restart?.taskId === task.id &&
    restart.state === "done" &&
    Array.isArray(restart.operationIds) &&
    restart.operationIds.every((entry) => typeof entry === "string" && entry.length > 0) &&
    restart.operationIds.includes(id)
  );
}
