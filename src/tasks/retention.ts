import type { Task } from "../core/types.js";
import type { TaskContext } from "./context.js";

interface RecordedAction {
  action: string;
  keepGroup?: boolean;
  keepExecution?: boolean;
  at: string;
}

function actions(context: TaskContext, task: Task): RecordedAction[] {
  return context.store
    .entries<RecordedAction>("task_actions")
    .filter(
      ([key, value]) =>
        key.startsWith(`${task.id}:`) && ["complete", "close", "destroy"].includes(value.action),
    )
    .map(([, value]) => value)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Resolve only at an authorized cleanup transition, never while an old task is active. */
export function resolveGroupRetention(context: TaskContext, task: Task): boolean {
  if (task.groupRetentionSource === "explicit" || task.groupRetentionSource === "default")
    return false;
  const evidence = actions(context, task)
    .filter(
      (action) =>
        typeof action.keepGroup === "boolean" || (action.keepExecution === true && task.keepGroup),
    )
    .at(-1);
  task.keepGroup = evidence ? (evidence.keepGroup ?? true) : false;
  task.groupRetentionSource = evidence ? "explicit" : "default";
  return true;
}

/** Old completed tasks retain execution only when a durable completion action explicitly asked for it. */
export function resolveCompletedRetention(context: TaskContext, task: Task): void {
  if (!resolveGroupRetention(context, task)) return;
  const completion = actions(context, task).at(-1);
  const retained = completion?.action === "complete" && completion.keepExecution === true;
  task.closeRequested = !retained || (!!task.chatId && !task.keepGroup);
}
