import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface ModelDiagnostic {
  category: "timeout" | "cancelled" | "length" | "provider_error" | "aborted" | "unknown";
  stopReason: "error" | "aborted" | "length" | "unknown";
  httpStatus?: number;
}

/** Keep observable facts only: provider error bodies can contain credentials and request data. */
export function modelDiagnostic(
  message: AgentMessage | undefined,
  abortCause?: "timeout" | "cancelled",
  httpStatus?: number,
): ModelDiagnostic {
  const reason = message?.role === "assistant" ? message.stopReason : undefined;
  const stopReason =
    reason === "error" || reason === "aborted" || reason === "length" ? reason : "unknown";
  return {
    category:
      abortCause ??
      (stopReason === "error"
        ? "provider_error"
        : stopReason === "unknown"
          ? "unknown"
          : stopReason),
    stopReason,
    ...(httpStatus !== undefined &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
      ? { httpStatus }
      : {}),
  };
}
