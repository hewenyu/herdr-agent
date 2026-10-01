import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../core/errors.js";
import { canonical, now } from "../core/ids.js";
import {
  boundModelValue,
  boundToolResultMessage,
  MODEL_RESULT_MAX_BYTES,
  serialize as serializeModelValue,
} from "../runtime/model-context.js";
import type { Store } from "../storage/store.js";
import {
  assertLeaderRecordVersion,
  isLeaderRecordVersionSupported,
  LEADER_CHECKPOINT_SUMMARY_MAX_BYTES,
  LEADER_CHECKPOINTS,
  LEADER_JOURNAL,
  LEADER_OPERATIONS,
  LEADER_RUNTIME_VERSION,
  type LeaderCheckpointRecord,
  type LeaderJournalEntry,
  type LeaderOperationRecord,
  leaderCheckpointId,
  leaderOperationId,
  readLeaderRecord,
} from "./leader-session-types.js";

const SEQUENCE_KEY = "sequence";

function journalKey(taskId: string, sequence: number): string {
  return `${taskId}:${String(sequence).padStart(10, "0")}`;
}

export function nextJournalSequence(store: Store, taskId: string): number {
  const current = store.get<number>(LEADER_JOURNAL, `${taskId}:${SEQUENCE_KEY}`);
  const sequence = Number.isSafeInteger(current) && (current ?? 0) > 0 ? (current as number) : 0;
  const next = sequence + 1;
  store.set(LEADER_JOURNAL, `${taskId}:${SEQUENCE_KEY}`, next);
  return next;
}

/**
 * Append one canonical entry. Callers run this inside their own transaction, so
 * the journal and the mutation it records commit or roll back together.
 */
export function appendLeaderJournal(
  store: Store,
  entry: Omit<LeaderJournalEntry, "version" | "sequence" | "at"> & { at?: string },
): LeaderJournalEntry {
  const sequence = nextJournalSequence(store, entry.taskId);
  const record: LeaderJournalEntry = {
    version: LEADER_RUNTIME_VERSION,
    sequence,
    at: entry.at ?? now(),
    kind: entry.kind,
    taskId: entry.taskId,
    sessionId: entry.sessionId,
    activationId: entry.activationId,
    eventId: entry.eventId,
    revision: entry.revision,
    detail: entry.detail,
  };
  store.set(LEADER_JOURNAL, journalKey(entry.taskId, sequence), record);
  return record;
}

export function leaderJournal(store: Store, taskId: string): LeaderJournalEntry[] {
  return store
    .entries<LeaderJournalEntry>(LEADER_JOURNAL)
    .filter(([key]) => key.startsWith(`${taskId}:`) && !key.endsWith(`:${SEQUENCE_KEY}`))
    .map(([key, value]) => {
      // An entry written by a future runtime may mean something else; refusing
      // it is the only honest read, and the original record stays untouched.
      assertLeaderRecordVersion(value, "日志", key);
      return value;
    })
    .sort((a, b) => a.sequence - b.sequence);
}

