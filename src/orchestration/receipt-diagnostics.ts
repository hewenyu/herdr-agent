import { OperationError } from "../core/errors.js";

export interface ReceiptDiagnostic {
  field: string;
  reason: string;
  expected?: string;
  actual?: string;
}

/** Structured protocol failures remain distinguishable from source/authority failures. */
export class ReceiptError extends OperationError {
  constructor(
    code: string,
    message: string,
    readonly details: ReceiptDiagnostic[],
    readonly recoverable = true,
  ) {
    super(code, message);
  }
}

export function rejectReceipt(
  code: string,
  message: string,
  details: ReceiptDiagnostic[],
  recoverable = true,
): never {
  throw new ReceiptError(code, message, details, recoverable);
}
