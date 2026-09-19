import { isNotExecuted, OperationError, safeError } from "../core/errors.js";
import type { RemoteTask } from "../core/ports.js";
import type { Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import { assertActive, type TaskContext } from "./context.js";
import { taskDescription } from "./prompts.js";

interface DescriptionReceipt {
  text: string;
  state: "sending" | "uncertain" | "done" | "not_executed";
}

interface FinalDescription {
  text: string;
  state: "pending" | "done";
  completionObserved?: boolean;
}

/** Called in the same transaction that records newly completed resource cleanup. */
export function queueFinalDescription(
  context: TaskContext,
  task: Task,
  completionObserved?: boolean,
): void {
  if (!task.remoteTaskId) return;
  const intent: FinalDescription = {
    text: taskDescription(task, context.records.participants(task)),
    state: "pending",
  };
  if (completionObserved !== undefined) intent.completionObserved = completionObserved;
  context.store.set("final_description_sync", task.id, intent);
}

export function hasFinalDescription(context: TaskContext, task: Task): boolean {
  return (
    context.store.get<FinalDescription>("final_description_sync", task.id)?.state === "pending"
  );
}

/** Terminal tasks retry only this projection; failures cannot undo or block cleanup. */
export async function syncFinalDescription(context: TaskContext, task: Task): Promise<void> {
  const intent = context.store.get<FinalDescription>("final_description_sync", task.id);
  if (task.status !== "destroyed" || intent?.state !== "pending" || !task.remoteTaskId) return;
  try {
    assertActive(context);
    const platform = context.platform;
    if (!platform)
      throw new OperationError("platform_unavailable", "飞书连接不可用，最终描述等待同步。");
    const remote = await platform.getTask(task.remoteTaskId);
    assertActive(context);
    const completion = context.store.get<{ id: string; description?: string; completedAt: string }>(
      "completion_sync",
      task.id,
    );
    const attempted = completion
      ? context.store.get<OperationReceipt>("operations", completion.id)
      : undefined;
    if (
      !intent.completionObserved &&
      completion &&
      attempted &&
      ["pending", "uncertain"].includes(attempted.state)
    ) {
      // Destroy may abandon an unknown completion. Do not race that write or infer
      // acceptance from cleanup; preserve its receipt even when GET sees its payload.
      if (
        completion.description === undefined ||
        remote.description !== completion.description ||
        remote.completedAt !== completion.completedAt
      )
        throw new OperationError(
          "completion_unconfirmed",
          "完成同步结果未知，最终描述等待只读核对。",
          "unknown",
        );
      const confirmedDescription = completion.description;
      intent.completionObserved = true;
      context.store.transaction(() => {
        context.store.set<DescriptionReceipt>("description_sync", task.id, {
          text: confirmedDescription,
          state: "done",
        });
        context.store.set("final_description_sync", task.id, intent);
      });
    }
    await syncDescription(context, task, remote, intent.text);
    context.store.transaction(() => {
      context.store.set<FinalDescription>("final_description_sync", task.id, {
        ...intent,
        state: "done",
      });
      task.syncError = undefined;
      context.records.save(task);
    });
  } catch (error) {
    if (error instanceof OperationError && error.code === "stopping") throw error;
    task.syncError = safeError(error).message;
    context.records.save(task);
  }
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