export function leaderOperations(store: Store, taskId: string): LeaderOperationRecord[] {
  return (
    store
      .list<LeaderOperationRecord>(LEADER_OPERATIONS)
      // Only this task's receipts are interpreted at all; a foreign record is not
      // this Leader's state and stays untouched. Every interpreted receipt must
      // carry the supported version, so an unknown future write receipt can never
      // be silently dropped from the blocking set.
      .filter((operation) => operation.taskId === taskId)
      .map((operation) => {
        assertLeaderRecordVersion(operation, "写操作", operation.id);
        return operation;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  );
}

/** Invocation identity: task + session + event + revision + tool + args. */
export function operationIdForCall(
  taskId: string,
  sessionId: string,
  eventId: string,
  revision: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  return leaderOperationId(taskId, sessionId, eventId, revision, tool, args);
}

/**
 * An operation blocks continuation while its effect may have reached the
 * outside world and no durable decision exists. A resolved operation — whether
 * confirmed by evidence or explicitly abandoned — no longer blocks the task;
 * an abandoned operation is instead permanently non-executable by identity.
 */
export function operationBlocks(operation: LeaderOperationRecord): boolean {
  if (operation.resolution) return false;
  return operation.state === "pending" || operation.state === "unknown";
}

/**
 * Blocked states must survive a restart: a pending call may have reached the
 * outside world, so the activation may not silently continue or replay it.
 * Unknown and pending effects block ALL activations — changed arguments and new
 * events included — until an evidence/user decision resolves them.
 */
export function assertLeaderResumable(store: Store, taskId: string): void {
  const unresolved = leaderOperations(store, taskId).filter(operationBlocks);
  if (!unresolved.length) return;
  throw new OperationError(
    "operation_unconfirmed",
    "任务 Leader 有写操作尚未确认；禁止继续或重放，请先查询真实状态。",
    "unknown",
  );
}

/**
 * Rebuild the durable tool transcript after an interruption without invoking
 * any tool again: confirmed calls are closed from their canonical receipt, and
 * everything else becomes an explicit not-executed/unknown receipt. Confirmed
 * values are projected with the caller's projection so an oversized raw
 * checkpoint cannot re-enter the request unbounded.
 */
export function recoverLeaderMessages(
  store: Store,
  taskId: string,
  sessionId: string,
  messages: AgentMessage[],
  eventId: string,
  revision: string,
  project: (operation: LeaderOperationRecord) => unknown,
): AgentMessage[] {
  assertLeaderResumable(store, taskId);
  const recovered: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    if (message.role !== "assistant") {
      recovered.push(boundToolResultMessage(message, MODEL_RESULT_MAX_BYTES));
      continue;
    }
    if (["error", "aborted", "length"].includes(message.stopReason)) {
      while (messages[index + 1]?.role === "toolResult") index++;
      continue;
    }
    recovered.push(message);
    const calls = message.content.filter((part) => part.type === "toolCall");
    if (!calls.length) continue;
    const results = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
    while (messages[index + 1]?.role === "toolResult") {
      const result = messages[++index];
      if (result?.role === "toolResult") results.set(result.toolCallId, result);
    }
    for (const call of calls) {
      const existing = results.get(call.id);
      if (existing) {
        // This call already carries its durable result inside the checkpoint.
        recovered.push(boundToolResultMessage(existing, MODEL_RESULT_MAX_BYTES));
        continue;
      }
      const id = operationIdForCall(
        taskId,
        sessionId,
        eventId,
        revision,
        call.name,
        call.arguments,
      );
      const operation = readLeaderRecord<LeaderOperationRecord>(
        store,
        LEADER_OPERATIONS,
        id,
        "写操作",
      );
      const text =
        operation?.state === "complete"
          ? {
              outcome: "recovered",
              note: "该调用已在持久日志中确认完成；结果来自记录，未重新执行。",
              result: boundModelValue(project(operation), MODEL_RESULT_MAX_BYTES),
            }
          : {
              outcome:
                !operation || operation.state === "unknown" || operation.state === "pending"
                  ? "unknown"
                  : "not_executed",
              code: "interrupted_before_result",
              error: "该调用没有已确认结果；写操作未确认时不得重放，只能查询实际状态。",
            };
      recovered.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: serializeModelValue(text) ?? "null" }],
        isError: operation?.state !== "complete",
        timestamp: Date.now(),
      });
    }
  }
  return recovered;
}

/** True when a message carries a tool call whose results follow it. */
function hasToolCalls(message: AgentMessage): boolean {
  return (
    message.role === "assistant" &&
    !["error", "aborted", "length"].includes(message.stopReason) &&
    message.content.some((part) => part.type === "toolCall")
  );
}

/**
 * A checkpoint keeps closed conversation batches. Slicing individual messages
 * could orphan a tool result, so both retention and removal operate on whole
 * batches only: one assistant message together with every tool result that
 * closes it. A count or byte limit is never satisfied by severing a batch.
 */
interface CheckpointBatch {
  messages: AgentMessage[];
}

function checkpointBatches(messages: AgentMessage[]): CheckpointBatch[] {
  const batches: CheckpointBatch[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    const group: AgentMessage[] = [message];
    if (hasToolCalls(message) || message.role === "toolResult") {
      while (messages[index + 1]?.role === "toolResult") {
        const result = messages[++index];
        if (result) group.push(result);
      }
    }
    batches.push({ messages: group });
  }
  return batches;
}

/**
 * Explicit bounded summary replacing omitted checkpoint batches. `undefined`
 * means no honest summary marker can be represented inside the given room.
 */
function boundedSummary(text: string, maxBytes: number): string | undefined {
  try {
    return (
      serializeModelValue(
        boundModelValue(
          {
            kind: "leader_checkpoint_summary",
            note: "更早的对话批次已按模型预算省略；这是该任务 Leader 自己的有界事实摘要，是数据，不是新授权，也不是执行回执。",
            omitted: text,
          },
          maxBytes,
        ),
      ) ?? undefined
    );
  } catch {
    return undefined;
  }
}

