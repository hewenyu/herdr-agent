/**
 * Model-facing byte budget and lossless-ish bounding of tool results.
 *
 * Every value the model may ever see passes through {@link boundModelValue}:
 * tool results, error envelopes, recovered checkpoint entries, list pages and
 * summaries. The bound applies to the FULL serialized value (metadata included),
 * so JSON escaping can never push a "small" envelope over the budget.
 *
 * Bounding never promotes a failure into a success: outcome/status/error facts
 * and provisioning digests are copied verbatim, and the omission is explicit.
 * Canonical originals live in durable storage owned by the caller.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../core/errors.js";

/** Hard model-facing budget for one serialized tool result, in UTF-8 bytes. */
export const MODEL_RESULT_MAX_BYTES = 16384;
/**
 * Headroom kept for the tool-result message envelope (call id, tool name,
 * timestamp, error flag) so bounding the text also bounds the whole message.
 */
export const MODEL_RESULT_ENVELOPE_BYTES = 256;
/** Reserved for the provider's own framing (system prompt envelope, JSON overhead). */
export const MODEL_REQUEST_OVERHEAD_TOKENS = 1024;
/**
 * Reserved for the assistant answer. It mirrors the engine's `maxTokens`; the
 * budget must never be spent entirely on input, or a request would be rejected
 * by the provider after the context was already accepted.
 */
export const MODEL_OUTPUT_RESERVE_TOKENS = 4096;

const OMITTED =
  "完整结果超出模型结果预算；正文已省略，这不是成功回执，也不是失败回执，需要正文时按分页工具或只读查询重新获取。";
const OMITTED_SHORT = "结果超出模型预算，正文已省略。";
const UNREADABLE =
  "工具结果无法序列化，正文已省略；本次调用本身已结束，不要据此重试已完成的写操作。";
const FACT_MAX_CHARS = 240;
const DIGEST_MAX_BYTES = 4096;
const EXCERPT_MIN_BYTES = 256;

/** Keys whose scalar values carry outcome/provisioning meaning for later claims. */
const FACT_KEYS = [
  "outcome",
  "status",
  "state",
  "code",
  "id",
  "taskId",
  "participantId",
  "kind",
  "action",
  "remoteTaskId",
  "replyId",
  "messageId",
  "chatId",
  "accepted",
  "verified",
  "complete",
  "ok",
  "isError",
  "groupDeleted",
  "initialDelivery",
  "initialSent",
] as const;

/** UTF-8 bytes of the JSON the model would receive; undefined when unserializable. */
export function serializedBytes(value: unknown): number | undefined {
  const text = serialize(value);
  return text === undefined ? undefined : Buffer.byteLength(text, "utf8");
}

/**
 * Exact serialized size of the tool-result MESSAGE a provider receives for one
 * result text. It is the authority every caller has to satisfy: a value whose
 * own JSON fits `MODEL_RESULT_MAX_BYTES` can still overflow here, because its
 * text is escaped a second time inside `content` (and again by the request
 * serialization), so only a probe of this shape can prove a message is bounded.
 */
export function probeToolCall(options: {
  text: string;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  timestamp: number;
  details?: unknown;
}): number {
  return (
    serializedBytes({
      role: "toolResult",
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      content: [{ type: "text", text: options.text }],
      details: options.details ?? {},
      isError: options.isError,
      timestamp: options.timestamp,
    }) ?? Number.MAX_SAFE_INTEGER
  );
}

/**
 * Bound one tool result so the WHOLE tool-result message — text plus call id,
 * tool name, timestamp and error flag — fits `maxBytes`.
 *
 * The text is embedded as a JSON string and therefore escaped a second time, so
 * a value whose own serialization fits can still overflow the message. The bound
 * is verified against a probe of the real message shape and shrunk until it
 * holds.
 *
 * `reduceVariants` is consulted before any lossy size reduction. A durable
 * projection uses it to offer smaller canonical views of the SAME result (a
 * bounded reference whose complete source stays readable on demand), so a value
 * that cannot be represented verbatim is still represented losslessly through a
 * reachable source instead of an excerpt. A variant is accepted only when a
 * probe of the real message proves it fits.
 *
 * `fits: false` means the canonical value itself was reduced (JSON escaping
 * alone can overflow the message). `live: true` means the model still holds a
 * usable on-demand source for the complete canonical value: either the value
 * was represented verbatim (`fits: true`) or one of the derived variants was.
 * `fits: false, live: false` is a real loss and must never pass silently.
 * `fits: false, live: false, text: ""` means the irreducible metadata alone
 * exceeds the budget: the caller must refuse the request rather than send or
 * silently truncate an identity.
 */
