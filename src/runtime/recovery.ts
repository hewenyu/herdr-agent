import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../core/errors.js";
import type { Store } from "../storage/store.js";

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

/** Close interrupted tool batches using durable receipts, never by issuing another write. */
export function recoverMessages(
  store: Store,
  turnId: string,
  messages: AgentMessage[],
  operationId: (name: string, args: Record<string, unknown>) => string,
): AgentMessage[] {
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
  const recovered: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    if (message.role !== "assistant") {
      recovered.push(message);
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
        recovered.push(result);
        continue;
      }
      const effect = store.get<TurnEffect>("pi_operations", operationId(call.name, call.arguments));
      if (effect?.status === "pending")
        throw new OperationError(
          "operation_unconfirmed",
          "已有操作结果尚未确认，不能自动继续。",
          "unknown",
        );
      recovered.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              effect?.status === "complete"
                ? (effect.result ?? null)
                : {
                    outcome: "not_executed",
                    code: "interrupted_before_result",
                    error:
                      "本次调用没有已确认结果；写操作尚未执行，可以按原要求继续；只读结果可重新查询。",
                  },
            ),
          },
        ],
        isError: effect?.status !== "complete",
        timestamp: Date.now(),
      });
    }
  }
  return recovered;
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
