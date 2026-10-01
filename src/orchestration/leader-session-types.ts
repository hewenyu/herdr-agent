import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../core/errors.js";
import { canonical, stableId } from "../core/ids.js";
import {
  boundModelValue,
  MODEL_RESULT_MAX_BYTES,
  prefix as modelPrefix,
  serialize as serializeModelValue,
} from "../runtime/model-context.js";
import type { RuntimeTool } from "../runtime/types.js";
import type { Store } from "../storage/store.js";

/**
 * Durable namespaces owned by the task Leader runtime. They are deliberately
 * separate from `sessions`/`messages`/`pi_operations`: a task Leader is a
 * distinct participant with its own fresh, task-scoped context.
 */
export const LEADER_SESSIONS = "leader_sessions";
export const LEADER_MESSAGES = "leader_messages";
export const LEADER_INBOX = "leader_inbox";
export const LEADER_EVENTS = "leader_events";
export const LEADER_ACTIVATIONS = "leader_activations";
export const LEADER_OPERATIONS = "leader_operations";
export const LEADER_CHECKPOINTS = "leader_checkpoints";
export const LEADER_JOURNAL = "leader_journal";

/** Canonical journal version; recovery refuses records it cannot interpret. */
export const LEADER_RUNTIME_VERSION = 1;

/**
 * Strict durable-record version gate. A record whose version is missing, is not
 * the supported canonical version, or is not even an object cannot be
 * interpreted by this runtime: its fields may mean something different, so
 * recovery must refuse it before relying on that record for inference or an
 * effect, leaving the original record untouched. A future version is never silently
 * downgraded to the current shape, and an absent one is never assumed current.
 */
export function assertLeaderRecordVersion(record: unknown, kind: string, ref: string): void {
  if (
    record !== null &&
    typeof record === "object" &&
    (record as { version?: unknown }).version === LEADER_RUNTIME_VERSION
  )
    return;
  const version =
    record !== null && typeof record === "object"
      ? (record as { version?: unknown }).version
      : record;
  // Persisted JSON objects may shadow toString; diagnostics must not replace
  // this typed refusal with a coercion TypeError and trigger automatic retries.
  const seen =
    version !== null && typeof version === "object"
      ? Array.isArray(version)
        ? "array"
        : "object"
      : String(version);
  throw new OperationError(
    "leader_record_version_unsupported",
    `任务 Leader 的${kind}记录（${ref}）版本不受支持（${seen}）；本次读取及依赖该记录的操作已拒绝，原始记录保留。`,
    "not_executed",
  );
}

/** Version support only; callers retain their separate identity and state checks. */
export function isLeaderRecordVersionSupported(record: unknown): boolean {
  return (
    record !== null &&
    typeof record === "object" &&
    (record as { version?: unknown }).version === LEADER_RUNTIME_VERSION
  );
}

/**
 * Read one durable Leader record by its exact key and refuse an uninterpretable
 * version. Callers at recovery/authorization boundaries use this instead of a
 * raw `store.get`, so an unknown future record can never be silently treated as
 * absent — which for a write receipt would authorize a replay.
 */
export function readLeaderRecord<T>(
  store: Store,
  namespace: string,
  key: string,
  kind: string,
): T | undefined {
  const record = store.get<T>(namespace, key);
  if (record === undefined) return undefined;
  assertLeaderRecordVersion(record, kind, key);
  return record;
}

/** Model-facing byte bounds. Canonical receipts keep the full value separately. */
export const LEADER_RESULT_MAX_BYTES = MODEL_RESULT_MAX_BYTES;
/**
 * Largest activation payload that is still complete. It is deliberately below
 * the model result budget because the activation also carries the bounded
 * history; an input above it is refused with a typed budget error rather than
 * silently severed.
 */
export const LEADER_PROMPT_MAX_BYTES = 12288;
export const LEADER_HISTORY_MAX_BYTES = 24576;
export const LEADER_MESSAGE_MAX_BYTES = 16384;
export const LEADER_CHECKPOINT_MAX_BYTES = 262144;
export const LEADER_CHECKPOINT_MAX_MESSAGES = 80;
/** Bounds for the explicit bounded summary that replaces omitted checkpoints. */
export const LEADER_CHECKPOINT_SUMMARY_MAX_BYTES = 8192;
export const LEADER_CHECKPOINT_SUMMARY_MAX_MESSAGES = 60;

/** Bounded retries: an unchanged oversized activation can never retry forever. */
export const LEADER_MAX_ATTEMPTS = 3;

export type LeaderActivationState = "active" | "recorded" | "failed" | "superseded" | "abandoned";

export type LeaderInboxState = "pending" | "active" | "recorded" | "failed" | "superseded";

export type LeaderOperationState = "pending" | "complete" | "unknown" | "not_executed";

/** One task-scoped Leader conversation; never the outer management session. */
export interface LeaderSessionRecord {
  version: number;
  id: string;
  taskId: string;
  ownerId: string;
  generation: number;
  status: "idle" | "active";
  lastEventId?: string;
  lastRevision?: string;
  createdAt: string;
  updatedAt: string;
}