export function boundToolResultContent(options: {
  value: unknown;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  timestamp: number;
  maxBytes?: number;
  /** Derived canonical views of the same result, most complete first. */
  reduceVariants?: (budget: number) => unknown[];
}): { text: string; fits: boolean; live: boolean } {
  const maxBytes = options.maxBytes ?? MODEL_RESULT_MAX_BYTES;
  const probe = (text: string): number =>
    probeToolCall({
      text,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      isError: options.isError,
      timestamp: options.timestamp,
    });
  // Overhead plus irreducible metadata is the floor no text can go below.
  if (probe("") > maxBytes) return { text: "", fits: false, live: false };
  // The value as the model would receive it. `fits` is decided by the MESSAGE
  // probe, never by the value's own serialized size.
  const exact = serialize(options.value);
  if (exact !== undefined && probe(exact) <= maxBytes)
    return { text: exact, fits: true, live: true };
  let budget = Math.max(4, maxBytes - probe("") - 8);
  for (let attempt = 0; attempt < 12; attempt++) {
    for (const candidate of options.reduceVariants?.(budget) ?? []) {
      const text = serialize(candidate);
      if (text === undefined || probe(text) > maxBytes) continue;
      const ownBytes = Buffer.byteLength(text, "utf8");
      return { text, fits: ownBytes <= MODEL_RESULT_MAX_BYTES, live: true };
    }
    const text = serialize(boundModelValue(options.value, budget)) ?? "null";
    if (probe(text) <= maxBytes) return { text, fits: false, live: false };
    const next = Math.floor(budget / 2);
    if (next < 4) break;
    budget = next;
  }
  const minimal = serialize(boundModelValue(options.value, 4)) ?? "null";
  return probe(minimal) <= maxBytes
    ? { text: minimal, fits: false, live: false }
    : { text: "", fits: false, live: false };
}

/** JSON text for a value, or undefined when it cannot be serialized at all. */
export function serialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value ?? null) ?? "null";
  } catch {
    return undefined;
  }
}

/**
 * Margin a durable projection keeps when it proves one of its own reference
 * envelopes survives the model boundary: the real timestamp is larger than the
 * probe's, and a provider serializes message arrays with separators of its own.
 */
export const VARIANT_ENVELOPE_MARGIN_BYTES = 48;

/**
 * On-demand proof for a projection that a reference envelope fits the model
 * boundary for THIS call identity. A projection that hands back a value the
 * message envelope cannot hold is not a durable archive: the engine would
 * reduce it to an excerpt with no reachable source, so the projection must use
 * this check (and only return a value it proves bounded).
 *
 * The check is deliberately conservative — it probes the whole tool-result
 * message, subtracts {@link VARIANT_ENVELOPE_MARGIN_BYTES}, and uses the
 * largest possible protocol error flag — so a passing value is bounded for the
 * real request too.
 */
export function variantFitsForToolMessage(options: {
  value: unknown;
  toolCallId: string;
  toolName: string;
  isError?: boolean;
  maxBytes?: number;
}): boolean {
  const maxBytes = (options.maxBytes ?? MODEL_RESULT_MAX_BYTES) - VARIANT_ENVELOPE_MARGIN_BYTES;
  const text = serialize(options.value);
  if (text === undefined) return false;
  return (
    probeToolCall({
      text,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      isError: options.isError === true,
      timestamp: 0,
    }) <= maxBytes
  );
}

/** Input tokens available for system prompt + tools + messages at this context size. */
export function modelInputBudgetTokens(contextTokens: number): number {
  return Math.max(
    0,
    Math.floor(contextTokens) - MODEL_REQUEST_OVERHEAD_TOKENS - MODEL_OUTPUT_RESERVE_TOKENS,
  );
}

/**
 * Bound the FULL serialized value to `maxBytes`. Values that already fit are
 * returned unchanged (same reference); larger values become an explicit marker
 * that keeps outcome facts and a provisioning digest.
 */
