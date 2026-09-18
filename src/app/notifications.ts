import type { Participant } from "../core/types.js";

/** Runtime/receipt state is not proof of a captured utterance or its delivery to the user. */
export function notificationParticipants(participants: Participant[]) {
  return participants.map((participant) => ({
    id: participant.id,
    name: participant.name,
    kind: participant.kind,
    role: participant.role,
    status: participant.status,
    started: participant.started,
    initialSent: participant.initialSent,
    hasNativeSessionId: !!participant.execution?.sessionId,
    hasOutput: !!participant.lastOutput?.trim(),
    lastOutput: participant.lastOutput?.trim() ? participant.lastOutput : null,
    error: participant.error ?? null,
    sessionNote: participant.sessionNote ?? null,
  }));
}
