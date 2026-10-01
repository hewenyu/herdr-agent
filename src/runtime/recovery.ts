import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../core/errors.js";
import type { Store } from "../storage/store.js";
import { serialize } from "./model-context.js";
import {
  boundedRecoveryMarker,
  boundedRecoveryToolResult,
  type RecoveryEnvelopeHooks,
  type RecoveryToolCall,
} from "./recovery-envelope.js";

export interface TurnEffect {
  status: "pending" | "complete" | "not_executed";
  result?: unknown;
  turnId?: string;
  tool?: string;
  args?: Record<string, unknown>;
  deferredReset?: {
    generation: number;
    messageId: string;
    mode?: "clear" | "new_session";
    chatId?: string;
  };
  deferredArchive?: { generation: number; messageId: string };
}

/** One model-facing tool result, before or after projection. */
export interface ProjectableToolResult {
  tool: string;
  args: Record<string, unknown>;
  toolCallId: string;
  result: unknown;
  isError?: boolean;
}
export interface PreserveCanonical {
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
  value: unknown;
  isError: boolean;
}
export interface RecoveryOptions {
  /** Model-facing byte budget for a single serialized tool result message. */
  maxBytes?: number;
  /** Canonical preservation hook; runs before bounding or projection. */
  preserve?: (input: PreserveCanonical) => void;
  /** Durable oversized-result projection; its reference replaces raw content. */
  project?: (input: ProjectableToolResult) => unknown;
  /**
   * Durable projection for legacy text that is not JSON. Such a checkpoint has
   * no parsed canonical value, so this hook receives the raw text and is the
   * only lossless durable source; without it the text is bounded as an excerpt.
   */
  projectLegacy?: (input: LegacyToolResult) => unknown;
}

/** One legacy tool result whose text could not be parsed as JSON. */
export interface LegacyToolResult {
  tool: string;
  toolCallId: string;
  text: string;
  isError: boolean;
}

/** Keep the model request bounded even when a legacy checkpoint holds raw results. */
export const RECOVERY_RESULT_MAX_BYTES = 16384;
/**
 * A recoverable checkpoint is replayed verbatim, so it must already fit one
 * request. Legacy checkpoints written before result projection can be far
 * larger; they are refused instead of replayed or retried unchanged.
 */
export function recoveryCheckpointLimit(contextTokens: number): number {
  return Math.max(64 * 1024, Math.floor(contextTokens * 2));
}

export interface RecoveryOutcome {
  /** Bounded model projection of the durable checkpoint. */
  messages: AgentMessage[];
  /**
   * Calls that had no model tool-result and were closed from the durable
   * operation journal. `completed` counts restored confirmed results; the
   * others are explicit not_executed markers.
   */
  restored: { total: number; completed: number };
}

/**
 * Close interrupted tool batches using durable receipts, never by issuing
 * another write.
 *
 * Global safety comes first: a pending or unknown effect anywhere in this turn
 * blocks recovery before any result is inferred, because the model must not
 * continue past an unconfirmed side effect. A missing result for a confirmed
 * receipt is restored from that receipt (never re-executed); only a call with
 * no `complete` receipt becomes a typed not_executed marker.
 */
export function recoverMessages(
  store: Store,
  turnId: string,
  messages: AgentMessage[],
  operationId: (name: string, args: Record<string, unknown>) => string,
  options: RecoveryOptions = {},
): AgentMessage[] {
  return recoverMessagesDetailed(store, turnId, messages, operationId, options).messages;
}

/** Same recovery as {@link recoverMessages}, with the count of restored results. */
export function recoverMessagesDetailed(
  store: Store,
  turnId: string,
  messages: AgentMessage[],
  operationId: (name: string, args: Record<string, unknown>) => string,
  options: RecoveryOptions = {},
): RecoveryOutcome {
  assertNoUnconfirmed(store, turnId);
  const maxBytes = options.maxBytes ?? RECOVERY_RESULT_MAX_BYTES;
  const recovered: AgentMessage[] = [];
  const restored = { total: 0, completed: 0 };
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    if (message.role !== "assistant") {
      recovered.push(projectResult(message, maxBytes, options));
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
      const result = results.get(call.id);
      if (result) {
        recovered.push(projectResult(result, maxBytes, options));
        continue;
      }
      recovered.push(closeMissingCall(store, call, operationId, maxBytes, options, restored));
    }
  }
  return { messages: recovered, restored };
}

/**
 * Restore the model-facing result of one call that has no checkpointed result.
 * The durable receipt is the authority: a `complete` receipt is preserved
 * canonically and returned as a successful value, never as not_executed, and no
 * call is ever executed again.
 */
function closeMissingCall(
  store: Store,
  call: RecoveryToolCall,
  operationId: (name: string, args: Record<string, unknown>) => string,
  maxBytes: number,
  options: RecoveryOptions,
  restored: { total: number; completed: number },
): AgentMessage {
  const effect = store.get<TurnEffect>("pi_operations", operationId(call.name, call.arguments));
  if (effect?.status === "pending")
    throw new OperationError(
      "operation_unconfirmed",
      "已有操作结果尚未确认，不能自动继续。",
      "unknown",
    );
  const value =
    effect?.status === "complete"
      ? (effect.result ?? null)
      : {
          outcome: "not_executed",
          code: "interrupted_before_result",
          error: "本次调用没有已确认结果；写操作尚未执行，可以按原要求继续；只读结果可重新查询。",
        };
  const isError = effect?.status !== "complete";
  restored.total++;
  if (!isError) restored.completed++;
  preserve(options.preserve, {
    toolCallId: call.id,
    tool: call.name,
    args: call.arguments,
    value,
    isError,
  });
  return toolResultMessage(call.id, call.name, value, isError, maxBytes, options);
}

