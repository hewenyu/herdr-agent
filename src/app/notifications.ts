import type { Participant, Task } from "../core/types.js";
import { readinessOf } from "../tasks/readiness.js";
import type { ParticipantProjection } from "../tasks/records.js";

/** Notices start with lifecycle facts; historical business text remains available via task_get. */
export function notificationTask(task: Task) {
  return {
    id: task.id,
    title: task.title,
    kind: task.kind,
    status: task.status,
    completedAt: task.completedAt,
    completionRequest: task.completionRequest,
    closeRequested: task.closeRequested,
    createGroup: task.createGroup,
    createRemoteTask: task.createRemoteTask,
    remoteTaskId: task.remoteTaskId,
    remoteTaskUrl: task.remoteTaskUrl,
    chatId: task.chatId,
    groupDeleted: task.groupDeleted,
    keepGroup: task.keepGroup,
    groupRetentionSource: task.groupRetentionSource,
    worktreeReady: task.worktreeReady,
    discussion: { ...task.discussion },
    orchestration: task.orchestration,
    error: task.error,
    syncError: task.syncError,
    pending: task.pending,
    updatedAt: task.updatedAt,
    remoteCheckedAt: task.remoteCheckedAt,
  };
}

/** Runtime/receipt state is not proof of a captured utterance or its delivery to the user. */
export function notificationParticipants(
  participants: Array<Participant & Partial<Pick<ParticipantProjection, "initialDelivery">>>,
) {
  return participants.map((participant) => ({
    id: participant.id,
    name: participant.name,
    kind: participant.kind,
    status: participant.status,
    started: participant.started,
    initialSent: participant.initialSent,
    ...(participant.initialDelivery === undefined
      ? {}
      : { initialDelivery: participant.initialDelivery }),
    // Managed-execution readiness, so a notice never implies fully ready while
    // a startup trust or manual menu is still pending.
    readiness: readinessOf(participant).phase,
    hasNativeSessionId: !!participant.execution?.sessionId,
    hasOutput: !!participant.lastOutput?.trim(),
    error: participant.error ?? null,
    sessionNote: participant.sessionNote ?? null,
  }));
}