export function boundModelValue(value: unknown, maxBytes = MODEL_RESULT_MAX_BYTES): unknown {
  const text = serialize(value);
  const bytes = text === undefined ? Number.MAX_SAFE_INTEGER : Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return value;
  // `null` is the smallest JSON value (4 bytes). Below that no bounded
  // representation exists, so the caller gets a typed failure instead of a
  // value that silently breaks its budget.
  if (maxBytes < MIN_JSON_BYTES)
    throw new OperationError(
      "context_budget",
      "模型结果预算小于最小可表示值；已执行的操作不会重放，请查询实际状态。",
    );
  if (text === undefined) return unreadableMarker(maxBytes);
  return markerFor(value, text, bytes, maxBytes);
}

/** Bytes of the smallest JSON value (`null`). */
const MIN_JSON_BYTES = 4;

/** Explicit marker for a value that cannot be serialized at all. */
function unreadableMarker(maxBytes: number): unknown {
  const full: Record<string, unknown> = { omitted: UNREADABLE, truncated: true };
  if (!overBudget(full, maxBytes)) return full;
  const short: Record<string, unknown> = { omitted: OMITTED_SHORT, truncated: true };
  if (!overBudget(short, maxBytes)) return short;
  return null;
}

/** The tool-result variant of `AgentMessage`, with its own content union. */
type ToolResultAgentMessage = Extract<AgentMessage, { role: "toolResult" }>;

/**
 * Bound one tool-result message so its WHOLE serialized form fits `maxBytes`.
 *
 * Non-tool-result messages are returned untouched: rewriting an assistant tool
 * call would corrupt the provider transcript, so those are handled by the
 * request budget instead.
 *
 * The check and the bound cover everything the provider receives: the call id,
 * the tool name, the error flag, the timestamp, `details`, `usage`, non-text
 * content parts, and the DOUBLE escaping applied to the content text when the
 * message itself is serialized. A value whose own serialization fits can still
 * overflow the message — the recovered `{"body":"\\\\…"}` case — so the payload
 * is shrunk against a probe of the real message shape until the whole message
 * holds, and an explicit omission marker is used rather than raw truncation.
 *
 * Identity is never rewritten: `toolCallId`/`toolName`/`isError`/`timestamp`
 * are copied verbatim and never truncated, because a rewritten call id would
 * orphan the result from its assistant call. When the irreducible envelope
 * alone exceeds the budget, no bounded message exists: the caller gets a typed
 * `context_budget` failure and must refuse the request before the provider
 * sees it.
 *
 * Envelope fields the provider never reads (`details`, `usage`,
 * `addedToolNames`) are reduced deterministically, most-complete first, before
 * any refusal: a legacy checkpoint whose blob lives in `details` is still
 * usable, and its canonical source stays durable behind the omission marker.
 */
export function boundToolResultMessage(
  message: AgentMessage,
  maxBytes = MODEL_RESULT_MAX_BYTES,
): AgentMessage {
  if (message.role !== "toolResult") return message;
  if ((serializedBytes(message) ?? Number.MAX_SAFE_INTEGER) <= maxBytes) return message;
  const parts = Array.isArray(message.content) ? message.content : [];
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  // Non-text content (images) is content, not identity: it is never dropped
  // silently, so it stays in the probe and counts against the budget.
  const retained = parts.filter((part) => part.type !== "text");
  const value = parseJson(text) ?? text;
  const payloads = boundedPayloads(value);
  for (const envelope of envelopeVariants(message, maxBytes)) {
    const build = (payload: string): ToolResultAgentMessage => ({
      ...envelope,
      content: [...(payload ? [{ type: "text" as const, text: payload }] : []), ...retained],
    });
    const floor = serializedBytes(build("")) ?? Number.MAX_SAFE_INTEGER;
    if (floor > maxBytes) continue;
    // The text is re-escaped inside the message, so the payload budget is the
    // remaining room minus a small margin for that escaping and JSON framing.
    let budget = Math.max(MIN_JSON_BYTES, maxBytes - floor - 8);
    for (let attempt = 0; attempt < 12; attempt++) {
      const built = build(payloads(budget));
      if ((serializedBytes(built) ?? Number.MAX_SAFE_INTEGER) <= maxBytes) return built;
      const next = Math.floor(budget / 2);
      if (next < MIN_JSON_BYTES) break;
      budget = next;
    }
    // Room may remain only for the smallest explicit omission, or for none at
    // all. Both are honest; neither promotes an outcome into a success.
    for (const payload of [
      serialize({ omitted: OMITTED_SHORT, truncated: true }) ?? "null",
      serialize(boundModelValue(value, MIN_JSON_BYTES)) ?? "null",
      "",
    ])
      if ((serializedBytes(build(payload)) ?? Number.MAX_SAFE_INTEGER) <= maxBytes)
        return build(payload);
  }
  throw new OperationError(
    "context_budget",
    "工具结果的调用标识本身超出模型结果预算；标识不得截断，本轮未向模型发送该结果，请改用只读查询或开启新会话。",
  );
}

