/**
 * Read-only settlement proof for one exhausted, versioned, failed model turn.
 *
 * `canDeleteTaskGroup` must wait for every accepted turn in a task group, but an
 * exhausted read-only turn can never be recovered: `SessionService.canRecover`
 * refuses a failed receipt once its attempt ceiling is reached. Without a proof
 * the uncertain inbox row is permanent, so a task whose participants closed and
 * whose failure notice reached the chat can never have its group deleted.
 *
 * Safety comes from the durable journal guarantee that `TurnReceipt` encodes as
 * `recoveryVersion === 1`: `SessionService.wrapTool` writes a `pi_operations`
 * row (`pending` BEFORE `execute`, then `complete`/`not_executed`) for every
 * non-read-only tool, while read-only tools are returned unwrapped and never
 * touch the journal. An empty per-turn journal therefore proves that no write
 * was even attempted, whatever the checkpoint happens to contain. Every other
 * condition only binds the inbox row to that exact turn and proves the user was
 * really told the turn was abandoned:
 *
 *  - the inbox row is a `message` turn for this exact owner/task/chat/session,
 *    with the same generation as the durable session;
 *  - the inbox row itself is exhausted (`attempts` at the retry ceiling) and
 *    failed with a transient model/transport `unknown` outcome;
 *  - its `turn_receipts` row is `failed`, `recoveryVersion === 1`, matches the
 *    generation, carries this turn's placeholder reply identity, and is itself
 *    at the recovery ceiling;
 *  - a `pi_checkpoints` row exists for the same identity, session and
 *    generation, so the turn really ran through the durable engine path;
 *  - the per-turn `pi_operations` journal is EMPTY (pending, unknown, refused
 *    or completed writes all keep blocking: this is deliberately no-write only);
 *  - the exact `${inboxId}:interrupted` outbox envelope is `delivered`, in this
 *    chat, byte-identical to the interruption notice, with every confirmed
 *    fragment present and a valid versioned fingerprint for this reply target.
 *
 * Nothing here writes, rewrites, resolves or replays: it only reads the store,
 * so a crash or restart cannot leave partial settlement behind. Any missing,
 * legacy, mismatched or foreign record fails the proof and keeps the original
 * barrier.
 */
import { canonical, stableId } from "../core/ids.js";
import type { Store } from "../storage/store.js";
import { transientTurnFailure } from "./recovery.js";
import { key } from "./session-records.js";

/**
 * Inbox retry ceiling and turn-recovery ceiling. Both services count attempts
 * from 1 and refuse to re-enter a turn at or above this value; keep this in
 * sync with `Inbox.runLane` and `SessionService.canRecover`.
 */
export const EXHAUSTED_TURN_ATTEMPTS = 3;

/**
 * Exact interruption notice `Application.interruptedMessage` sends for one
 * exhausted inbox message. The proof requires this byte-for-byte, and the
 * integration regression compares it with the notice the application really
 * produces, so drift cannot silently settle a different message.
 */
export const INBOX_INTERRUPTED_NOTICE_TEXT =
  "本次请求的处理已中断，自动恢复未能完成。已经登记的任务和操作会保留；结果尚未确认的操作不会重复执行。请查询当前任务进度后继续。";

export interface SettlementScope {
  ownerId: string;
  taskId: string;
  chatId: string;
}

/**
 * Structural view of the durable facts this proof consumes. Every field is
 * validated here rather than trusted, and unknown payloads are rejected, so a
 * caller cannot widen the proof by passing a partially shaped record.
 */
export interface UncertainInboxFact {
  id?: unknown;
  type?: unknown;
  payload?: unknown;
  actor?: unknown;
  generation?: unknown;
  state?: unknown;
  attempts?: unknown;
  failureNotice?: unknown;
  error?: unknown;
}

export interface SettlementProof {
  proven: boolean;
  reason: string;
}

