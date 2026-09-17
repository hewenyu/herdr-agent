import { setTimeout } from "node:timers/promises";
import { OperationError } from "../core/errors.js";

export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await setTimeout(ms, undefined, { signal });
  } catch (cause) {
    throw new OperationError("cancelled", "操作已取消。", "not_executed", { cause });
  }
}

export function deadline(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}
