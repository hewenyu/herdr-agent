import { fail } from "../core/errors.js";
import { newId, now } from "../core/ids.js";
import type { Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import { assertActive, type TaskContext } from "./context.js";
import { observeTask } from "./observe.js";
import { taskDescription } from "./prompts.js";

export type TaskAction = "complete" | "close" | "destroy" | "reopen" | "retry" | "pause" | "resume";

export function requestAction(context: TaskContext, task: Task, action: TaskAction): Task {
  if (task.status === "destroyed")
    fail("task_destroyed", "执行资源已关闭，不能重开；可创建关联的新任务。");
  if (task.status === "destroying" && action !== "destroy")
    fail("task_destroying", "任务已进入资源清理，不能更改动作。");
  if (task.status === "completed" && ["pause", "resume", "retry"].includes(action))
    fail("task_completed", "已完成任务需要先重开。");
  const requested = ["complete", "close"].includes(action)
    ? "complete"
    : action === "reopen"
      ? "reopen"
      : undefined;
  const pending = task.completionRequest
    ? context.store.get<{ id: string; request: string }>("completion_sync", task.id)
    : undefined;
  const attempted = pending
    ? context.store.get<OperationReceipt>("operations", pending.id)
    : undefined;
  if (
    requested &&
    pending &&
    pending.request !== requested &&
    attempted &&
    attempted.state !== "failed"
  )
    fail("completion_pending", "前次完成状态同步尚未确认，请先核对，不能改为相反操作。");
  const reuseCompletion = requested && pending?.request === requested;
  if (reuseCompletion && attempted?.state === "failed") context.operations.resetFailed(pending.id);
  switch (action) {
    case "complete":
      task.completionRequest = "complete";
      task.discussion.paused = true;
      break;
    case "close":
      task.completionRequest = "complete";
      task.closeRequested = true;
      task.discussion.paused = true;
      break;
    case "destroy":
      task.status = "destroying";
      task.discussion.paused = true;
      break;
    case "reopen":
      task.completionRequest = "reopen";
      task.closeRequested = false;
      task.discussion.paused = true;
      break;
    case "retry":
      if (task.status === "completed" || task.closeRequested)
        fail("task_completed", "请先重开已完成任务。");
      context.operations.resetFailed(`${task.id}:`);
      task.error = undefined;
      task.pending = undefined;
      task.status = "starting";
      break;
    case "pause":
      task.discussion.paused = true;
      task.status = "paused";
      break;
    case "resume":
      if (task.status === "completed") fail("task_completed", "已完成任务需要先重开。");
      task.discussion.paused = false;
      task.discussion.rounds = 0;
      task.discussion.startedAt = now();
      task.status = "review";
      break;
    default:
      fail("task_action", "未知任务操作。");
  }
  if (requested && !reuseCompletion) {
    context.store.set("completion_sync", task.id, {
      id: `${task.id}:completion:${newId("c")}`,
      request: task.completionRequest,
      completedAt: task.completionRequest === "complete" ? String(Date.now()) : "0",
      description: taskDescription(task, context.records.participants(task)),
    });
  }
  context.records.save(task);
  return task;
}

export async function syncCompletion(context: TaskContext, task: Task): Promise<void> {
  assertActive(context);
  if (!task.completionRequest) return;
  let target = context.store.get<{
    id: string;
    request: string;
    completedAt: string;
    description?: string;
  }>("completion_sync", task.id);
  if (!target || target.request !== task.completionRequest) {
    target = {
      id: `${task.id}:completion:${newId("c")}`,
      request: task.completionRequest,
      completedAt: task.completionRequest === "complete" ? String(Date.now()) : "0",
      description: taskDescription(task, context.records.participants(task)),
    };
    context.store.set("completion_sync", task.id, target);
  }
  // Older receipts did not store their description. Only capture one if no
  // write was attempted; an uncertain legacy request must not acquire guessed text.
  if (target.description === undefined && !context.store.get("operations", target.id)) {
    target.description = taskDescription(task, context.records.participants(task));
    context.store.set("completion_sync", task.id, target);
  }
  let confirmedAt = target.completedAt;
  if (task.remoteTaskId) {
    const platform = context.platform;
    if (!platform) fail("platform_unavailable", "飞书连接不可用，完成状态等待同步。");
    // A lost PATCH acknowledgement is resolved by reading the desired state,
    // not repeating the write. The operation receipt controls any actual PATCH.
    let remote = await platform.getTask(task.remoteTaskId);
    const completed = () => !!remote.completedAt && remote.completedAt !== "0";
    if (completed() !== (task.completionRequest === "complete")) {
      const taskId = task.remoteTaskId;
      const completedAt = target.completedAt;
      const description = target.description;
      await context.operations.run(target.id, { taskId, completedAt }, () =>
        platform.updateTask(
          taskId,
          description ?? taskDescription(task, context.records.participants(task)),
          completedAt,
        ),
      );
      remote = await platform.getTask(taskId);
      if (completed() !== (task.completionRequest === "complete")) {
        task.syncError = "飞书完成状态尚未确认，稍后只重试查询。";
        context.records.save(task);
        return;
      }
    }
    confirmedAt = remote.completedAt;
    const attempted = context.store.get<OperationReceipt>("operations", target.id);
    // Completion can supersede an older description intent, but only a GET
    // that observes the exact submitted text proves the new projection exists.
    if (
      attempted &&
      target.description !== undefined &&
      remote.description === target.description
    ) {
      context.store.set("description_sync", task.id, { text: target.description, state: "done" });
    }
    if (attempted && ["pending", "uncertain"].includes(attempted.state)) {
      context.store.set("operations", target.id, {
        ...attempted,
        state: "done",
        error: undefined,
        updatedAt: now(),
      });
    }
  }
  task.status = task.completionRequest === "complete" ? "completed" : "review";
  task.completedAt = task.completionRequest === "complete" ? confirmedAt : undefined;
  task.completionRequest = undefined;
  task.syncError = undefined;
  context.records.save(task);
}

export async function closeTask(context: TaskContext, task: Task): Promise<void> {
  assertActive(context);
  if (task.closeRequested && task.status !== "destroying") {
    if (task.status !== "completed" || task.completionRequest) return;
    task.status = "destroying";
    context.records.save(task);
  }
  if (task.status !== "destroying") return;
  // Read and durably deliver the last result before deleting its execution source.
  // Destroying state prevents this observation from starting another discussion turn.
  await observeTask(context, task);
  if (!context.store.get("task_close_notice", task.id)) {
    await context.hooks.notice?.(task, "before_close");
    context.store.set("task_close_notice", task.id, { at: now() });
  }
  // Persist results and intent before any resource deletion.
  context.records.save(task);
  for (const participant of context.records.participants(task)) {
    assertActive(context);
    if (!participant.execution || participant.status === "removed") continue;
    if (
      context.store.get<OperationReceipt>("operations", `${participant.id}:close`)?.state ===
      "failed"
    ) {
      context.operations.resetFailed(`${participant.id}:close`);
    }
    await context.operations.run(`${participant.id}:close`, participant.execution, () =>
      context.herdr.close(participant.execution as NonNullable<typeof participant.execution>),
    );
    participant.status = "gone";
    context.records.saveParticipant(participant);
  }
  if (task.chatId && !task.keepGroup && !task.groupDeleted) {
    if (!context.platform) fail("platform_unavailable", "飞书连接不可用，群清理等待恢复。");
    if (
      context.store.get<OperationReceipt>("operations", `${task.id}:delete-group`)?.state ===
      "failed"
    ) {
      context.operations.resetFailed(`${task.id}:delete-group`);
    }
    await context.operations.run(
      `${task.id}:delete-group`,
      { chat: task.chatId },
      () => context.platform?.deleteGroup(task.chatId as string) as Promise<void>,
    );
    task.groupDeleted = true;
  }
  task.status = "destroyed";
  task.pending = undefined;
  context.records.save(task);
}
