import { fail } from "../core/errors.js";
import { canonical, newId, now, stableId } from "../core/ids.js";
import type { Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import { assertActive, type TaskContext } from "./context.js";
import { queueFinalDescription } from "./description.js";
import { observeTask } from "./observe.js";
import { ownsTaskOperation, taskOperationPrefixes } from "./operation-scope.js";
import { taskDescription } from "./prompts.js";
import { resolveGroupRetention } from "./retention.js";

export type TaskAction = "complete" | "close" | "destroy" | "reopen" | "retry" | "pause" | "resume";
export interface TaskActionOptions {
  keepGroup?: boolean;
  keepExecution?: boolean;
}

export function requestAction(
  context: TaskContext,
  task: Task,
  action: TaskAction,
  options: TaskActionOptions = {},
): Task {
  const closeRetainedGroup =
    task.status === "destroyed" &&
    !!task.chatId &&
    !task.groupDeleted &&
    options.keepGroup === false &&
    options.keepExecution === undefined &&
    (action === "destroy" ||
      (action === "close" && !!task.completedAt && task.completedAt !== "0"));
  if (task.status === "destroyed" && !closeRetainedGroup)
    fail("task_destroyed", "执行资源已关闭，不能重开；可创建关联的新任务。");
  if (
    options.keepExecution !== undefined &&
    (typeof options.keepExecution !== "boolean" || action !== "complete")
  )
    fail("task_execution_policy", "仅完成操作可指定是否保留执行现场，且必须为布尔值。");
  if (options.keepExecution && task.status === "destroying")
    fail("execution_cleanup_started", "执行资源已开始清理，不能再声明保留。");
  if (options.keepGroup !== undefined) {
    if (
      typeof options.keepGroup !== "boolean" ||
      !["complete", "close", "destroy"].includes(action)
    )
      fail("task_group_policy", "仅完成、关闭或销毁操作可指定是否保留任务群。");
    const deletion = context.store.get<OperationReceipt>("operations", `${task.id}:delete-group`);
    if (options.keepGroup && (task.groupDeleted || (deletion && deletion.state !== "failed")))
      fail("group_deletion_started", "任务群已解散或解散结果尚未确认，不能再声明保留。");
    task.keepGroup = options.keepGroup;
    task.groupRetentionSource = "explicit";
  }
  if (["complete", "close", "destroy"].includes(action)) resolveGroupRetention(context, task);
  if (
    options.keepExecution &&
    (task.createGroup || task.chatId) &&
    (!task.keepGroup || task.groupDeleted)
  )
    fail(
      "task_retention_conflict",
      "有任务群时，保留执行现场必须同时保留群；群关闭后必须通过 herdr 关闭执行资源。",
    );
  if (closeRetainedGroup) {
    // Execution is already gone. Reuse its close receipts and the normal group
    // deletion barrier without reopening work or changing acceptance history.
    task.status = "destroying";
    task.completionRequest = undefined;
    task.closeRequested = false;
    task.discussion.paused = true;
    context.records.save(task);
    return task;
  }
  // A repeated completion/close continues the already-confirmed cleanup; it must not
  // create another completion intent or reject the user's retry.
  if (
    task.status === "destroying" &&
    ["complete", "close"].includes(action) &&
    task.closeRequested
  ) {
    context.records.save(task);
    return task;
  }
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
      task.closeRequested = !options.keepExecution;
      task.discussion.paused = true;
      break;
    case "close":
      task.completionRequest = "complete";
      task.closeRequested = true;
      task.discussion.paused = true;
      break;
    case "destroy":
      task.status = "destroying";
      // Destroy is resource cleanup, independently of remote task acceptance.
      // Retain completion_sync and its operation receipt for auditing an unknown
      // remote write, but stop driving that superseded lifecycle transition.
      task.completionRequest = undefined;
      task.closeRequested = false;
      task.syncError = undefined;
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
      context.store.transaction(() => {
        for (const prefix of taskOperationPrefixes(task)) context.operations.resetFailed(prefix);
      });
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
      description: completionDescription(context, task),
    });
  }
  context.records.save(task);
  return task;
}

export async function syncGroupState(context: TaskContext, task: Task): Promise<void> {
  assertActive(context);
  let observedDissolved = false;
  if (task.chatId && !task.groupDeleted && context.platform?.getGroupStatus) {
    const status = await context.platform.getGroupStatus(task.chatId);
    assertActive(context);
    observedDissolved = status === "dissolved";
  }
  if (!task.groupDeleted && !observedDissolved) return;
  const previousFinal = context.store.get<{ completionObserved?: boolean }>(
    "final_description_sync",
    task.id,
  );
  const updated: Task = {
    ...task,
    groupDeleted: true,
    // A task that already finished executor cleanup has no remaining local
    // resource to destroy. An externally dissolved retained group only updates
    // the group fact; never reopen or re-enter the cleanup lifecycle.
    status: task.status === "destroyed" ? "destroyed" : "destroying",
    completionRequest: undefined,
    closeRequested: false,
    discussion: { ...task.discussion, paused: true },
  };
  context.store.transaction(() => {
    if (observedDissolved) confirmGroupDeletion(context, updated);
    context.records.save(updated);
    if (observedDissolved && task.status === "destroyed")
      // The terminal projection may already have been marked done while the
      // retained group was alive. Rebuild it so remote task text no longer
      // advertises a dissolved group link.
      queueFinalDescription(context, updated, previousFinal?.completionObserved);
  });
  Object.assign(task, updated);
}

