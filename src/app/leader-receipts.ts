import { canonical, stableId } from "../core/ids.js";

import { leaderRuntime } from "../orchestration/leader-session.js";
import {
  LEADER_SESSIONS,
  type LeaderOperationRecord,
  leaderSessionId,
} from "../orchestration/leader-session-types.js";
import {
  LEADER_INSTRUCTION_MAX_CHARS,
  LEADER_REASON_MAX_CHARS,
} from "../orchestration/leader-tools.js";
import type { OperationReceipt } from "../storage/operations.js";
import type { Store } from "../storage/store.js";

/**
 * Integration safety fix: a durable per-task Leader journal can still hold a
 * pending/unknown write receipt after a crash even when an EXISTING authoritative
 * native record already proves the exact business effect completed. That second
 * uncertainty layer must not strand the task forever, and it must never cause a
 * replay or let model prose/implicit inactivity count as completion.
 *
 * Everything here is a pure read of existing records plus one durable resolution.
 * No tool is invoked, no native operation is created or replayed.
 *
 * Identity is closed by default. A receipt is only considered at all when the
 * task exists, the derived `task-leader:<taskId>` session record exists with the
 * same task id and a non-empty owner, and the receipt carries exactly that
 * task, session and owner. A missing session, an empty owner or any mismatch
 * leaves the receipt blocked; nothing is inferred from the receipt's own fields.
 *
 * Reconciliation then only moves a receipt to a state that an existing, exact,
 * authoritative record already states:
 *  - `treat_done` when the exact native operation, or the exact durable decision
 *    the Leader recorded on its event, proves that effect. The resolution result
 *    is built from that proof; it is never invented, and recording a selection,
 *    a decision or a dispatch never claims delivery or business completion.
 *  - `abandon` when an immutable audit proves the exact operation was retired:
 *    a definite native refusal, an explicit native resolution, or an execution
 *    replacement that retired the addressed operation. Retirement forbids a
 *    replay; it is not evidence about what historically reached the outside
 *    world, and the resolution reason says exactly that.
 *
 * Everything unfamiliar, mismatched, still in flight, or merely planned stays
 * blocked. Deciding what to do with a receipt whose effect may have reached the
 * outside world remains a user/evidence decision, never a default here.
 */

/** Native receipt states that prove the recorded effect happened or did not. */
const NATIVE_DONE = "done";
const NATIVE_FAILED = "failed";

/** Existing authoritative namespaces. This module never writes them. */
const NATIVE_OPERATIONS = "operations";
const INPUT_DELIVERIES = "input_deliveries";
const ORCHESTRATION_EVENTS = "task_orchestration_events";
const PARTICIPANTS = "participants";
const TASKS = "tasks";
/** Settled participant outputs, as the model orchestrator writes them. */
const SETTLED_OUTPUTS = "task_settled_outputs";
/** Repository-local record for an audited execution replacement. */
export const RESTART_RECORD_SOURCE = "task_restarts";

/** `orchestration_decide` persists its decision on the exact event. */
export const LEADER_DECISION_ACTION = "orchestration_decide";

/** Existing durable namespace for one committed Leader scheduling action. */
export const WORKFLOW_LEADER_ACTIONS = "workflow_leader_actions";

export const LEADER_DECISION_NOTE =
  "决定记录已持久化；本结果不代表参与者已收到输入、已开始执行或任务已完成。";

export const WORKFLOW_SELECTION_NOTE =
  "选择回执已持久化；派发结果、投递与业务完成均未确认，需按原生回执继续核对。";

export type LeaderReceiptResolution = "treat_done" | "abandon";

export interface LeaderReceiptOutcome {
  operationId: string;
  tool: string;
  state: LeaderOperationRecord["state"];
  resolution?: LeaderReceiptResolution;
  reason?: string;
}

export interface LeaderReceiptReport {
  taskId: string;
  sessionId: string;
  /** Every pending/unknown write receipt examined by this call. */
  inspected: LeaderReceiptOutcome[];
  /** Receipts closed by an exact authoritative match. */
  resolved: LeaderReceiptOutcome[];
  /** Receipts this module deliberately leaves unresolved and blocking. */
  blocked: LeaderReceiptOutcome[];
  /** True when at least one receipt was closed; callers must re-read before continuing. */
  changed: boolean;
}

/**
 * The exact tools whose native effect can be proven from existing records.
 * `participant_send` writes a real input delivery; `orchestration_decide`
 * records a durable decision; the workflow action tools commit a durable
 * selection receipt. Unknown or generic tools are never reconciled.
 */
