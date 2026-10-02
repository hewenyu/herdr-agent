/**
 * Whole-envelope bounding for durable recovery checkpoints.
 *
 * `model-context.ts` owns the model-facing byte budget and value-level
 * bound; this module owns the *message* envelope. A value that fits its own
 * budget can still overflow once it is embedded in a tool-result message:
 * JSON escaping doubles every backslash, `details` and other metadata fields add
 * bytes, and legacy text may not even be JSON. Every message written to a
 * durable checkpoint or replayed to a provider is therefore measured and
 * reduced as a WHOLE message in UTF-8 bytes.
 *
 * Protocol identity is never rewritten. `role`, `toolCallId` and `toolName` are
 * copied verbatim; when no bounded representation of the message exists, the
 * caller gets a typed `context_budget` failure instead of a silently truncated
 * call identity or an oversized request that the provider would reject later.
 *
 * Canonical bodies stay retrievable: the durable projection and the canonical
 * preservation hook run before any reduction, and the omission marker never
 * claims that a body was stored when persistence was not proven.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../core/errors.js";
import { escapedBytes, escapedPrefix } from "./escaped-bytes.js";
import { parseJson, plainObject } from "./json.js";
import { serialize } from "./model-context.js";

/** One tool call as it appears in an assistant message. */
export type RecoveryToolCall = Extract<
  Extract<AgentMessage, { role: "assistant" }>["content"][number],
  { type: "toolCall" }
>;

/** One model-facing tool-result message. */
export type ToolResultEnvelope = Extract<AgentMessage, { role: "toolResult" }>;

/** Canonical preservation hook input, structurally identical to `recovery.ts`. */
export interface EnvelopePreserveInput {
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
  value: unknown;
  isError: boolean;
}

/** Durable seams consulted before any reduction. */
export interface RecoveryEnvelopeHooks {
  /** Projection of an already-parsed canonical value that exceeds the budget. */
  projectValue?: (input: {
    tool: string;
    toolCallId: string;
    value: unknown;
    isError: boolean;
  }) => unknown;
  /**
   * Durable projection of the TEXT of a message the envelope budget cannot
   * hold. It receives unparseable legacy text, and parsed text whose escaping
   * alone overflows while the parsed value itself still fits. It is the only
   * lossless durable source for those messages, so it is consulted before any
   * marker is built.
   */
  projectText?: (input: {
    tool: string;
    toolCallId: string;
    text: string;
    isError: boolean;
  }) => unknown;
  /** Canonical preservation hook; runs before any reduction. */
  preserve?: (input: EnvelopePreserveInput) => void;
}

const OMITTED =
  "工具结果超出模型预算，正文已省略。这不表示成功或失败，也不表示正文已持久保存；需要正文时请重新只读查询，或按结果中的 reference 分页读取。";
const OMITTED_SHORT = "工具结果超出模型预算，正文已省略。";
/** Fact keys that carry outcome, identity or paging meaning for later claims. */
const FACT_KEYS = [
  "outcome",
  "status",
  "state",
  "code",
  "kind",
  "action",
  "id",
  "taskId",
  "remoteTaskId",
  "participantId",
  "replyId",
  "messageId",
  "chatId",
  "reference",
  "persisted",
  "tool",
  "toolCallId",
  "pageCount",
  "pageBytes",
  "bytes",
  "totalBytes",
  "accepted",
  "verified",
  "complete",
  "ok",
  "groupDeleted",
] as const;
/**
 * Classification tokens decide whether a result is a success, a refusal or an
 * unknown effect. They are copied verbatim or dropped, never truncated: a
 * truncated `not_executed` would read as a different outcome.
 */
const CLASSIFICATION_KEYS = ["outcome", "status", "state"] as const;
const CLASSIFICATION_MAX_BYTES = 64;
const FACT_CAP_ROUNDS = [240, 96, 32, 8, 0];
const MAX_FACT_BYTES = 240;
const EXCERPT_BYTES = 256;

/** UTF-8 bytes of a value's JSON, or MAX_SAFE_INTEGER when unserializable. */
export function envelopeBytes(value: unknown): number {
  const text = serialize(value);
  return text === undefined ? Number.MAX_SAFE_INTEGER : Buffer.byteLength(text, "utf8");
}

/** UTF-8 bytes one text field costs inside a JSON envelope (quotes excluded). */
export { escapedBytes };