/** Payload for a payload budget: the bounded canonical value, JSON text included. */
function boundedPayloads(value: unknown): (budget: number) => string {
  const raw = serialize(value);
  // A non-JSON payload is bounded as a string, so JSON escaping of the text
  // itself can never exceed the payload budget it was given.
  const escapeBound = (budget: number): string =>
    raw === undefined ? "null" : (serialize(prefix(raw, Math.max(0, budget / 2))) ?? "null");
  return (budget) => serialize(boundModelValue(value, budget)) ?? escapeBound(budget);
}

/**
 * The same message with progressively less non-identity envelope, so metadata
 * no provider reads can never force a whole transcript to be refused.
 *
 * `toolCallId`, `toolName`, `isError` and `timestamp` are always preserved and
 * never truncated: they are the call's identity. `details`, `usage` and
 * `addedToolNames` are runtime bookkeeping. The variants shrink monotonically:
 * every optional field is first bounded at once, then the least significant
 * ones are dropped one at a time, so a message with several huge metadata
 * fields is reduced as far as the budget requires and no further.
 */
function envelopeVariants(
  message: ToolResultAgentMessage,
  maxBytes: number,
): ToolResultAgentMessage[] {
  const variants: ToolResultAgentMessage[] = [message];
  // Drop order: least significant first. `details` is kept longest because it
  // is the one runtime field that may still carry model-useful provenance.
  const optional = (["addedToolNames", "usage", "details"] as const).filter(
    (field) => (message as unknown as Record<string, unknown>)[field] !== undefined,
  );
  if (!optional.length) return variants;
  const perField = Math.max(MIN_JSON_BYTES, Math.floor(maxBytes / 4));
  const bounded: Record<string, unknown> = { ...(message as unknown as Record<string, unknown>) };
  for (const field of optional)
    bounded[field] = boundModelValue(
      (message as unknown as Record<string, unknown>)[field],
      perField,
    );
  variants.push(bounded as unknown as ToolResultAgentMessage);
  // Dropping is cumulative, so each variant is strictly smaller than the last.
  const dropped: Record<string, unknown> = { ...bounded };
  for (const field of optional) {
    delete dropped[field];
    variants.push({ ...dropped } as unknown as ToolResultAgentMessage);
  }
  return variants;
}

function markerFor(value: unknown, text: string, bytes: number, maxBytes: number): unknown {
  const record = plainObject(value);
  const facts = factValues(record);
  const digest = provisioningDigest(record, value, DIGEST_MAX_BYTES);
  const candidate: Record<string, unknown> = {
    omitted: OMITTED,
    truncated: true,
    bytes,
    ...(Array.isArray(value) ? { items: value.length } : {}),
    ...facts,
    ...(digest ? { tasks: digest } : {}),
  };
  // The excerpt is re-serialized inside the marker, so escaping can cost more
  // than the raw prefix. Shrink deterministically until the whole marker fits.
  let room = Math.max(0, maxBytes - (serializedBytes(candidate) ?? maxBytes) - 32);
  for (let attempt = 0; attempt < 8 && room >= EXCERPT_MIN_BYTES; attempt++) {
    candidate.excerpt = prefix(text, room);
    if (!overBudget(candidate, maxBytes)) return candidate;
    room = Math.floor(room / 2);
  }
  delete candidate.excerpt;
  if (overBudget(candidate, maxBytes)) delete candidate.tasks;
  if (overBudget(candidate, maxBytes)) Object.assign(candidate, shortenedFacts(facts));
  if (overBudget(candidate, maxBytes)) {
    // The facts alone may already exceed a very small budget. Reduce to the
    // smallest honest marker rather than exceeding the caller's limit.
    const minimal: Record<string, unknown> = { omitted: OMITTED_SHORT, bytes };
    if (!overBudget(minimal, maxBytes)) return minimal;
    // Below the representable floor (JSON's smallest value is `null`, 4 bytes)
    // no bounded representation exists; `null` is returned rather than a value
    // that would silently break the caller's byte budget.
    return null;
  }
  return candidate;
}