export const RECONCILABLE_LEADER_TOOLS = [
  "participant_send",
  LEADER_DECISION_ACTION,
  "workflow_dispatch",
  "workflow_verify",
  "workflow_replan",
  "workflow_add_reviewer",
  "workflow_wait",
  "workflow_deliver",
] as const;

export type ReconcilableLeaderTool = (typeof RECONCILABLE_LEADER_TOOLS)[number];

export function isReconcilableLeaderTool(tool: string): tool is ReconcilableLeaderTool {
  return (RECONCILABLE_LEADER_TOOLS as readonly string[]).includes(tool);
}

/**
 * The existing native identity of one scheduler input delivery. Both the model
 * orchestrator and `TaskService.send` derive it from the actor's event id, the
 * participant id and the exact text, so it is the only id that can carry an
 * authoritative receipt for a Leader-recorded send.
 */
export function nativeSendOperationId(
  taskId: string,
  eventId: string,
  participantId: string,
  text: string,
): string {
  return `${taskId}:send:${stableId(eventId, participantId, text)}`;
}

/** The native fingerprint of the exact send parameters, as `TaskService.send` writes it. */
export function nativeSendFingerprint(participantId: string, text: string): string {
  return stableId(canonical({ participant: participantId, text }));
}

/**
 * Args as recorded. An unparseable record is never a match, so a damaged journal
 * can never be reconciled by accident.
 */
export function operationArgs(
  operation: LeaderOperationRecord,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(operation.args || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return;
  }
}

/** The recorded args may only carry fields the invoked tool actually declares. */
function hasOnlyKeys(args: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(args).every((key) => allowed.includes(key));
}

/**
 * Field-for-field equality over exactly the same key set. Keys absent from the
 * expected object must be absent from the record: a serialized `undefined` is
 * never treated as a match for a recorded `null`, and an extra field is a
 * different invocation.
 */
function argsMatch(args: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  const actual = Object.keys(args).sort();
  const wanted = Object.keys(expected).sort();
  if (actual.length !== wanted.length) return false;
  if (actual.some((key, index) => key !== wanted[index])) return false;
  return actual.every((key) => canonical(args[key]) === canonical(expected[key]));
}

/**
 * The recorded send args must be exactly the global `participant_send` schema's
 * declared fields, with `taskId` either absent or this exact task.
 */
function sendArgsMatch(
  args: Record<string, unknown>,
  taskId: string,
  participantId: string,
  text: string,
): boolean {
  if (!hasOnlyKeys(args, ["taskId", "participantId", "text"])) return false;
  if (args.taskId !== undefined && args.taskId !== taskId) return false;
  const expected: Record<string, unknown> = { participantId, text };
  if (args.taskId !== undefined) expected.taskId = taskId;
  return argsMatch(args, expected);
}

type BoundedText = { ok: true; value: string | undefined } | { ok: false };

/**
 * Mirror of the Leader tools' `textArg`: a present value must be a non-empty,
 * length-bounded string and is compared in its documented trimmed form. An
 * absent optional value stays absent; anything else means the recorded
 * invocation cannot be the one the tool would have accepted, so it never
 * authorizes a resolution.
 */
function readBoundedText(
  args: Record<string, unknown>,
  key: string,
  max: number | undefined,
  required: boolean,
): BoundedText {
  const value = args[key];
  if (value === undefined) return required ? { ok: false } : { ok: true, value: undefined };
  if (typeof value !== "string" || !value.trim()) return { ok: false };
  if (max !== undefined && value.length > max) return { ok: false };
  return { ok: true, value: value.trim() };
}

function nativeReceipt(store: Store, operationId: string): OperationReceipt | undefined {
  return store.get<OperationReceipt>(NATIVE_OPERATIONS, operationId);
}

interface SessionScope {
  sessionId: string;
  ownerId: string;
}

interface LeaderSessionLike {
  id?: unknown;
  taskId?: unknown;
  ownerId?: unknown;
}

/**
 * The one session identity a receipt must have to be considered at all. The
 * session record must exist under the derived key, name this exact task and
 * carry a non-empty owner. There is deliberately no fallback: a missing or
 * malformed session yields no scope, and every receipt then stays blocked
 * instead of being judged against an empty owner.
 */
function sessionScope(store: Store, taskId: string): SessionScope | undefined {
  const sessionId = leaderSessionId(taskId);
  const session = store.get<LeaderSessionLike>(LEADER_SESSIONS, sessionId);
  if (!session || typeof session !== "object") return undefined;
  if (session.id !== sessionId || session.taskId !== taskId) return undefined;
  if (typeof session.ownerId !== "string" || !session.ownerId.trim()) return undefined;
  return { sessionId, ownerId: session.ownerId };
}