/** The persisted message surface a later activation (or a cold resume) reuses. */
export interface LeaderMessageRecord {
  version: number;
  id: string;
  sequence: number;
  sessionId: string;
  taskId: string;
  ownerId: string;
  role: "event" | "assistant" | "tool" | "note";
  source: string;
  eventId?: string;
  revision?: string;
  activationId?: string;
  text: string;
  bytes: number;
  truncated: boolean;
  /** Canonical source kept outside the model surface when text was bounded. */
  sourceRef?: string;
  callId?: string;
  createdAt: string;
}

/** Stable per-event receipt: the identity that makes duplicate delivery safe. */
export interface LeaderInboxRecord {
  version: number;
  id: string;
  key: string;
  taskId: string;
  sessionId: string;
  ownerId: string;
  eventId: string;
  revision: string;
  state: LeaderInboxState;
  attempts: number;
  activationId?: string;
  /** Bounded final answer of the recorded activation; replay returns it verbatim. */
  resultText?: string;
  errorCode?: string;
  errorOutcome?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** Event-level pointer across revisions; supersession never rewrites old receipts. */
export interface LeaderEventRecord {
  version: number;
  taskId: string;
  eventId: string;
  ownerId: string;
  revisions: string[];
  currentRevision: string;
  state: LeaderInboxState;
  inboxIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LeaderActivationRecord {
  version: number;
  id: string;
  taskId: string;
  sessionId: string;
  ownerId: string;
  eventId: string;
  revision: string;
  inboxId: string;
  attempt: number;
  state: LeaderActivationState;
  /** Runtime outcome only. It never claims business completion. */
  businessCompletion: "unknown";
  contextBytes: number;
  resumed: boolean;
  engineCalls: number;
  toolCalls: number;
  writeCalls: number;
  errorCode?: string;
  errorOutcome?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
}

/**
 * Canonical operation journal entry: full result, never the model projection.
 * Identity is `(task, session, event, revision, tool, args)`: a duplicate
 * delivery of one event+revision deduplicates, while a separately authorized
 * new event with identical arguments is a distinct operation that must run.
 */
export interface LeaderOperationRecord {
  version: number;
  /** Stable for one event+revision invocation; never reused across events. */
  id: string;
  taskId: string;
  sessionId: string;
  ownerId: string;
  tool: string;
  readOnly: boolean;
  args: string;
  argsCanonical: string;
  eventId: string;
  revision: string;
  activationId: string;
  state: LeaderOperationState;
  /**
   * Confirmed canonical value. A resolution records its decision here while the
   * original invocation value stays in `invocationResult` for audit.
   */
  result?: unknown;
  /** What the original invocation returned or threw, never overwritten. */
  invocationResult?: unknown;
  resolution?: {
    choice: "treat_done" | "abandon";
    decidedBy: "evidence" | "user";
    reason: string;
    at: string;
  };
  resultBytes?: number;
  error?: { code: string; message: string; outcome: string };
  createdAt: string;
  updatedAt: string;
}

/** Actual compacted model messages for the interrupted activation, not a view. */
export interface LeaderCheckpointRecord {
  version: number;
  id: string;
  taskId: string;
  sessionId: string;
  activationId: string;
  eventId: string;
  revision: string;
  generation: number;
  messages: AgentMessage[];
  bytes: number;
  journalSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeaderJournalEntry {
  version: number;
  sequence: number;
  at: string;
  kind:
    | "activation_started"
    | "checkpoint"
    | "activation_recorded"
    | "activation_failed"
    | "activation_abandoned"
    | "operation_pending"
    | "operation_complete"
    | "operation_unknown"
    | "operation_not_executed"
    | "event_superseded"
    | "duplicate_event"
    | "recovery_receipt";
  taskId: string;
  sessionId: string;
  activationId?: string;
  eventId?: string;
  revision?: string;
  detail?: unknown;
}

export interface LeaderSessionSummary {
  version: number;
  taskId: string;
  sessionId?: string;
  ownerId?: string;
  messages: number;
  inbox: Record<LeaderInboxState | "total", number>;
  activations: Record<LeaderActivationState | "total", number>;
  operations: Record<LeaderOperationState | "total", number>;
  journalEntries: number;
  checkpointBytes: number;
  /** A returned activation is not a business result; this stays "unknown". */
  businessCompletion: "unknown";
}

export function leaderSessionId(taskId: string): string {
  return `task-leader:${taskId}`;
}

/**
 * Stable durable scope for one task Leader. It deliberately ignores the caller's
 * outer session id and the current event: earlier references stay readable by
 * later activations, while owner/task isolation remains enforced by the store.
 */
export function leaderScope(taskId: string): string {
  return `leader:${taskId}`;
}

export function leaderInboxId(taskId: string, eventId: string, revision: string): string {
  return `li_${stableId(taskId, eventId, revision)}`;
}

export function leaderEventKey(taskId: string, eventId: string): string {
  return `${taskId}:${eventId}`;
}

export function leaderActivationId(
  taskId: string,
  eventId: string,
  revision: string,
  attempt: number,
) {
  return `la_${stableId(taskId, eventId, revision, String(attempt))}`;
}

/**
 * Write receipts are keyed by the full invocation identity, including the
 * canonical event and revision. A retry of one event deduplicates; a new event
 * with identical arguments is a different operation and executes its own work.
 */
export function leaderOperationId(
  taskId: string,
  sessionId: string,
  eventId: string,
  revision: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  return `lo_${stableId(taskId, sessionId, eventId, revision, tool, canonical(args))}`;
}

export function leaderMessageId(
  sessionId: string,
  role: string,
  eventId: string,
  revision: string,
  index: number,
): string {
  return `lm_${stableId(sessionId, role, eventId, revision, String(index))}`;
}

/** Stable per event+revision: a cold resume finds the interrupted activation. */
export function leaderCheckpointId(taskId: string, eventId: string, revision: string): string {
  return `lc_${stableId(taskId, eventId, revision)}`;
}

/**
 * Safe accessor used by modules that must not import the context module eagerly.
 * The durable rows feed both the recovered model transcript and sequence
 * numbering, so a row this runtime cannot interpret is refused typed instead of
 * being silently replayed into a request or skipped past.
 */
export function leaderTaskMessagesSafe(store: Store, taskId: string): LeaderMessageRecord[] {
  return store
    .list<LeaderMessageRecord>(LEADER_MESSAGES)
    .filter((message) => message.taskId === taskId)
    .map((message) => {
      assertLeaderRecordVersion(message, "消息", message.id);
      return message;
    })
    .sort((a, b) => a.sequence - b.sequence);
}

export function leaderBytes(value: unknown): number {
  return serializeModelValue(value) === undefined
    ? Number.MAX_SAFE_INTEGER
    : Buffer.byteLength(serializeModelValue(value) as string, "utf8");
}

/**
 * Bound the FULL serialized tool value before it can reach a model request.
 * The whole envelope — marker, facts, note, metadata — must fit inside the
 * declared budget, including JSON re-escaping of the preview. A forged
 * `leaderBounded` marker is treated like any other oversized value.
 */
export function boundLeaderValue(value: unknown, maxBytes = LEADER_RESULT_MAX_BYTES): unknown {
  return boundModelValue(value, maxBytes);
}

/**
 * Bounded UTF-8 text. The returned string — body plus marker, counted in UTF-8
 * bytes — never exceeds `maxBytes`, and the marker is shortened when the limit
 * is too small to hold it.
 */
export function boundLeaderText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const size = Buffer.byteLength(text, "utf8");
  if (size <= maxBytes) return { text, truncated: false };
  const note = (budget: number) =>
    `\n[内容已截断；完整原文见持久记录，未丢失。上限 ${budget} 字节。]`;
  let marker = note(maxBytes);
  if (Buffer.byteLength(marker, "utf8") + 1 > maxBytes) {
    marker = "\n[已截断]";
    if (Buffer.byteLength(marker, "utf8") > maxBytes) marker = "";
  }
  const limit = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  return { text: `${modelPrefix(text, limit)}${marker}`, truncated: true };
}

/** The engine callback shape from the frozen interface; kept structural on purpose. */
export interface LeaderProjectionInput {
  tool: string;
  args: Record<string, unknown>;
  toolCallId: string;
  result: unknown;
  isError?: boolean;
}

export type LeaderResultProjection = (input: LeaderProjectionInput) => unknown | Promise<unknown>;

export interface LeaderProjection {
  projectToolResult: LeaderResultProjection;
  /**
   * Optional read-only pagination tool supplied by the durable result store.
   * Typed structurally so the module graph stays free of runtime cycles.
   */
  tool?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    readOnly?: boolean;
    execute?: (...args: never[]) => unknown;
  };
  /**
   * Optional durable archival hook used when repairing a checkpoint that was
   * written before projection existed. Its failure never changes an outcome.
   */
  preserve?: (input: {
    tool: string;
    toolCallId: string;
    value: unknown;
    isError: boolean;
  }) => void;
  scope: string;
  source: "durable-store" | "runtime-bound";
}

export type LeaderProjectionTool = NonNullable<LeaderProjection["tool"]> & {
  description: string;
  parameters: Record<string, unknown>;
  readOnly: true;
  execute: RuntimeTool["execute"];
};

export function projectionToolCandidate(
  tool: LeaderProjection["tool"],
): LeaderProjectionTool | undefined {
  if (!tool?.name?.trim()) return undefined;
  if (typeof tool.execute !== "function") return undefined;
  return {
    ...tool,
    name: tool.name.trim(),
    description: tool.description ?? "读取已持久化的工具结果分页。",
    parameters: tool.parameters ?? { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute: tool.execute as RuntimeTool["execute"],
  };
}