/** Prove that this uncertain inbox row has no unresolved effect and was noticed. */
export function proveInertExhaustedTurn(
  store: Store,
  record: UncertainInboxFact,
  scope: SettlementScope,
): SettlementProof {
  if (record.type !== "message") return blocked("inbox_type");
  if (record.state !== "uncertain") return blocked("inbox_state");
  const payload = plain(record.payload);
  if (!payload || payload.chatId !== scope.chatId) return blocked("inbox_chat");
  const messageId = nonEmpty(payload.messageId);
  if (!messageId || record.id !== `message:${messageId}`) return blocked("inbox_identity");
  const actor = plain(record.actor);
  if (!actor) return blocked("actor_missing");
  if (
    actor.ownerId !== scope.ownerId ||
    actor.chatId !== scope.chatId ||
    actor.taskId !== scope.taskId
  )
    return blocked("scope");
  const sessionId = nonEmpty(actor.sessionId);
  const actorMessageId = nonEmpty(actor.messageId);
  if (!sessionId || !actorMessageId || actorMessageId !== messageId) return blocked("identity");
  const generation = count(record.generation);
  if (generation === undefined) return blocked("generation");
  const inboxAttempts = count(record.attempts);
  if (inboxAttempts === undefined || inboxAttempts < EXHAUSTED_TURN_ATTEMPTS)
    return blocked("inbox_attempts");
  const failure = plain(record.error);
  if (!failure || failure.outcome !== "unknown") return blocked("error_outcome");
  const code = nonEmpty(failure.code);
  if (!code || !transientTurnFailure(code)) return blocked("error_code");
  if (record.failureNotice !== "delivered") return blocked("notice_state");

  const session = plain(store.get<unknown>("sessions", sessionId));
  if (
    !session ||
    session.id !== sessionId ||
    session.ownerId !== scope.ownerId ||
    session.taskId !== scope.taskId
  )
    return blocked("session");
  if (count(session.generation) !== generation || session.archived === true)
    return blocked("session_generation");

  const receiptId = key(scope.ownerId, sessionId, messageId);
  const receipt = plain(store.get<unknown>("turn_receipts", receiptId));
  if (!receipt || receipt.status !== "failed" || receipt.recoveryVersion !== 1)
    return blocked("receipt");
  // `runReply` always writes this exact placeholder reply id. A missing or
  // foreign one means the receipt is malformed or belongs to another turn.
  if (receipt.replyId !== `reply_${receiptId}`) return blocked("receipt_reply");
  if (count(receipt.generation) !== generation) return blocked("receipt_generation");
  const receiptAttempts = count(receipt.attempts);
  if (receiptAttempts === undefined || receiptAttempts < EXHAUSTED_TURN_ATTEMPTS)
    return blocked("receipt_attempts");

  const checkpoint = plain(store.get<unknown>("pi_checkpoints", receiptId));
  if (
    !checkpoint ||
    count(checkpoint.generation) !== generation ||
    !Array.isArray(checkpoint.messages)
  )
    return blocked("checkpoint");
  // `saveCheckpoint` always binds the session; a legacy or foreign binding is
  // never accepted as this turn's durable checkpoint.
  if (checkpoint.sessionId !== sessionId) return blocked("checkpoint_session");

  // The versioned journal covers every write tool of this turn. No row at all
  // means none was attempted; any pending/complete/not_executed row keeps the
  // barrier, because only a genuinely effect-free turn may be settled.
  if (
    store.list<{ turnId?: unknown }>("pi_operations").some((effect) => effect?.turnId === receiptId)
  )
    return blocked("journal");

  if (!deliveredInterruptedNotice(store, `message:${messageId}`, actorMessageId, scope.chatId))
    return blocked("notice");
  return { proven: true, reason: "settled" };
}

function blocked(reason: string): SettlementProof {
  return { proven: false, reason };
}

/**
 * Validate the exact interruption envelope: delivered in this chat, the known
 * notice text, every part confirmed, and the versioned fingerprint bound to
 * this reply target. A missing or legacy outbox row never proves delivery.
 */
function deliveredInterruptedNotice(
  store: Store,
  inboxId: string,
  replyTo: string,
  chatId: string,
): boolean {
  const id = `${inboxId}:interrupted`;
  const record = plain(store.get<unknown>("outbox", id));
  if (!record) return false;
  if (record.id !== id || record.chatId !== chatId || record.state !== "delivered") return false;
  const text = record.text;
  if (typeof text !== "string" || text !== INBOX_INTERRUPTED_NOTICE_TEXT) return false;
  const parts = record.parts;
  if (!Array.isArray(parts) || parts.length === 0) return false;
  if (!parts.every((part) => typeof part === "string" && part.length > 0)) return false;
  if (parts.join("") !== text) return false;
  const ids = record.ids;
  if (!Array.isArray(ids) || ids.length !== parts.length) return false;
  if (!ids.every((entry) => typeof entry === "string" && entry.length > 0)) return false;
  const envelope = plain(record.envelope);
  if (!envelope || envelope.version !== 1 || envelope.replyTo !== replyTo) return false;
  return (
    envelope.fingerprint === interruptionFingerprint(id, chatId, text, parts as string[], replyTo)
  );
}

/** Same identity the outbox computed for this envelope; recomputed read-only. */
function interruptionFingerprint(
  id: string,
  chatId: string,
  text: string,
  parts: string[],
  replyTo: string,
): string {
  return stableId(canonical({ id, chatId, text, parts, replyTo }));
}

function plain(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