/**
 * Ownership proof: the receipt must belong to this task, to the derived
 * `task-leader:<taskId>` session, and to that session's recorded owner. The
 * receipt's own `ownerId` never authorizes itself: an empty, missing or foreign
 * owner is a mismatch. A receipt failing this check is never reconciled, not
 * even as abandon.
 */
function ownedBySession(
  operation: LeaderOperationRecord,
  taskId: string,
  scope: SessionScope,
): boolean {
  if (operation.taskId !== taskId) return false;
  if (operation.sessionId !== scope.sessionId) return false;
  if (typeof operation.ownerId !== "string" || !operation.ownerId) return false;
  return operation.ownerId === scope.ownerId;
}

interface TaskOwnership {
  id?: unknown;
  ownerId?: unknown;
  participantIds?: unknown;
}

/**
 * Task ownership proof: the task must exist under its own id, be owned by the
 * verified session owner, and (when a participant is named) still list that
 * participant. An empty or missing task owner never authorizes anything: the
 * comparison is exact, with no `if (ownerId && ...)` escape hatch.
 */
function taskOwns(store: Store, taskId: string, ownerId: string, participantId?: string): boolean {
  const task = store.get<TaskOwnership>(TASKS, taskId);
  if (!task || task.id !== taskId) return false;
  if (typeof task.ownerId !== "string" || !task.ownerId) return false;
  if (task.ownerId !== ownerId) return false;
  if (participantId === undefined) return true;
  const roster = Array.isArray(task.participantIds) ? task.participantIds : [];
  return roster.includes(participantId);
}

interface RestartAudit {
  id?: string;
  taskId?: string;
  state?: string;
  operationIds?: string[];
}

function restartProvesRetired(
  restart: RestartAudit | undefined,
  operationId: string,
  taskId: string,
): boolean {
  return !!(
    restart &&
    restart.taskId === taskId &&
    restart.state === "done" &&
    (restart.operationIds ?? []).includes(operationId)
  );
}

/**
 * The id of the audited, completed execution replacement that retired exactly
 * this operation, if any. That replacement closed the addressed execution and
 * registered the old input as retired, so the operation is closed as
 * explicitly abandoned and may never be replayed. This is a statement about
 * the retirement decision, not about what the old attempt historically did.
 */
function completedRestartOf(store: Store, operationId: string, taskId: string): string | undefined {
  const retirements = store.entries<RestartAudit>(RESTART_RECORD_SOURCE);
  const proves = (entry: [string, RestartAudit]): string | undefined =>
    restartProvesRetired(entry[1], operationId, taskId) ? (entry[1].id ?? entry[0]) : undefined;
  for (const entry of retirements) {
    const id = proves(entry);
    if (id) return id;
  }
  const tagged = nativeReceipt(store, operationId)?.retiredByRestart;
  if (!tagged) return undefined;
  const taggedEntry =
    retirements.find(([key]) => key === tagged) ??
    retirements.find(([, restart]) => restart.id === tagged);
  return taggedEntry ? proves(taggedEntry) : undefined;
}

interface SingleResolution {
  resolution: LeaderReceiptResolution;
  decidedBy: "evidence" | "user";
  reason: string;
  result?: unknown;
}

/**
 * Explicit native dispositions belong to the operations boundary and are never
 * overwritten. `retry` is deliberately not a disposition here: the outcome of
 * that retry is read from the native state instead.
 */
function explicitNativeDisposition(
  receipt: OperationReceipt | undefined,
): SingleResolution | undefined {
  const decision = receipt?.resolution;
  if (!decision) return undefined;
  const decidedBy = decision.decidedBy === "user" ? "user" : "evidence";
  if (decision.choice === "abandon")
    return {
      resolution: "abandon",
      decidedBy,
      reason: `原生操作已有明确决议（abandon/${decision.decidedBy}）：${decision.reason}`,
    };
  if (decision.choice !== "treat_done" || decision.result === undefined) return undefined;
  return {
    resolution: "treat_done",
    decidedBy,
    reason: `原生操作已有明确决议（treat_done/${decision.decidedBy}）：${decision.reason}`,
    result: decision.result,
  };
}

interface InputDeliveryRecord {
  taskId?: string;
  participantId?: string;
  operationId?: string;
  fingerprint?: string;
  prompt?: string;
  receipt?: string;
  initial?: boolean;
}

/** The exact native input delivery prepared for this operation, owner/task scoped. */
function exactDelivery(
  store: Store,
  operationId: string,
  taskId: string,
  participantId: string,
): InputDeliveryRecord | undefined {
  const delivery = store.get<InputDeliveryRecord>(INPUT_DELIVERIES, operationId);
  if (!delivery) return undefined;
  if (delivery.taskId !== taskId) return undefined;
  if (delivery.operationId !== operationId) return undefined;
  if (delivery.participantId !== participantId) return undefined;
  if (typeof delivery.prompt !== "string" || !delivery.prompt) return undefined;
  return delivery;
}