/** GET proves the target state, not that the original DELETE was acknowledged. */
function confirmGroupDeletion(context: TaskContext, task: Task): void {
  const id = `${task.id}:delete-group`;
  const receipt = context.store.get<OperationReceipt>("operations", id);
  if (!receipt || !["pending", "uncertain"].includes(receipt.state)) return;
  if (receipt.id !== id || receipt.fingerprint !== stableId(canonical({ chat: task.chatId })))
    fail("operation_conflict", "删群回执与当前绑定群不匹配，未确认该操作。");
  const otherUnresolved = context.store
    .entries<OperationReceipt>("operations")
    .some(([key, value]) => key !== id && ownsTaskOperation(task, key) && value.state !== "done");
  const pendingDelivery = context.store
    .list<{ chatId: string; state: string }>("outbox")
    .some((value) => value.chatId === task.chatId && value.state !== "delivered");
  if (
    receipt.error &&
    task.error === receipt.error.message &&
    !otherUnresolved &&
    !pendingDelivery &&
    !context.records.participants(task).some((participant) => participant.error)
  )
    task.error = undefined;
  const observedAt = now();
  context.store.set("operations", id, {
    ...receipt,
    state: "done",
    error: undefined,
    result: {
      confirmedBy: "group_status",
      chatId: task.chatId,
      status: "dissolved",
      observedAt,
      previousState: receipt.state,
      previousError: receipt.error,
    },
    updatedAt: observedAt,
  });
}

export async function syncCompletion(context: TaskContext, task: Task): Promise<void> {
  assertActive(context);
  // Also protects persisted cleanup from older versions with a pending intent.
  if (["destroying", "destroyed"].includes(task.status)) return;
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
      description: completionDescription(context, task),
    };
    context.store.set("completion_sync", task.id, target);
  }
  // Older receipts did not store their description. Only capture one if no
  // write was attempted; an uncertain legacy request must not acquire guessed text.
  if (target.description === undefined && !context.store.get("operations", target.id)) {
    target.description = completionDescription(context, task);
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

function completionDescription(context: TaskContext, task: Task): string {
  return taskDescription(
    { ...task, status: task.completionRequest === "complete" ? "completed" : "review" },
    context.records.participants(task),
  );
}

export async function closeTask(context: TaskContext, task: Task): Promise<void> {
  assertActive(context);
  if (task.closeRequested && task.status !== "destroying") {
    if (task.status !== "completed" || task.completionRequest) return;
    task.status = "destroying";
    context.records.save(task);
  }
  if (task.status !== "destroying") return;
  resolveGroupRetention(context, task);
  // Read and durably deliver the last result before deleting its execution source.
  // Destroying state prevents this observation from starting another discussion turn.
  await observeTask(context, task);
  if (!task.groupDeleted && !context.store.get("task_close_notice", task.id)) {
    const outcome = await context.hooks.notice?.(task, "before_close");
    assertActive(context);
    context.store.set("task_close_notice", task.id, {
      at: now(),
      outcome: outcome ?? { status: "processed" },
    });
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
  if (!(await deleteTaskGroup(context, task))) return;
  task.status = "destroyed";
  task.completionRequest = undefined;
  task.pending = undefined;
  task.syncError = undefined;
  context.store.transaction(() => {
    context.records.save(task);
    queueFinalDescription(context, task);
  });
}

/** Group deletion is the final cleanup step, after herdr confirms all owned panes closed. */
export async function deleteTaskGroup(context: TaskContext, task: Task): Promise<boolean> {
  assertActive(context);
  if (!task.chatId || task.keepGroup || task.groupDeleted) return true;
  if (
    context.records
      .participants(task)
      .some(
        (participant) => participant.execution && !["gone", "removed"].includes(participant.status),
      )
  )
    fail("task_execution_pending", "执行资源尚未通过 herdr 确认关闭，任务群不能解散。");
  if (!context.platform) fail("platform_unavailable", "飞书连接不可用，群清理等待恢复。");
  const ready = async () => {
    if ((await context.hooks.canDeleteGroup?.(task)) === false) {
      task.syncError = "群内输入或通知尚未确认完成，任务群等待解散。";
      context.records.save(task);
      return false;
    }
    return true;
  };
  if (!(await ready())) return false;
  if (!context.store.get("task_group_delete_notice", task.id)) {
    const outcome = await context.hooks.notice?.(task, "before_group_delete");
    assertActive(context);
    context.store.set("task_group_delete_notice", task.id, {
      at: now(),
      outcome: outcome ?? { status: "processed" },
    });
  }
  // The notice can introduce a new pending delivery; inspect the barrier again.
  if (!(await ready())) return false;
  assertActive(context);
  if (
    context.store.get<OperationReceipt>("operations", `${task.id}:delete-group`)?.state === "failed"
  )
    context.operations.resetFailed(`${task.id}:delete-group`);
  await context.operations.run(
    `${task.id}:delete-group`,
    { chat: task.chatId },
    () => context.platform?.deleteGroup(task.chatId as string) as Promise<void>,
  );
  task.groupDeleted = true;
  task.syncError = undefined;
  context.records.save(task);
  return true;
}
