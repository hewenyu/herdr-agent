import type { Participant, Task } from "../core/types.js";

/** These facts must come from the service, never from model-generated text. */
export interface LifecycleEvidence {
  task: Pick<
    Task,
    | "id"
    | "status"
    | "chatId"
    | "groupDeleted"
    | "keepGroup"
    | "groupRetentionSource"
    | "closeRequested"
    | "completionRequest"
    | "pending"
    | "error"
    | "syncError"
  >;
  participants: Array<
    Pick<Participant, "id" | "name" | "kind" | "status" | "started"> & {
      execution?: unknown;
    }
  >;
}

const completed =
  /(?:已|成功|完毕|完了|结束了|关闭了|解散了|清理好了|\b(?:closed|terminated|deleted|dissolved|completed|finished|done)\b)/iu;
const cleanup =
  /(?:完成.{0,12}(?:收尾|清理)|(?:收尾|清理).{0,16}(?:完成|完毕|结束|好了)|(?:全部|所有|一切).{0,16}(?:处理完|完成|结束|关闭|清理完)|\b(?:cleanup|clean[ -]?up).{0,20}(?:complete|completed|finished|done)|\b(?:all|everything).{0,20}(?:done|finished|closed)\b)/iu;
const groupClosed =
  /(?:群|\b(?:group|chat)\b).{0,20}(?:解散|删除|关闭|dissolved|deleted|closed)|(?:解散|删除|关闭|dissolved|deleted|closed).{0,20}(?:群|\b(?:group|chat)\b)/iu;
const executionClosed =
  /(?:Claude|Codex|执行器|执行资源|参与者|会话|进程|session|agent).{0,24}(?:关闭|退出|终止|回收|closed|terminated)|(?:关闭|退出|终止|回收|closed|terminated).{0,24}(?:Claude|Codex|执行器|执行资源|参与者|会话|进程|session|agent)|(?:执行器|执行资源|会话|进程|session).{0,16}结束|结束.{0,16}(?:执行器|执行资源|会话|进程|session)/iu;

/** Reject unsupported lifecycle assertions without selecting tools or composing a reply. */
export function unsupportedLifecycleClaim(text: string, evidence: LifecycleEvidence): boolean {
  // Preserve question punctuation. Commas and conjunctions keep a later future
  // stage from hiding an earlier assertion, as in "收尾已完成，群即将解散".
  const segments = text.split(/(?<=[，,。！？!?；;\n])|(?:但是|不过|但|并且|而且|\bbut\b)/iu);
  return segments.some((segment) => {
    if (/[?？]\s*$/u.test(segment) || /^\s*(?:是否|请问|Has\b|Have\b|Is\b|Are\b)/iu.test(segment))
      return false;
    const assertion = segment.replace(
      /(?:尚未|还没|没有|未能|无法|不能|不会|并未|未|等待|待|即将|将会|准备|计划|会(?=关闭|解散|清理|完成|结束))[^，,。！？!?；;\n]*|\b(?:not|never|pending|waiting|will|cannot|can't|going\s+to)\b[^,;.!?\n]*/giu,
      "",
    );
    if (!completed.test(assertion)) return false;
    const claimsCleanup = cleanup.test(assertion);
    const claimsGroup = groupClosed.test(assertion);
    const claimsExecution = executionClosed.test(assertion);
    if (claimsGroup && evidence.task.groupDeleted !== true) return true;
    if (claimsExecution && !claimedExecutionsClosed(assertion, evidence)) return true;
    return claimsCleanup && !cleanupFinished(evidence);
  });
}

function cleanupFinished({ task, participants }: LifecycleEvidence): boolean {
  if (task.completionRequest || task.pending || task.error || task.syncError) return false;
  if (!["completed", "destroyed"].includes(task.status)) return false;
  const groupRetained = task.keepGroup && task.groupRetentionSource === "explicit";
  const groupSettled = !task.chatId || task.groupDeleted || groupRetained;
  // complete + no closeRequested is the durable result of explicit keepExecution.
  // With a group, the lifecycle service additionally requires explicit keepGroup.
  const executionRetained =
    task.status === "completed" &&
    !task.closeRequested &&
    (!task.chatId || (groupRetained && !task.groupDeleted));
  return (
    groupSettled &&
    (executionRetained ||
      participants.every(
        (participant) => isClosed(participant) || (!participant.started && !participant.execution),
      ))
  );
}

function claimedExecutionsClosed(text: string, { participants }: LifecycleEvidence): boolean {
  const kinds = ["claude", "codex"].filter((kind) => text.toLowerCase().includes(kind));
  const named = participants.filter(
    (participant) =>
      mentions(text, participant.id) ||
      (!["claude", "codex"].includes(participant.name.toLowerCase()) &&
        mentions(text, participant.name)),
  );
  const selected =
    named.length && !/(?:所有|双方|全部|全体|\b(?:all|both)\b)/iu.test(text)
      ? named
      : participants.filter((participant) => !kinds.length || kinds.includes(participant.kind));
  if (kinds.some((kind) => !selected.some((participant) => participant.kind === kind)))
    return false;
  return selected.length > 0 && selected.every(isClosed);
}

function isClosed(participant: LifecycleEvidence["participants"][number]): boolean {
  return participant.status === "gone" || participant.status === "removed";
}

function mentions(text: string, identifier: string): boolean {
  if (!identifier) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`, "iu").test(text);
}