/** The exact writer marker line `participantPrompt` places before the token. */
const RECEIPT_MARKER_LINE = "投递标识（无需复述）：";

/**
 * The exact writer marker line followed by the exact own token line, in either
 * documented spacing: directly (v1/v2, `\n`) or after one blank line (v3, `\n\n`).
 *
 * A substring search is not enough here. `includes(marker + "\n" + token)` also
 * accepts a line whose token merely starts with ours (`<token>-FOREIGN`) and a
 * lookalike line that merely ends with the marker text, neither of which is a
 * real writer section. Lines are compared with strict equality and the token is
 * never interpreted as a pattern, so a crafted token cannot inject a match. The
 * scan continues past an earlier lookalike, so a genuine section later in the
 * body still proves it.
 */
function hasExactMarkerTokenSection(prompt: string, token: string): boolean {
  const lines = prompt.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== RECEIPT_MARKER_LINE) continue;
    if (lines[index + 1] === token) return true;
    if (lines[index + 1] === "" && lines[index + 2] === token) return true;
  }
  return false;
}

/**
 * `prepareInputDelivery` is the only writer of the native input body, and it has
 * exactly two documented shapes:
 *  - a later turn: the recorded text followed by the derived receipt envelope;
 *  - the first turn of a participant: the full participant prompt, whose receipt
 *    section is that participant's own durable token. The v2 protocol appends its
 *    own footer AFTER that token and v1/v3 end with it, so the proof requires the
 *    writer marker and this participant's own token as whole lines, in one of the
 *    two documented spacings, and never a position.
 * The delivery row's own fingerprint (checked separately) binds the recorded
 * text, so this function proves the writer and the exact envelope, and it rejects
 * every other body, including an initial body carrying a foreign receipt token.
 */
function deliveryMatchesPreparedBody(input: {
  delivery: InputDeliveryRecord;
  text: string;
  operationId: string;
  participantId: string;
  initialReceipt?: string;
}): boolean {
  const { delivery, text, operationId, participantId } = input;
  if (typeof delivery.prompt !== "string" || !delivery.prompt) return false;
  if (typeof delivery.receipt !== "string" || !delivery.receipt) return false;
  if (!text.trim()) return false;
  if (delivery.initial === true) {
    if (!input.initialReceipt || delivery.receipt !== input.initialReceipt) return false;
    // `participantPrompt` writes the marker line immediately before the token;
    // the v3 template separates its lines with a blank line while v1/v2 append a
    // single newline, and the v2 footer follows the token. Only the whole-line
    // marker+token section itself is required, never a position.
    if (!hasExactMarkerTokenSection(delivery.prompt, delivery.receipt)) return false;
    return delivery.prompt.includes(text);
  }
  if (delivery.receipt !== `HERDR_RECEIPT_${stableId(operationId, participantId)}`) return false;
  return delivery.prompt === `${text}\n\n投递标识（无需复述）：\n${delivery.receipt}`;
}

interface EventRecord {
  taskId?: string;
  userRevision?: string;
  dispatches?: Array<{ operationId?: string; participantId?: string }>;
  decision?: Record<string, unknown>;
}

function orchestrationEvent(store: Store, eventId: string): EventRecord | undefined {
  if (typeof eventId !== "string" || !eventId.trim()) return undefined;
  return store.get<EventRecord>(ORCHESTRATION_EVENTS, eventId);
}

/**
 * Event/task/revision identity: the event the Leader was activated for must be
 * this task's, and its user revision must be the revision the receipt recorded.
 */
function eventIdentityMatches(
  store: Store,
  operation: LeaderOperationRecord,
  taskId: string,
): boolean {
  const event = orchestrationEvent(store, operation.eventId);
  if (!event || event.taskId !== taskId) return false;
  return !!operation.revision && event.userRevision === operation.revision;
}

/**
 * The authoritative dispatch link for a completion claim: the event must record
 * exactly this native operation for exactly this participant. A missing or
 * foreign link means the native record is not provably this send.
 */
function eventDispatchesOperation(
  store: Store,
  operation: LeaderOperationRecord,
  taskId: string,
  operationId: string,
  participantId: string,
): boolean {
  if (!eventIdentityMatches(store, operation, taskId)) return false;
  const event = orchestrationEvent(store, operation.eventId);
  return (event?.dispatches ?? []).some(
    (dispatch) => dispatch.operationId === operationId && dispatch.participantId === participantId,
  );
}