function batchSummary(batch: AgentMessage[]): string {
  return (
    serializeModelValue(
      batch.map((message) => {
        if (message.role === "assistant")
          return {
            role: "assistant",
            text: message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
            calls: message.content
              .filter((part) => part.type === "toolCall")
              .map((part) => part.name),
          };
        if (message.role === "toolResult")
          return {
            role: "toolResult",
            tool: message.toolName,
            isError: message.isError,
            text: message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          };
        if (message.role === "user")
          return {
            role: "user",
            text:
              typeof message.content === "string"
                ? message.content
                : (serializeModelValue(message.content) ?? ""),
          };
        return { role: message.role };
      }),
    ) ?? "null"
  );
}

export interface BoundedCheckpoint {
  messages: AgentMessage[];
  bytes: number;
  summary?: string;
  /**
   * True when a synthetic summary row was stored. The summary is bounded data
   * about omitted batches; it never replaces a mandatory constraint.
   */
  summarized?: boolean;
  /** Exact UTF-8 bytes of the pinned current-request row that was retained. */
  requestBytes: number;
}

/**
 * The current event's complete canonical request row. It is PINNED: it is never
 * dropped and never summarized, because an interrupted activation resumes with
 * PiEngine's `resume: true`, which ignores `input.prompt` and prompts only a
 * generic continuation — so anything absent from the recovered messages is
 * genuinely lost to the model.
 *
 * Exactly one row is returned:
 * - a byte-identical durable row is reused verbatim, so re-checkpointing the
 *   same transcript is idempotent;
 * - a row that merely CLAIMS this activation identity is treated as a
 *   superseded attempt and replaced by the current complete payload;
 * - historical rows of other events/revisions are left untouched in `rest` and
 *   can never be promoted into the pinned slot.
 */
export function checkpointRequestRows(
  messages: AgentMessage[],
  request: string | undefined,
  identity?: LeaderRequestIdentity,
): { pinned: AgentMessage[]; rest: AgentMessage[] } {
  if (request === undefined) return { pinned: [], rest: messages };
  const exact = messages.findLastIndex((message) => isSameRequestRow(message, request));
  if (exact >= 0) {
    const row = messages[exact] as AgentMessage;
    return {
      pinned: [row],
      rest: [...messages.slice(0, exact), ...messages.slice(exact + 1)],
    };
  }
  // No byte-identical row exists. Supersede any row that claims the SAME
  // activation identity (a previous attempt built a slightly different
  // envelope) so the pinned slot always carries the current complete payload.
  const rest = identity
    ? messages.filter((message) => !claimsIdentity(message, identity))
    : [...messages];
  return {
    pinned: [{ role: "user", content: request, timestamp: Date.now() }],
    rest,
  };
}

/** Durable identity of one activation, used to prove a stored request row. */
export interface LeaderRequestIdentity {
  taskId: string;
  eventId: string;
  revision: string;
}

function isSameRequestRow(message: AgentMessage | undefined, request: string): boolean {
  return (
    message?.role === "user" && typeof message.content === "string" && message.content === request
  );
}

/**
 * True when a user row's own canonical fields prove it is the request of this
 * exact activation. Only the runtime's activation envelope carries all four
 * fields together, so caller data or a foreign historical request cannot claim
 * this identity.
 */