/** Refuse recovery while any effect of this turn is pending or unknown. */
function assertNoUnconfirmed(store: Store, turnId: string): void {
  if (
    store
      .list<TurnEffect>("pi_operations")
      .some((e) => e.turnId === turnId && (e.status === "pending" || unknownResult(e.result)))
  )
    throw new OperationError(
      "operation_unconfirmed",
      "已有操作结果尚未确认，不能自动继续。",
      "unknown",
    );
}

/** Cheap preflight: refuses replay of a checkpoint that cannot fit one request. */
export function assertRecoverableCheckpoint(
  checkpoint: { messages?: unknown } | undefined,
  limitBytes: number,
): AgentMessage[] {
  if (!checkpoint || !Array.isArray(checkpoint.messages))
    throw new OperationError("turn_unconfirmed", "中断回合没有可恢复的检查点。", "unknown");
  const messages = checkpoint.messages as AgentMessage[];
  const text = serialize(messages);
  if (text === undefined)
    throw new OperationError("state_invalid", "检查点内容损坏；原始记录保留。", "unknown");
  if (Buffer.byteLength(text, "utf8") > limitBytes)
    throw new OperationError(
      "context_budget",
      "已保存的检查点超出模型容量；不得原样重试，请开启新会话后重新描述要求。",
      "not_executed",
    );
  return messages;
}

/**
 * Bound the durable model checkpoint. The raw value stays canonical in the
 * operation journal; only the bounded reference reaches the stored model view,
 * so a legacy or interrupted turn cannot grow the on-disk transcript.
 */
export function boundCheckpointMessages(
  messages: AgentMessage[],
  options: RecoveryOptions = {},
): AgentMessage[] {
  const maxBytes = options.maxBytes ?? RECOVERY_RESULT_MAX_BYTES;
  return messages.map((message) => projectResult(message, maxBytes, options));
}

/** Apply a durable projection to already-parsed tool results before a request. */
export function projectRecoveredResults(
  messages: AgentMessage[],
  project: (input: ProjectableToolResult) => unknown,
  maxBytes = RECOVERY_RESULT_MAX_BYTES,
): AgentMessage[] {
  return messages.map((message) =>
    message.role === "toolResult"
      ? boundedRecoveryToolResult(message, maxBytes, {
          projectValue: (input) => project(toProjectable(input)),
        })
      : message,
  );
}

function toProjectable(input: {
  tool: string;
  toolCallId: string;
  value: unknown;
  isError: boolean;
}): ProjectableToolResult {
  return {
    tool: input.tool,
    args: {},
    toolCallId: input.toolCallId,
    result: input.value,
    isError: input.isError,
  };
}

function projectResult(
  message: AgentMessage,
  maxBytes: number,
  options: RecoveryOptions,
): AgentMessage {
  if (message.role !== "toolResult") return message;
  const hooks: RecoveryEnvelopeHooks = { preserve: options.preserve };
  const project = options.project;
  if (project) hooks.projectValue = (input) => project(toProjectable(input));
  // Legacy text has no canonical value, so the same durable projection receives
  // the raw text as its result and can keep it lossless.
  const legacy = options.projectLegacy;
  if (legacy)
    hooks.projectText = (input) =>
      legacy({
        tool: input.tool,
        toolCallId: input.toolCallId,
        text: input.text,
        isError: input.isError,
      });
  else if (project)
    hooks.projectText = (input) =>
      project({
        tool: input.tool,
        args: {},
        toolCallId: input.toolCallId,
        result: input.text,
        isError: input.isError,
      });
  return boundedRecoveryToolResult(message, maxBytes, hooks);
}

function preserve(
  hook: ((input: PreserveCanonical) => void) | undefined,
  input: PreserveCanonical,
) {
  try {
    hook?.(input);
  } catch {
    // Canonical storage never converts a confirmed receipt into a failed turn.
  }
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  value: unknown,
  isError: boolean,
  maxBytes: number,
  options: RecoveryOptions,
): Extract<AgentMessage, { role: "toolResult" }> {
  const message: Extract<AgentMessage, { role: "toolResult" }> = {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: JSON.stringify(value ?? null) ?? "null" }],
    isError,
    timestamp: Date.now(),
  };
  // A restored confirmed receipt can itself be oversized. It goes through the
  // same canonical-first envelope bound as a checkpointed result, so a giant
  // restored value becomes a scoped durable reference instead of a bare marker.
  const hooks: RecoveryEnvelopeHooks = {};
  const project = options.project;
  if (project) hooks.projectValue = (input) => project(toProjectable(input));
  return boundedRecoveryToolResult(message, maxBytes, hooks);
}

/** Bound the full serialized value; never promote a failure into a success. */
export function boundRecoveryValue(value: unknown, maxBytes = RECOVERY_RESULT_MAX_BYTES): unknown {
  const text = JSON.stringify(value ?? null) ?? "null";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return value ?? null;
  const bounded = boundedRecoveryMarker(value, maxBytes);
  if (bounded === undefined)
    throw new OperationError(
      "context_budget",
      "工具结果的省略标记无法在模型预算内表示；原始结果保留在本机持久存储中，请改用只读查询。",
    );
  return bounded;
}

function unknownResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as Record<string, unknown>;
  return (
    [value.status, value.outcome].some((entry) => entry === "unknown" || entry === "unconfirmed") ||
    unknownResult(value.error)
  );
}

export function transientTurnFailure(code: string): boolean {
  return [
    "model_failed",
    "empty_response",
    "memory_unavailable",
    "checkpoint_failed",
    "turn_interrupted",
  ].includes(code);
}