interface ParticipantLike {
  taskId?: unknown;
  initialReceipt?: unknown;
}

function participantOf(
  store: Store,
  taskId: string,
  participantId: string,
): ParticipantLike | undefined {
  const participant = store.get<ParticipantLike>(PARTICIPANTS, participantId);
  if (participant?.taskId !== taskId) return undefined;
  return participant;
}

/** Whatever the native delivery proved, without inventing a verified send. */
function provenDelivery(
  receipt: OperationReceipt,
): { result: unknown; reason: string } | undefined {
  const value = receipt.result as
    | { status?: unknown; verified?: unknown; acked?: unknown; attempts?: unknown }
    | undefined;
  if (!value || typeof value !== "object" || value.verified !== true) return undefined;
  const status =
    value.status === "queued" || value.status === "delivered" ? value.status : undefined;
  if (!status) return undefined;
  return {
    result: {
      status,
      verified: true,
      acked: value.acked === true,
      attempts: typeof value.attempts === "number" ? value.attempts : 1,
    },
    reason: `原生操作回执已证明该输入投递完成（${status}/verified）；未重新投递，也未推断业务完成。`,
  };
}

/**
 * `participant_send` proof. The Leader recorded the same actor event id the
 * native send used, so the authoritative native operation id is re-derived and
 * must be the exact operation the delivery prep, the event dispatch and the
 * native receipt all carry. Task, event, revision, participant, exact text and
 * the native fingerprint must agree before anything is resolved.
 *
 * The scoped orchestrator keeps the global `participant_send` schema, so a real
 * model call may carry an explicit `taskId`. Only this task's exact id (or no
 * taskId at all) is accepted; a foreign taskId or any undeclared field is not
 * this invocation and never resolves.
 */
function participantSendResolution(
  store: Store,
  operation: LeaderOperationRecord,
  taskId: string,
  scope: SessionScope,
): SingleResolution | undefined {
  const eventId = operation.eventId;
  if (typeof eventId !== "string" || !eventId.trim()) return undefined;
  const args = operationArgs(operation);
  if (!args) return undefined;
  const participantId = args.participantId;
  const text = args.text;
  if (typeof participantId !== "string" || !participantId) return undefined;
  if (typeof text !== "string" || !text.trim()) return undefined;
  if (!sendArgsMatch(args, taskId, participantId, text)) return undefined;
  const participant = participantOf(store, taskId, participantId);
  if (!participant) return undefined;
  if (!taskOwns(store, taskId, scope.ownerId, participantId)) return undefined;
  const operationId = nativeSendOperationId(taskId, eventId, participantId, text);
  if (!eventDispatchesOperation(store, operation, taskId, operationId, participantId))
    return undefined;
  const delivery = exactDelivery(store, operationId, taskId, participantId);
  if (!delivery) return undefined;
  if (delivery.fingerprint !== nativeSendFingerprint(participantId, text)) return undefined;
  if (
    !deliveryMatchesPreparedBody({
      delivery,
      text,
      operationId,
      participantId,
      ...(typeof participant.initialReceipt === "string" && participant.initialReceipt
        ? { initialReceipt: participant.initialReceipt }
        : {}),
    })
  )
    return undefined;
  const receipt = nativeReceipt(store, operationId);
  if (!receipt || receipt.id !== operationId) return undefined;
  if (receipt.fingerprint !== nativeSendFingerprint(participantId, text)) return undefined;
  const restartId = completedRestartOf(store, operationId, taskId);
  if (restartId)
    return {
      resolution: "abandon",
      decidedBy: "evidence",
      reason:
        `该投递所属执行现场已被用户授权的重启替换（${restartId}）并登记退役；` +
        "不重放这条旧输入，也不据此断言它历史上未曾送达，按放弃记录。",
    };
  const explicit = explicitNativeDisposition(receipt);
  if (explicit) return explicit;
  if (receipt.state === NATIVE_DONE) {
    const proven = provenDelivery(receipt);
    if (proven)
      return {
        resolution: "treat_done",
        decidedBy: "evidence",
        reason: proven.reason,
        result: proven.result,
      };
    return undefined;
  }
  if (receipt.state === NATIVE_FAILED)
    return {
      resolution: "abandon",
      decidedBy: "evidence",
      reason: "原生投递已确认未执行；该输入没有被发送，记录为放弃，绝不重放。",
    };
  return undefined;
}

/**
 * The decision record `decisionTool` writes: `{action, reason: args.reason.trim()}`
 * plus `{outputId, participantId}` for a `deliver` validated against a settled
 * native output. Any other shape, including a selection record written by the
 * workflow commit path, is a different effect and stays blocked.
 */