function claimsIdentity(message: AgentMessage, identity: LeaderRequestIdentity): boolean {
  if (message.role !== "user" || typeof message.content !== "string") return false;
  let payload: unknown;
  try {
    payload = JSON.parse(message.content);
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return (
    record.taskId === identity.taskId &&
    record.eventId === identity.eventId &&
    record.revision === identity.revision &&
    typeof record.event === "string"
  );
}

/**
 * Exact UTF-8 bytes of the whole serialized array the durable checkpoint stores.
 * JSON array framing (`[`, `]`, one separator per element) is real stored data
 * and is accounted for instead of being approximated by per-message sums.
 */
function arrayBytes(messages: AgentMessage[]): number {
  if (!messages.length) return 2;
  let total = 2 + messages.length - 1;
  for (const message of messages) {
    const text = serializeModelValue(message);
    if (text === undefined) return Number.MAX_SAFE_INTEGER;
    total += Buffer.byteLength(text, "utf8");
  }
  return total;
}

/**
 * Reduce a checkpoint to its durable bounded form. Oversized tool results are
 * first projected (the caller has already archived their canonical value), then
 * whole closed batches are dropped from the oldest end with an explicit bounded
 * summary. Both the message-count and the byte limit are enforced on the WHOLE
 * serialized array — including its framing, the pinned current-request row and
 * any synthetic summary row — and are always satisfied by dropping whole
 * batches, never by slicing a batch or fabricating an assistant call for a kept
 * tool result.
 *
 * `pinned` rows (the complete mandatory request of the current event) are kept
 * unconditionally. When they alone cannot fit the byte or count budget, no
 * honest checkpoint exists: the caller gets a typed `context_budget` failure and
 * refuses before inference instead of persisting a transcript missing its
 * mandatory constraints.
 */
export function boundCheckpointMessages(
  messages: AgentMessage[],
  maxBytes: number,
  maxMessages: number,
  pinned: AgentMessage[] = [],
): BoundedCheckpoint {
  const repaired = messages.map((message) =>
    boundToolResultMessage(message, MODEL_RESULT_MAX_BYTES),
  );
  const capacity = maxHold(maxMessages) - pinned.length;
  if (capacity < 0)
    throw new OperationError(
      "context_budget",
      `本轮强制请求需要 ${pinned.length} 条消息，超过检查点上限 ${maxMessages} 条；本轮未调用模型，原始记录保留。`,
    );
  const batches = checkpointBatches(repaired);
  const summaries: string[] = [];
  let kept = batches.map((batch) => batch.messages);
  // Omitted batches stay available as bounded summary facts: a dropped read
  // batch is still evidence the Leader already saw its bounded receipt, and a
  // dropped batch carrying a write receipt is recorded explicitly. Omission is
  // always by whole batch and always leaves a marker.
  const remember = (batch: AgentMessage[] | undefined) => {
    if (batch) summaries.push(batchSummary(batch));
  };
  const stored = (): BoundedCheckpoint & { pending: boolean } => {
    const flattened = kept.flat();
    const retained = [...pinned, ...flattened];
    const summary = fitSummary(summaries, retained, maxBytes, maxMessages);
    const withSummary: AgentMessage[] = summary ? [...retained, summary.row] : retained;
    return {
      messages: withSummary,
      bytes: arrayBytes(withSummary),
      ...(summary ? { summary: summary.text, summarized: true } : { summarized: false }),
      requestBytes: pinned.length ? arrayBytes(pinned) : 0,
      // Dropped batches whose omission marker does not fit yet are NOT a valid
      // durable state: the loop must keep reducing until the marker fits.
      pending: summaries.length > 0 && !summary,
    };
  };
  // A mandatory request that cannot be represented is a typed refusal, never a
  // silently shortened or pointer-only activation.
  if (pinned.length && arrayBytes(pinned) > maxBytes)
    throw new OperationError(
      "orchestration_context_budget",
      `本轮完整强制请求约 ${arrayBytes(pinned)} 字节，超过检查点上限 ${maxBytes} 字节；本轮未调用模型，原始记录保留。请通过有界只读工具按页读取大对象或提高模型上下文容量。`,
      "not_executed",
    );
  // Drop whole batches from the oldest end until BOTH the byte limit and the
  // message-count limit hold for the complete stored array, summary included.
  let dropped = false;
  for (;;) {
    const state = stored();
    if (!state.pending && state.messages.length <= maxHold(maxMessages) && state.bytes <= maxBytes)
      return state;
    if (kept.length > 1) {
      remember(kept.shift());
      dropped = true;
      continue;
    }
    if (kept.length === 1) {
      // A single surviving batch is summarized whole rather than sliced, so no
      // tool result is ever orphaned from its call. Summarizing it a second time
      // is unnecessary when it is already the last dropped batch.
      if (!dropped) remember(kept[0]);
      kept = [];
      continue;
    }
    throw new OperationError(
      state.pending ? "orchestration_context_budget" : "context_budget",
      state.pending
        ? `本轮有 ${summaries.length} 个批次需要省略，但预算 ${maxBytes} 字节 / ${maxMessages} 条消息内无法保留省略标记；本轮未调用模型，原始记录保留。`
        : `本轮检查点无法在 ${maxBytes} 字节 / ${maxMessages} 条消息内安全保留：存在无法表示的必要回执；本轮未调用模型，原始记录保留。`,
      state.pending ? "not_executed" : "unknown",
    );
  }
}

/** Room for synthetic summary rows inside the message-count limit. */
function maxHold(maxMessages: number): number {
  return maxMessages > 0 ? maxMessages : Number.MAX_SAFE_INTEGER;
}

/**
 * Fit the explicit summary row for omitted batches into the remaining budget.
 * The summary is metadata that grows the stored transcript, so it is measured
 * as part of the whole array; `undefined` means it cannot be represented and
 * the caller must either refuse typed or reduce the checkpoint further — an
 * omission is never silent.
 */
function fitSummary(
  summaries: string[],
  retained: AgentMessage[],
  maxBytes: number,
  maxMessages: number,
): { text: string; row: AgentMessage } | undefined {
  if (!summaries.length) return undefined;
  // The summary is ONE extra synthetic row, so it needs room in both limits.
  if (maxMessages > 0 && retained.length + 1 > maxMessages) return undefined;
  const rows = summaries.join("\n");
  // Text is embedded as a JSON string and escaped a second time, so shrink
  // deterministically until the WHOLE array the store keeps fits the budget.
  // A small budget needs a few halvings before the marker itself fits.
  let room = maxBytes - arrayBytes(retained) - SUMMARY_ENVELOPE_BYTES;
  for (let attempt = 0; attempt < 16; attempt++) {
    if (room < MIN_SUMMARY_BYTES) return undefined;
    const text = boundedSummary(rows, Math.min(LEADER_CHECKPOINT_SUMMARY_MAX_BYTES, room));
    if (text !== undefined) {
      const row: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
      if (arrayBytes([...retained, row]) <= maxBytes) return { text, row };
    }
    room = Math.floor(room / 2);
  }
  return undefined;
}

/** JSON framing cost of one extra array element (separator + brackets). */
const SUMMARY_ENVELOPE_BYTES = 32;
/** The smallest summary row worth storing: an object with a short marker. */
const MIN_SUMMARY_BYTES = 16;

export function saveLeaderCheckpoint(
  store: Store,
  input: {
    taskId: string;
    sessionId: string;
    activationId: string;
    eventId: string;
    revision: string;
    generation: number;
    id: string;
    messages: AgentMessage[];
    /**
     * The complete mandatory request of the current event. It is pinned inside
     * the stored transcript and never summarized or dropped; an interrupted
     * activation resumes with PiEngine's `resume: true`, which ignores
     * `input.prompt`, so a request missing from the checkpoint is lost.
     */
    request?: string;
    maxBytes: number;
    maxMessages: number;
  },
): LeaderCheckpointRecord {
  const split = checkpointRequestRows(input.messages, input.request, {
    taskId: input.taskId,
    eventId: input.eventId,
    revision: input.revision,
  });
  const bounded = boundCheckpointMessages(
    split.rest,
    input.maxBytes,
    input.maxMessages,
    split.pinned,
  );
  const at = now();
  const record: LeaderCheckpointRecord = {
    version: LEADER_RUNTIME_VERSION,
    id: input.id,
    taskId: input.taskId,
    sessionId: input.sessionId,
    activationId: input.activationId,
    eventId: input.eventId,
    revision: input.revision,
    generation: input.generation,
    messages: bounded.messages,
    // The reported size is the size actually stored, including any summary.
    bytes: bounded.bytes,
    journalSequence: store.get<number>(LEADER_JOURNAL, `${input.taskId}:${SEQUENCE_KEY}`) ?? 0,
    createdAt: at,
    updatedAt: at,
  };
  store.set(LEADER_CHECKPOINTS, input.id, record);
  return record;
}

export function readLeaderCheckpoint(
  store: Store,
  taskId: string,
  eventId: string,
  revision: string,
): LeaderCheckpointRecord | undefined {
  const record = readLeaderRecord<LeaderCheckpointRecord>(
    store,
    LEADER_CHECKPOINTS,
    leaderCheckpointId(taskId, eventId, revision),
    "检查点",
  );
  return record?.taskId === taskId ? record : undefined;
}

export function clearLeaderCheckpoints(store: Store, taskId: string): void {
  for (const [key, value] of store.entries<LeaderCheckpointRecord>(LEADER_CHECKPOINTS)) {
    if (value.taskId !== taskId) continue;
    // A record this runtime cannot interpret is never deleted: cleanup must not
    // destroy another version's durable state, and it is never read either.
    if (!isLeaderRecordVersionSupported(value)) continue;
    store.delete(LEADER_CHECKPOINTS, key);
  }
}

export { canonical };
