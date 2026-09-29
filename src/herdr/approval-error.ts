import { OperationError, safeError } from "../core/errors.js";

/** Safe diagnostics separate transport/observation failures from model selection. */
export class ApprovalEffectError extends OperationError {
  constructor(
    code: "input_unconfirmed" | "approval_unconfirmed",
    message: string,
    readonly phase: "send_keys" | "settle" | "identity" | "readback",
    readonly reason: string,
    cause?: unknown,
  ) {
    super(code, message, "unknown", { cause });
  }
}

export function approvalFailureEvidence(error: unknown) {
  return error instanceof ApprovalEffectError
    ? { phase: error.phase, reason: error.reason, causeCode: safeError(error.cause).code }
    : undefined;
}
