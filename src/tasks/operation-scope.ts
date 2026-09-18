import type { Task } from "../core/types.js";

/** Migrated participants have independent IDs; their receipts still belong to this task. */
export function taskOperationPrefixes(task: Pick<Task, "id" | "participantIds">): string[] {
  return [task.id, ...task.participantIds].map((id) => `${id}:`);
}

export function ownsTaskOperation(task: Pick<Task, "id" | "participantIds">, id: string): boolean {
  return taskOperationPrefixes(task).some((prefix) => id.startsWith(prefix));
}
