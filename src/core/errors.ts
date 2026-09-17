export type Outcome = "not_executed" | "unknown";

/** Outcome describes side effects, independently of transport success. */
export class OperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly outcome: Outcome = "not_executed",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OperationError";
  }
}

export function fail(code: string, message: string): never {
  throw new OperationError(code, message);
}

export function safeError(error: unknown): { code: string; message: string; outcome: Outcome } {
  if (error instanceof OperationError) {
    return { code: error.code, message: error.message, outcome: error.outcome };
  }
  return {
    code: "internal_error",
    message: "操作未完成，请查看本机诊断状态。",
    outcome: "unknown",
  };
}

export function isNotExecuted(error: unknown): boolean {
  return error instanceof OperationError && error.outcome === "not_executed";
}