const DECISION_KEYS: Record<string, readonly string[]> = {
  continue: ["action", "reason"],
  wait: ["action", "reason"],
  deliver: ["action", "reason", "outputId", "participantId"],
};

interface SettledOutputLike {
  taskId?: string;
  participantId?: string;
  entry?: { id?: unknown; role?: unknown; final?: unknown };
}

/**
 * `orchestration_decide` proof: persisting the decision on the exact event is the
 * effect. Event, task and the exact recorded arguments must match, the recorded
 * `reason` is compared in its documented trimmed form, and a `deliver` decision
 * must reference exactly the settled native output the tool validated. The result
 * states explicitly that only the decision was recorded: no dispatch, no
 * delivery, no business completion.
 *
 * A decision that already carries a `candidateId` was written by the workflow
 * commit path, not by this tool, so it never closes an `orchestration_decide`
 * receipt: such a receipt is only ever proven by the selection record itself.
 */
function decisionResolution(
  store: Store,
  operation: LeaderOperationRecord,
  taskId: string,
  scope: SessionScope,
): SingleResolution | undefined {
  if (!eventIdentityMatches(store, operation, taskId)) return undefined;
  if (!taskOwns(store, taskId, scope.ownerId)) return undefined;
  const args = operationArgs(operation);
  if (!args) return undefined;
  if (!hasOnlyKeys(args, ["action", "reason", "outputId"])) return undefined;
  const action = args.action;
  if (action !== "continue" && action !== "wait" && action !== "deliver") return undefined;
  // The decision tool has no length bound on `reason`; it only trims and rejects
  // an empty value. Imposing a smaller bound here would strand a valid receipt.
  const reason = readBoundedText(args, "reason", undefined, true);
  if (!reason.ok || reason.value === undefined) return undefined;
  const event = orchestrationEvent(store, operation.eventId);
  const decision = event?.decision;
  if (!decision || decision.action !== action) return undefined;
  if (decision.candidateId !== undefined) return undefined;
  if (!hasOnlyKeys(decision, DECISION_KEYS[action] ?? [])) return undefined;
  if (decision.reason !== reason.value) return undefined;
  const result: Record<string, unknown> = { action, reason: reason.value };
  if (action === "deliver") {
    const outputId = args.outputId;
    if (typeof outputId !== "string" || !outputId) return undefined;
    const output = store.get<SettledOutputLike>(SETTLED_OUTPUTS, outputId);
    if (!output || output.taskId !== taskId) return undefined;
    if (output.entry?.id !== outputId) return undefined;
    if (output.entry?.final !== true || output.entry?.role !== "assistant") return undefined;
    const participantId = output.participantId;
    if (typeof participantId !== "string" || !participantId) return undefined;
    if (decision.outputId !== outputId || decision.participantId !== participantId)
      return undefined;
    result.outputId = outputId;
    result.participantId = participantId;
  } else if (args.outputId !== undefined) {
    // The tool ignores outputId for these actions, so a decision that carries one
    // cannot be the effect of this invocation.
    return undefined;
  }
  return {
    resolution: "treat_done",
    decidedBy: "evidence",
    reason:
      "该事件已持久化与本操作参数完全一致的调度决定；只证明决定已记录，不证明派发、投递或业务完成。",
    result: { ...result, recorded: true, note: LEADER_DECISION_NOTE },
  };
}

interface LeaderActionRecordLike {
  id?: unknown;
  taskId?: unknown;
  ownerId?: unknown;
  sessionId?: unknown;
  eventId?: unknown;
  revision?: unknown;
  state?: unknown;
  request?: { action?: unknown; candidateId?: unknown; reason?: unknown; instruction?: unknown };
  candidate?: {
    id?: unknown;
    kind?: unknown;
    description?: unknown;
    assignments?: Array<{ nodeId?: unknown; participantId?: unknown }>;
  };
}

/** The existing durable selection receipt id: event id plus the exact revision. */
export function leaderActionRecordId(eventId: string, revision: string): string {
  return `wla_${stableId(eventId, revision)}`;
}

/** Tool → the exact action and candidate kind `commit()` records for it. */
const WORKFLOW_TOOL_ACTION: Record<string, { action: string; kind: string } | undefined> = {
  workflow_verify: { action: "verify", kind: "verify" },
  workflow_replan: { action: "replan", kind: "replan" },
  workflow_add_reviewer: { action: "add_reviewer", kind: "add_reviewer" },
  workflow_wait: { action: "wait", kind: "user" },
  workflow_deliver: { action: "deliver", kind: "deliver" },
};