function overBudget(value: unknown, maxBytes: number): boolean {
  return (serializedBytes(value) ?? Number.MAX_SAFE_INTEGER) > maxBytes;
}

function shortenedFacts(facts: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(facts).map(([key, item]) => [
      key,
      typeof item === "string" ? truncate(item, 64) : item,
    ]),
  );
}

function factValues(record: Record<string, unknown> | undefined): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  if (!record) return facts;
  for (const key of FACT_KEYS) {
    const fact = scalar(record[key]);
    if (fact !== undefined) facts[key] = fact;
  }
  const error = record.error;
  if (typeof error === "string" && error.trim()) facts.error = truncate(error);
  else if (plainObject(error)) {
    const nested = error as Record<string, unknown>;
    const code = scalar(nested.code);
    const message = scalar(nested.message);
    if (code !== undefined) facts.errorCode = code;
    if (message !== undefined) facts.errorMessage = truncate(String(message));
  }
  return facts;
}

/**
 * Small structural digest of task facts. Provisioning evidence (remote task,
 * group, participant delivery) must survive projection, or a later resume would
 * silently lose the only model-visible proof of an already confirmed write.
 */
function provisioningDigest(
  record: Record<string, unknown> | undefined,
  value: unknown,
  maxBytes: number,
): unknown[] | undefined {
  const tasks: unknown[] = [];
  if (record) {
    if (Array.isArray(record.tasks)) tasks.push(...record.tasks.slice(0, 8));
    if (record.task !== undefined) tasks.unshift(record.task);
    if (record.id !== undefined || record.remoteTaskId !== undefined) tasks.unshift(record);
  }
  if (!tasks.length && Array.isArray(value)) tasks.push(...value.slice(0, 8));
  for (let count = Math.min(tasks.length, 8); count >= 1; count = Math.floor(count / 2)) {
    const digest = tasks.slice(0, count).map(taskFacts);
    if (serializedBytes(digest) !== undefined && mergeBytes(digest) <= maxBytes) return digest;
  }
  return undefined;
}

function mergeBytes(value: unknown): number {
  return serializedBytes(value) ?? Number.MAX_SAFE_INTEGER;
}

function taskFacts(value: unknown): Record<string, unknown> {
  const task = plainObject(value);
  if (!task) {
    const fact = scalar(value);
    return fact === undefined ? {} : { id: fact };
  }
  const facts: Record<string, unknown> = {};
  for (const key of ["id", "remoteTaskId", "chatId", "groupDeleted"] as const) {
    const fact = scalar(task[key]);
    if (fact !== undefined) facts[key] = fact;
  }
  if (Array.isArray(task.participants)) {
    facts.participants = task.participants.slice(0, 8).map((entry) => {
      const participant = plainObject(entry) ?? {};
      return {
        id: truncate(String(participant.id ?? ""), 64),
        name: truncate(String(participant.name ?? ""), 64),
        kind: truncate(String(participant.kind ?? ""), 32),
        ...(participant.initialDelivery === undefined
          ? {}
          : { initialDelivery: truncate(String(participant.initialDelivery), 32) }),
        ...(participant.initialSent === undefined
          ? {}
          : { initialSent: participant.initialSent === true }),
      };
    });
  }
  if (Array.isArray(task.participantIds))
    facts.participantIds = task.participantIds.slice(0, 16).map((id) => truncate(String(id), 64));
  return facts;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return truncate(value);
  return undefined;
}

function truncate(value: string, max = FACT_MAX_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Code-point-safe prefix under a strict UTF-8 byte cap. */
export function prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let result = "";
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return result;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
