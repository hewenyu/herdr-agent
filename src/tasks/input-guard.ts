import { assertTaskIngress, taskIngress } from "../app/task-ingress.js";
import { fail } from "../core/errors.js";
import type { Participant, Task } from "../core/types.js";
import { assertActive, type TaskContext } from "./context.js";

/** Also protects manual/round-robin inputs while remote lifecycle reads wait on our lock. */
export function inputGuard(
  context: TaskContext,
  task: Task,
  participant: Participant,
  beforeSend?: () => void,
): () => void {
  const revision = taskIngress(context.store, task, true).revision;
  const ref = participant.execution;
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
      !ref ||
      !latest.participantIds.includes(current.id) ||
      ["removed", "gone"].includes(current.status) ||
      current.execution?.paneId !== ref.paneId ||
      current.execution.workspaceId !== ref.workspaceId ||
      current.execution.kind !== ref.kind ||
      current.execution.cwd !== ref.cwd ||
      current.execution.sessionId !== ref.sessionId
    )
      fail("participant_unavailable", "参与者执行位置已变化，未开始新的执行输入。");
    assertTaskIngress(context.store, latest, revision, true);
  };
}