/** The event decision action `persistAction` derives from the candidate kind. */
function workflowEventAction(kind: unknown): string | undefined {
  if (kind === "deliver") return "deliver";
  if (kind === "user") return "wait";
  if (
    kind === "dispatch" ||
    kind === "rework" ||
    kind === "verify" ||
    kind === "replan" ||
    kind === "add_reviewer"
  )
    return "continue";
  return undefined;
}

/**
 * Workflow action-tool proof. `commit()` persists the exact normalized request
 * and candidate on `workflow_leader_actions` in the SAME transaction as the
 * event decision, after `textArg` has trimmed `reason`/`instruction` and after
 * the tool has resolved the candidate. The proof therefore reproduces that
 * normalization from the recorded args, requires the omitted/default fields the
 * tool computes (no candidateId for wait/deliver; the prefix-selected action for
 * dispatch), and requires the event decision to be exactly the record's own
 * `source: "leader"` decision. It proves the selection receipt, and only that:
 * node and participant lists come from the recorded candidate, while dispatch,
 * delivery and business completion are explicitly reported as unknown.
 */
function workflowActionResolution(
  store: Store,
  operation: LeaderOperationRecord,
  taskId: string,
  scope: SessionScope,
): SingleResolution | undefined {
  if (!eventIdentityMatches(store, operation, taskId)) return undefined;
  if (!taskOwns(store, taskId, scope.ownerId)) return undefined;
  const args = operationArgs(operation);
  if (!args) return undefined;
  const tool = operation.tool;
  const takesCandidate =
    tool === "workflow_dispatch" ||
    tool === "workflow_verify" ||
    tool === "workflow_replan" ||
    tool === "workflow_add_reviewer";
  if (!hasOnlyKeys(args, takesCandidate ? ["candidateId", "reason", "instruction"] : ["reason"]))
    return undefined;
  const reason = readBoundedText(args, "reason", LEADER_REASON_MAX_CHARS, true);
  if (!reason.ok || reason.value === undefined) return undefined;
  let instruction: string | undefined;
  if (args.instruction !== undefined) {
    if (tool !== "workflow_dispatch") return undefined;
    const read = readBoundedText(args, "instruction", LEADER_INSTRUCTION_MAX_CHARS, false);
    if (!read.ok) return undefined;
    instruction = read.value;
  }
  const rawCandidateId = args.candidateId;
  if (takesCandidate && typeof rawCandidateId !== "string") return undefined;
  const candidateId =
    typeof rawCandidateId === "string" && rawCandidateId.length <= 200
      ? rawCandidateId.trim()
      : undefined;
  if (takesCandidate && (candidateId === undefined || !candidateId)) return undefined;
  const fixed = WORKFLOW_TOOL_ACTION[tool];
  if (tool !== "workflow_dispatch" && !fixed) return undefined;
  // The tool selects dispatch vs rework from the raw candidate id prefix.
  const action =
    tool === "workflow_dispatch"
      ? (rawCandidateId as string).startsWith("rework:")
        ? "rework"
        : "dispatch"
      : (fixed as { action: string }).action;
  const expectedKind = tool === "workflow_dispatch" ? action : (fixed as { kind: string }).kind;
  const recordId = leaderActionRecordId(operation.eventId, operation.revision);
  const record = store.get<LeaderActionRecordLike>(WORKFLOW_LEADER_ACTIONS, recordId);
  if (!record || record.id !== recordId) return undefined;
  if (record.taskId !== taskId || record.eventId !== operation.eventId) return undefined;
  if (record.revision !== operation.revision) return undefined;
  if (record.ownerId !== scope.ownerId || record.sessionId !== operation.sessionId)
    return undefined;
  // "requested" is the state written inside the commit transaction; "committed"
  // is the settled variant. Anything else never selected an action.
  if (record.state !== "requested" && record.state !== "committed") return undefined;
  const request = record.request;
  if (!request || request.action !== action) return undefined;
  if (request.reason !== reason.value || request.instruction !== instruction) return undefined;
  const candidate = record.candidate;
  const recordedCandidateId = candidate?.id;
  if (typeof recordedCandidateId !== "string") return undefined;
  if (request.candidateId !== recordedCandidateId) return undefined;
  if (candidate?.kind !== expectedKind) return undefined;
  if (takesCandidate && recordedCandidateId !== candidateId) return undefined;
  const decision = orchestrationEvent(store, operation.eventId)?.decision;
  if (!decision) return undefined;
  if (decision.source !== "leader") return undefined;
  if (decision.candidateId !== recordedCandidateId) return undefined;
  if (decision.action !== workflowEventAction(candidate?.kind)) return undefined;
  // `persistAction` copies the model's reason onto the decision for every kind
  // except `user`, whose candidate description is the program-computed question.
  const expectedReason =
    candidate?.kind === "user"
      ? typeof candidate.description === "string"
        ? candidate.description
        : undefined
      : request.reason;
  if (expectedReason === undefined || decision.reason !== expectedReason) return undefined;
  const assignments = candidate?.assignments ?? [];
  return {
    resolution: "treat_done",
    decidedBy: "evidence",
    reason:
      "该调度动作的选择回执已与事件决定在同一事务中持久化；只证明选择已登记，派发、投递与业务完成仍为未知。",
    result: {
      action,
      candidateId: recordedCandidateId,
      accepted: true,
      nodeIds: assignments.flatMap((entry) =>
        typeof entry.nodeId === "string" ? [entry.nodeId] : [],
      ),
      participantIds: assignments.flatMap((entry) =>
        typeof entry.participantId === "string" ? [entry.participantId] : [],
      ),
      selected: true,
      dispatched: "unknown",
      businessCompletion: "unknown",
      note: WORKFLOW_SELECTION_NOTE,
    },
  };
}