/** Model-facing text of one tool result; never interprets or rewrites it. */
export function toolResultText(message: ToolResultEnvelope): string {
  const content: unknown = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const entry = part as { type?: unknown; text?: unknown };
    if (entry?.type === "text" && typeof entry.text === "string") parts.push(entry.text);
  }
  return parts.join("\n");
}

/**
 * Escaped-byte room left for the text of one tool-result message before it
 * exceeds `maxBytes`. Optional fields that may be dropped under pressure are
 * already excluded, so the returned room is achievable.
 */
export function toolResultTextRoom(message: ToolResultEnvelope, maxBytes: number): number {
  let smallest = envelopeBytes(withText(message, ""));
  for (const round of slimRounds(message)) {
    smallest = Math.min(smallest, envelopeBytes(withText(round, "")));
  }
  return Math.max(0, maxBytes - smallest);
}

/**
 * Bound one recovered tool-result message so its complete serialized envelope
 * fits `maxBytes`. The durable projection and the preservation hook run before
 * any reduction, and the original outcome/isError semantics are preserved by
 * the marker. Throws typed `context_budget` when the irreducible message (call
 * identity plus required envelope fields) cannot fit.
 */
export function boundedRecoveryToolResult(
  message: ToolResultEnvelope,
  maxBytes: number,
  hooks: RecoveryEnvelopeHooks = {},
): ToolResultEnvelope {
  if (envelopeBytes(message) <= maxBytes) return message;
  const text = toolResultText(message);
  const parsed = parseJson(text);
  const isError = message.isError === true;
  // A legacy text result has no canonical value, so the durable projection
  // receives the raw text itself: it is the lossless source when it succeeds.
  const preserved = parsed === undefined ? text : parsed;
  safePreserve(hooks.preserve, {
    tool: message.toolName,
    toolCallId: message.toolCallId,
    args: {},
    value: preserved,
    isError,
  });
  const identity = { tool: message.toolName, toolCallId: message.toolCallId, isError };
  if (parsed === undefined) {
    // Legacy text has no canonical value: the durable projection receives the
    // raw text itself and is the only lossless source for it. A hook that
    // returns nothing is not a durable reference, so the marker is the answer.
    const projected = serializedProjection(safeProject(hooks.projectText, { ...identity, text }));
    return enforceToolResultEnvelope(
      projected === undefined ? message : withText(message, projected),
      maxBytes,
    );
  }
  const valueBytes = envelopeBytes(parsed);
  if (valueBytes > maxBytes) {
    // The canonical value is the same one the engine would have projected live,
    // so its durable reference replaces the raw body. Reduction still reads its
    // outcome facts from the canonical value, never from the projection.
    const projected = serializedProjection(
      safeProject(hooks.projectValue, { ...identity, value: parsed }),
    );
    if (projected !== undefined)
      return enforceToolResultEnvelope(withText(message, projected), maxBytes, parsed);
  }
  // Only the message envelope overflows while the value itself fits. The value
  // is re-serialized verbatim (full fidelity, no durable copy is needed) and
  // only reduced by the envelope's own optional-field rounds.
  return enforceToolResultEnvelope(message, maxBytes, parsed);
}

/**
 * JSON text for a projection result, or `undefined` when the projection did not
 * produce a usable value. `serialize` maps `undefined` to `"null"`, which would
 * silently replace a canonical body with an empty one.
 */
function serializedProjection(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return serialize(value);
}

/**
 * Final guarantee for a message that is already supposed to be bounded. It
 * verifies the COMPLETE serialized envelope whatever its source was — a custom
 * projection is never trusted to have bounded itself — and reduces optional
 * fields and content deterministically. Protocol identity is untouched.
 *
 * `canonical` is the value this message claims to represent. When the message's
 * own body is replaced, the replacement is built from that canonical value, so
 * a projection can never promote a failed result into a success by returning an
 * envelope that contradicts it.
 */
