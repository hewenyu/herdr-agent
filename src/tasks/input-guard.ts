import { assertTaskIngress, taskIngress } from "../app/task-ingress.js";
import { fail } from "../core/errors.js";
import type { Participant, Task } from "../core/types.js";
import { assertActive, type TaskContext } from "./context.js";
import { executorHeld } from "./pause.js";
import { startupTrustStatus } from "./readiness.js";

/** Also protects manual/round-robin inputs while remote lifecycle reads wait on our lock. */
export function inputGuard(
  context: TaskContext,
  task: Task,
  participant: Participant,
  beforeSend?: () => void,
): () => void {
  const revision = taskIngress(context.store, task, true).revision;
  const ref = participant.execution;
  const generation = participant.executionRecovery;
  return () => {
    assertActive(context);
    beforeSend?.();
    const latest = context.store.get<Task>("tasks", task.id);
    const current = context.store.get<Participant>("participants", participant.id);
    if (
      !latest ||
      latest.completionRequest ||
      latest.closeRequested ||
      latest.groupDeleted ||
      ["completed", "destroying", "destroyed", "paused"].includes(latest.status)
    )
      fail("task_not_running", "任务已暂停或结束，未开始新的执行输入。");
    if (
      !current ||
      executorHeld(context.store, participant.id) ||
      !ref ||
      !latest.participantIds.includes(current.id) ||
      ["removed", "gone"].includes(current.status) ||
      // A concurrent repair must not let an in-flight send land on a replacement.
      current.executionRecovery !== generation ||
      current.execution?.paneId !== ref.paneId ||
      current.execution.workspaceId !== ref.workspaceId ||
      current.execution.kind !== ref.kind ||
      current.execution.cwd !== ref.cwd ||
      current.execution.sessionId !== ref.sessionId
    )
      fail("participant_unavailable", "参与者执行位置已变化，未开始新的执行输入。");
    if (startupTrustStatus(context.store, current).frozen)
      fail("executor_not_ready", "执行器的原生确认结果未明确，未开始新的业务输入。");
    assertTaskIngress(context.store, latest, revision, true);
  };
}

/**
 * Lifecycle launch admission, deliberately independent of the business pause.
 * Owner revocation, completion/close/group deletion, shutdown and a changed
 * target generation all veto the native start even though a business pause does
 * not. Returns a synchronous check usable immediately before the write.
 */
export function launchGuard(
  context: TaskContext,
  task: Task,
  participant: Participant,
): () => void {
  const generation = participant.executionRecovery;
  const execution = participant.execution ? { ...participant.execution } : undefined;
  return () => {
    assertActive(context);
    const latest = context.store.get<Task>("tasks", task.id);
    const current = context.store.get<Participant>("participants", participant.id);
    if (
      !latest ||
      !current ||
      executorHeld(context.store, participant.id) ||
      context.controlPending?.(task.id) ||
      !context.config.feishu.allowedOpenIds.includes(latest.ownerId) ||
      latest.closeRequested ||
      latest.completionRequest ||
      latest.groupDeleted ||
      ["completed", "destroying", "destroyed"].includes(latest.status) ||
      !latest.participantIds.includes(participant.id) ||
      current.status === "removed" ||
      current.taskId !== latest.id ||
      current.executionRecovery !== generation ||
      current.execution?.paneId !== execution?.paneId ||
      current.execution?.workspaceId !== execution?.workspaceId ||
      current.execution?.kind !== execution?.kind ||
      current.execution?.cwd !== execution?.cwd
    )
      fail("lifecycle_revoked", "启动授权或任务状态已变化，未启动执行器。");
    assertTaskIngress(context.store, latest, undefined, true);
  };
}