/**
 * Every reconciliation path is a pure read of existing records. A tool without a
 * proof function returns `undefined`, which keeps the receipt blocked.
 */
function resolutionFor(
  store: Store,
  operation: LeaderOperationRecord,
  taskId: string,
  scope: SessionScope,
): SingleResolution | undefined {
  switch (operation.tool) {
    case "participant_send":
      return participantSendResolution(store, operation, taskId, scope);
    case LEADER_DECISION_ACTION:
      return decisionResolution(store, operation, taskId, scope);
    case "workflow_dispatch":
    case "workflow_verify":
    case "workflow_replan":
    case "workflow_add_reviewer":
    case "workflow_wait":
    case "workflow_deliver":
      return workflowActionResolution(store, operation, taskId, scope);
    default:
      return undefined;
  }
}

const UNVERIFIED_SESSION_REASON =
  "本任务的 task-leader 会话身份不成立（会话记录缺失、任务不匹配或所有者为空）；不按空所有者或缺失会话做任何决议。";
const FOREIGN_SESSION_REASON =
  "Leader 记录的任务、会话或所有者身份与当前任务不一致，不做任何决议。";

/**
 * Reconcile pending/unknown Leader write receipts for one task against existing
 * authoritative native records. Synchronous; every change goes through
 * `leaderRuntime(store).resolveWrite`, so a receipt gets the same immutable
 * audit entry as an operations-boundary decision, and no tool is ever invoked.
 */
export function reconcileLeaderReceipts(store: Store, taskId: string): LeaderReceiptReport {
  const scope = sessionScope(store, taskId);
  const runtime = leaderRuntime(store);
  const inspected: LeaderReceiptOutcome[] = [];
  const resolved: LeaderReceiptOutcome[] = [];
  const blocked: LeaderReceiptOutcome[] = [];
  for (const operation of runtime.operations(taskId)) {
    if (operation.state !== "pending" && operation.state !== "unknown") continue;
    if (operation.resolution) continue;
    // Read-only calls are re-executable and are not write receipts.
    if (operation.readOnly === true) continue;
    const base = { operationId: operation.id, tool: operation.tool, state: operation.state };
    inspected.push(base);
    if (!scope) {
      blocked.push({ ...base, reason: UNVERIFIED_SESSION_REASON });
      continue;
    }
    if (!ownedBySession(operation, taskId, scope)) {
      blocked.push({ ...base, reason: FOREIGN_SESSION_REASON });
      continue;
    }
    if (!isReconcilableLeaderTool(operation.tool)) {
      blocked.push({
        ...base,
        reason: "该工具没有已核定的原生回执语义；未知或通用工具永不自动对账。",
      });
      continue;
    }
    try {
      const resolution = resolutionFor(store, operation, taskId, scope);
      if (!resolution) {
        blocked.push({
          ...base,
          reason: "没有与任务、事件、参数和当前原生状态完全一致的确证；保持阻塞，不重放、不推断。",
        });
        continue;
      }
      runtime.resolveWrite({
        taskId,
        operationId: operation.id,
        choice: resolution.resolution,
        decidedBy: resolution.decidedBy,
        reason: resolution.reason,
        ...(resolution.result !== undefined ? { result: resolution.result } : {}),
      });
      resolved.push({ ...base, resolution: resolution.resolution, reason: resolution.reason });
    } catch (error) {
      blocked.push({
        ...base,
        reason: `对账未能形成确证（${error instanceof Error ? error.name : "unknown"}）；保持阻塞。`,
      });
    }
  }
  return {
    taskId,
    sessionId: leaderSessionId(taskId),
    inspected,
    resolved,
    blocked,
    changed: resolved.length > 0,
  };
}