export function enforceToolResultEnvelope(
  message: ToolResultEnvelope,
  maxBytes: number,
  canonical?: unknown,
): ToolResultEnvelope {
  if (envelopeBytes(message) <= maxBytes) return message;
  let slim = message;
  for (const round of slimRounds(message)) {
    if (envelopeBytes(round) <= maxBytes) return round;
    slim = round;
  }
  const text = toolResultText(slim);
  // Outcome facts are taken from the canonical value, never from a projected
  // envelope: projection may omit detail, it may not reclassify an effect.
  const source = canonical !== undefined ? canonical : parseJson(text);
  const marker = recoveryMarkerText(
    source,
    text,
    slim.isError === true,
    toolResultTextRoom(slim, maxBytes),
  );
  if (marker !== undefined) {
    const bounded = withText(slim, marker);
    if (envelopeBytes(bounded) <= maxBytes) return bounded;
  }
  // No honest bounded representation exists: a truncated body could be read as
  // a complete receipt, so the caller gets a typed failure instead of one.
  throw new OperationError(
    "context_budget",
    "工具结果信封（调用标识与必要字段）无法在模型预算内表示；已执行的操作不会重放，请查询实际状态或改用只读引用。",
  );
}

/**
 * Bounded marker for one oversized value, or `undefined` when no honest marker
 * fits `maxBytes`. Classification facts survive every round; an omitted body is
 * never presented as a success.
 */
export function boundedRecoveryMarker(
  value: unknown,
  maxBytes: number,
): Record<string, unknown> | undefined {
  const text = serialize(value ?? null);
  const record = plainObject(value);
  const bytes = text === undefined ? undefined : Buffer.byteLength(text, "utf8");
  const isError = provisionalError(record);
  for (const candidate of markerCandidates(record, bytes, text ?? "", isError, maxBytes)) {
    if (envelopeBytes(candidate) <= maxBytes) return candidate;
  }
  return undefined;
}

/** JSON text for one recovered message text field. */
function recoveryMarkerText(
  value: unknown,
  text: string,
  isError: boolean,
  room: number,
): string | undefined {
  if (room <= 0) return undefined;
  const record = plainObject(value);
  const bytes = Buffer.byteLength(text, "utf8");
  for (const candidate of markerCandidates(record, bytes, text, isError, room)) {
    const serialized = serialize(candidate);
    if (serialized !== undefined && escapedBytes(serialized) <= room) return serialized;
  }
  return undefined;
}

/** Candidate markers from most informative to smallest honest omission. */
function markerCandidates(
  record: Record<string, unknown> | undefined,
  bytes: number | undefined,
  text: string,
  isError: boolean,
  room: number,
): Array<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    omitted: OMITTED,
    ...(bytes === undefined ? {} : { bytes }),
    isError,
    outcome: "unknown",
  };
  const excerptRoom = Math.min(EXCERPT_BYTES, Math.max(0, Math.floor(room / 4)));
  const excerpt = excerptRoom > 0 ? escapedPrefix(text, excerptRoom) : "";
  // Every round is prepared first, then candidates are emitted by fidelity
  // rather than by round: error evidence at a tighter cap is always preferred
  // over a plain marker with a roomier one, so a reduction never drops the
  // code/message that explains an unknown or refused result.
  const rounds = FACT_CAP_ROUNDS.map((cap) => ({
    facts: { ...base, ...factValues(record, cap) },
    error: errorEnvelope(record, cap),
  }));
  const candidates: Array<Record<string, unknown>> = [];
  if (excerpt)
    for (const round of rounds)
      if (round.error !== undefined)
        candidates.push({ ...round.facts, error: round.error, excerpt });
  for (const round of rounds)
    if (round.error !== undefined) candidates.push({ ...round.facts, error: round.error });
  for (const round of rounds) candidates.push(round.facts);
  const mandatory = mandatoryFacts(record);
  candidates.push({ ...base, ...mandatory });
  candidates.push(base);
  candidates.push({
    omitted: OMITTED_SHORT,
    ...(bytes === undefined ? {} : { bytes }),
    isError,
    ...mandatory,
  });
  candidates.push({ omitted: OMITTED_SHORT, isError, ...mandatory });
  candidates.push({ omitted: OMITTED_SHORT, isError });
  candidates.push({ outcome: "unknown" });
  return candidates;
}

/** Classification and identity facts with byte-capped non-classification values. */
function factValues(
  record: Record<string, unknown> | undefined,
  cap: number,
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  if (!record) return facts;
  for (const key of FACT_KEYS) {
    const value = record[key];
    if (typeof value === "boolean" || typeof value === "number") {
      facts[key] = value;
      continue;
    }
    if (typeof value !== "string" || !value.trim()) continue;
    if (isClassification(key)) {
      if (escapedBytes(value) <= CLASSIFICATION_MAX_BYTES) facts[key] = value;
      continue;
    }
    const capped = truncateEscaped(value, cap);
    if (capped) facts[key] = capped;
  }
  return facts;
}

