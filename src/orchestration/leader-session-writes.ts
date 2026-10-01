import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ActorContext } from "../core/types.js";
import {
  boundModelValue,
  boundToolResultMessage,
  MODEL_RESULT_MAX_BYTES,
  serializedBytes,
  serialize as serializeModelValue,
} from "../runtime/model-context.js";
import {
  boundLeaderValue,
  LEADER_OPERATIONS,
  type LeaderOperationRecord,
  type LeaderProjection,
} from "./leader-session-types.js";

/**
 * The Leader's own durable identity is the only scope a tool can observe.
 * Caller-supplied actors never reach a tool.
 */
export function sessionActor(
  session: { id: string; taskId: string; ownerId: string },
  eventId: string,
): ActorContext {
  return {
    source: "system",
    ownerId: session.ownerId,
    chatId: `leader:${session.taskId}`,
    sessionId: session.id,
    taskId: session.taskId,
    messageId: eventId,
  };
}

export function operationArgs(operation: LeaderOperationRecord): Record<string, unknown> {
  try {
    const parsed = JSON.parse(operation.args || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Synchronous best-effort projection used for tool results and recovered
 * receipts. A projection failure is not a business failure and never triggers a
 * replay, but it also never erases the canonical value kept by the journal.
 */
export function projectValue(
  projection: LeaderProjection,
  operation: LeaderOperationRecord,
): unknown {
  return projectForSurface(projection, {
    tool: operation.tool,
    args: operationArgs(operation),
    toolCallId: operation.id,
    result: operation.result,
    isError: operation.state !== "complete",
  });
}

/** Awaiting variant; a promise-returning projection is resolved, never inlined. */
export async function projectValueAsync(
  projection: LeaderProjection,
  operation: LeaderOperationRecord,
  isError: boolean,
): Promise<unknown> {
  return projectForSurface(projection, {
    tool: operation.tool,
    args: operationArgs(operation),
    toolCallId: operation.id,
    result: operation.result,
    isError,
  });
}

/**
 * Shape one receipt for the bounded model surface. The returned value always
 * respects the model byte budget: an asynchronous or throwing projection falls
 * back to the runtime's own bounded marker, and the whole serialized envelope is
 * re-checked before it can reach a request.
 */
export function projectForSurface(
  projection: LeaderProjection,
  input: {
    tool: string;
    args: Record<string, unknown>;
    toolCallId: string;
    result: unknown;
    isError?: boolean;
  },
): unknown {
  let value: unknown;
  try {
    value = projection.projectToolResult(input);
    if (value && typeof (value as { then?: unknown }).then === "function")
      return boundLeaderValue(input.result);
  } catch {
    return boundLeaderValue(input.result);
  }
  return boundLeaderValue(value);
}

/**
 * Durable repair hook for a value inside a stored checkpoint: the raw canonical
 * body is archived by the durable result store, and the transcript keeps a
 * bounded reference the model can page back instead of a bare marker.
 *
 * The check and the bound cover the WHOLE serialized tool-result message —
 * call id, tool name, error flag, timestamp, details and the double escaping of
 * the content text — because a value that fits on its own can still overflow
 * once it is embedded in a message. Call identity is never truncated; if the
 * irreducible envelope alone cannot fit, the typed `context_budget` failure
 * from `boundToolResultMessage` propagates and the caller refuses the request
 * rather than storing or sending a transcript it cannot honour.
 */
export function repairOversizedToolResult(
  message: Extract<AgentMessage, { role: "toolResult" }>,
  projection: LeaderProjection,
): AgentMessage {
  if ((serializedBytes(message) ?? Number.MAX_SAFE_INTEGER) <= MODEL_RESULT_MAX_BYTES)
    return message;
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = text;
  }
  try {
    projection.preserve?.({
      tool: message.toolName,
      toolCallId: message.toolCallId,
      value: parsed,
      isError: message.isError === true,
    });
  } catch {
    // Preservation is best effort; the bounded projection below stays explicit.
  }
  const projected = projectForSurface(projection, {
    tool: message.toolName,
    args: {},
    toolCallId: message.toolCallId,
    result: parsed,
    isError: message.isError === true,
  });
  const serialized =
    serializeModelValue(boundModelValue(projected, MODEL_RESULT_MAX_BYTES)) ?? "null";
  // The bounded projection replaces only the content text; identity and every
  // other envelope field are preserved, and the resulting message is verified
  // against the same model boundary the provider sees.
  return boundToolResultMessage({ ...message, content: [{ type: "text", text: serialized }] });
}

export function outcomeFlags(value: unknown): { unknown: boolean; notExecuted: boolean } {
  if (!value || typeof value !== "object") return { unknown: false, notExecuted: false };
  const record = value as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : undefined;
  const values = [record.outcome, record.status, nested?.outcome, nested?.status];
  return {
    unknown: values.some((entry) => entry === "unknown" || entry === "unconfirmed"),
    notExecuted: values.some((entry) => entry === "not_executed"),
  };
}

export function classifyResult(value: unknown): LeaderOperationRecord["state"] {
  const flags = outcomeFlags(value);
  if (flags.unknown) return "unknown";
  if (flags.notExecuted) return "not_executed";
  return "complete";
}

export { LEADER_OPERATIONS };
