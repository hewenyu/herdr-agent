import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { ModelConfig } from "../../src/config/types.js";

export const config: ModelConfig = {
  enabled: true,
  provider: "openai-responses",
  model: "test",
  baseUrl: "http://127.0.0.1:1/v1",
  apiKey: "test-secret",
  timeoutMs: 3000,
  contextTokens: 50000,
};
export function response(text: string, calls: ToolCall[] = []): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "myrix",
    model: "test",
    timestamp: Date.now(),
    content: [...(text ? [{ type: "text" as const, text }] : []), ...calls],
    stopReason: calls.length ? "toolUse" : "stop",
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
export function scripted(
  messages: AssistantMessage[],
  inspect?: (context: Parameters<StreamFn>[1]) => void,
): StreamFn {
  return (_model, context) => {
    inspect?.(context);
    const stream = new AssistantMessageEventStream();
    const message = messages.shift();
    if (!message) throw new Error("unexpected model call");
    stream.push({ type: "start", partial: message });
    if (message.stopReason === "error" || message.stopReason === "aborted")
      stream.push({ type: "error", reason: message.stopReason, error: message });
    else if (message.stopReason !== "pending")
      stream.push({ type: "done", reason: message.stopReason, message });
    return stream;
  };
}