/** Round of last resort: classification facts only, never truncated. */
function mandatoryFacts(record: Record<string, unknown> | undefined): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  if (!record) return facts;
  for (const key of CLASSIFICATION_KEYS) {
    const value = record[key];
    if (
      typeof value === "string" &&
      value.trim() &&
      escapedBytes(value) <= CLASSIFICATION_MAX_BYTES
    )
      facts[key] = value;
  }
  return facts;
}

/**
 * Nested error evidence, kept as a JSON string so both a canonical error
 * envelope and a bare error message stay readable after reduction.
 */
function errorEnvelope(
  record: Record<string, unknown> | undefined,
  cap: number,
): string | undefined {
  const error = record?.error;
  if (typeof error === "string") {
    const text = truncateEscaped(error, Math.max(cap, MAX_FACT_BYTES));
    return text || undefined;
  }
  if (!plainObject(error)) return undefined;
  const nested = error as Record<string, unknown>;
  const envelope: Record<string, unknown> = {};
  for (const key of ["code", "message", "outcome", "status"] as const) {
    const value = nested[key];
    if (typeof value === "boolean" || typeof value === "number") {
      envelope[key] = value;
      continue;
    }
    if (typeof value !== "string" || !value.trim()) continue;
    if (isClassification(key)) {
      if (escapedBytes(value) <= CLASSIFICATION_MAX_BYTES) envelope[key] = value;
      continue;
    }
    const capped = truncateEscaped(value, cap);
    if (capped) envelope[key] = capped;
  }
  return Object.keys(envelope).length ? serialize(envelope) : undefined;
}

/** True when the canonical value itself announces a non-successful outcome. */
function provisionalError(record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  const nested = plainObject(record.error) ? (record.error as Record<string, unknown>) : undefined;
  for (const value of [record.outcome, record.status, nested?.outcome, nested?.status]) {
    if (value === "unknown" || value === "unconfirmed" || value === "not_executed") return true;
  }
  return typeof record.error === "string" && record.error.trim().length > 0;
}

function isClassification(key: string): boolean {
  return (CLASSIFICATION_KEYS as readonly string[]).includes(key);
}

/** Reduction rounds that only drop optional, non-identity metadata. */
function slimRounds(message: ToolResultEnvelope): ToolResultEnvelope[] {
  const rounds: ToolResultEnvelope[] = [];
  const record = message as unknown as Record<string, unknown>;
  const hasOptional = record.usage !== undefined || record.addedToolNames !== undefined;
  if (message.details !== undefined) rounds.push({ ...message, details: {} });
  if (hasOptional) {
    const slim: Record<string, unknown> = { ...record };
    delete slim.usage;
    delete slim.addedToolNames;
    if (message.details !== undefined)
      rounds.push({ ...slim, details: {} } as unknown as ToolResultEnvelope);
    rounds.push(slim as unknown as ToolResultEnvelope);
  }
  return rounds;
}

function withText(message: ToolResultEnvelope, text: string): ToolResultEnvelope {
  return { ...message, content: [{ type: "text", text }] };
}

function safePreserve(
  hook: ((input: EnvelopePreserveInput) => void) | undefined,
  input: EnvelopePreserveInput,
): void {
  try {
    hook?.(input);
  } catch {
    // Canonical storage never converts a confirmed receipt into a failed turn.
  }
}

function safeProject<T>(hook: ((input: T) => unknown) | undefined, input: T): unknown {
  if (!hook) return undefined;
  try {
    return hook(input);
  } catch {
    // Projection failure never replays confirmed work; the marker is the fallback.
    return undefined;
  }
}

/** Truncate one fact by escaped bytes, keeping the ellipsis inside the cap. */
function truncateEscaped(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (escapedBytes(value) <= maxBytes) return value;
  const ellipsis = escapedBytes("…");
  if (maxBytes <= ellipsis) return escapedPrefix(value, maxBytes);
  const prefix = escapedPrefix(value, maxBytes - ellipsis);
  return prefix ? `${prefix}…` : escapedPrefix(value, maxBytes);
}
