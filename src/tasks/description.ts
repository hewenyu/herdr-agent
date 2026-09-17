import { isNotExecuted, OperationError } from "../core/errors.js";
import type { RemoteTask } from "../core/ports.js";
import type { Task } from "../core/types.js";
import { assertActive, type TaskContext } from "./context.js";

interface DescriptionReceipt {
  text: string;
  state: "sending" | "uncertain" | "done" | "not_executed";
}

/** A lost PATCH acknowledgement is resolved by GET, never by repeating the write. */
export async function syncDescription(
  context: TaskContext,
  task: Task,
  remote: RemoteTask,
  text: string,
): Promise<void> {
  const platform = context.platform;
  if (!platform || !task.remoteTaskId) return;
  const previous = context.store.get<DescriptionReceipt>("description_sync", task.id);
  if (previous && ["sending", "uncertain"].includes(previous.state)) {
    if (remote.description !== previous.text) {
      throw new OperationError(
        "description_unconfirmed",
        "任务描述同步结果未知，正在只读核对。",
        "unknown",
      );
    }
    context.store.set<DescriptionReceipt>("description_sync", task.id, {
      ...previous,
      state: "done",
    });
  }
  if (remote.description === text) return;
  assertActive(context);
  const intent: DescriptionReceipt = { text, state: "sending" };
  context.store.set("description_sync", task.id, intent);
  try {
    await platform.updateTask(task.remoteTaskId, text);
    context.store.set("description_sync", task.id, { ...intent, state: "done" });
  } catch (error) {
    context.store.set("description_sync", task.id, {
      ...intent,
      state: isNotExecuted(error) ? "not_executed" : "uncertain",
    });
    throw error;
  }
}
