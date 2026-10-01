import type { Participant, Task } from "../core/types.js";
import type { Store } from "../storage/store.js";

/**
 * Business scheduling and agent lifecycle are two independent state machines.
 *
 * A business pause fences BUSINESS input, relays and dispatch only. It must
 * never stop lifecycle observation, provisioning/repair, or the tightly scoped
 * already-authorized startup directory trust. The reverse is also true: a
 * lifecycle repair pause does not mean the user paused the task, and an
 * intentionally stopped executor must not be resurrected by a plain pause.
 */

const userPause = "task_user_pause";
const executorHolds = "executor_holds";

interface UserPause {
  taskId: string;
  at: string;
}

/** An explicit user control (pause/interrupt/removal/restart), not automatic repair. */
export function markUserPause(store: Store, task: Task): void {
  store.set<UserPause>(userPause, task.id, { taskId: task.id, at: new Date().toISOString() });
}

export function clearUserPause(store: Store, taskId: string): void {
  store.delete(userPause, taskId);
}

export function userPauseMarked(store: Store, taskId: string): boolean {
  return store.get<UserPause>(userPause, taskId) !== undefined;
}

/**
 * Whether business input/dispatch is currently fenced. Repair pauses, manual
 * scheduling pauses and explicit user pauses all count here; none of them are
 * a lifecycle gate, and none of them stop execution repair.
 */
export function businessPaused(task: Task): boolean {
  return task.discussion.paused || task.status === "paused";
}

/**
 * Whether the task still owns a lifecycle that may be observed, provisioned or
 * repaired. Terminal and closing states are excluded; `paused` deliberately is
 * NOT excluded, because a business pause must not stop the agent lifecycle.
 */
export function lifecycleActive(task: Task): boolean {
  return !(
    ["completed", "destroying", "destroyed"].includes(task.status) ||
    task.closeRequested ||
    task.completionRequest ||
    task.groupDeleted
  );
}

interface ExecutorHold {
  taskId: string;
  participantId: string;
  reason: string;
  at: string;
}

/**
 * An executor-specific hold for a resource the user explicitly stopped
 * (interrupt or removal). It is deliberately distinct from `discussion.paused`:
 * pausing the business does not hold an executor, and holding one executor must
 * not defer a peer's repair.
 */
export function holdExecutor(store: Store, participant: Participant, reason: string): void {
  const at = new Date().toISOString();
  store.transaction(() => {
    store.set<ExecutorHold>(executorHolds, participant.id, {
      taskId: participant.taskId,
      participantId: participant.id,
      reason,
      at,
    });
    participant.readiness = {
      phase: "stopped",
      reason,
      at,
      generation: participant.executionRecovery ?? "initial",
      paneId: participant.execution?.paneId,
      workspaceId: participant.execution?.workspaceId,
    };
    store.set("participants", participant.id, participant);
  });
}

export function releaseExecutor(store: Store, participant: Participant): void {
  store.delete(executorHolds, participant.id);
  if (participant.readiness?.phase === "stopped") {
    participant.readiness = {
      ...participant.readiness,
      phase: "uncertain",
      reason: "执行器停止已解除，等待现场核验。",
      at: new Date().toISOString(),
    };
    store.set("participants", participant.id, participant);
  }
}

export function executorHeld(store: Store, participantId: string): boolean {
  return store.get<ExecutorHold>(executorHolds, participantId) !== undefined;
}

/** An explicit user resume or a fresh arrangement lifts that executor's hold. */
export function releaseHeldExecutors(store: Store, task: Task): void {
  for (const id of task.participantIds) {
    const participant = store.get<Participant>("participants", id);
    if (participant) releaseExecutor(store, participant);
    else store.delete(executorHolds, id);
  }
}
