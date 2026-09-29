import type { InputProgress, NativeSendOptions } from "../core/ports.js";

/** Diagnostic failures cannot change whether the native effect actually occurred. */
export function sendProgress(
  options: NativeSendOptions,
  phase: InputProgress["phase"],
  verified?: boolean,
): void {
  try {
    options.onProgress?.({ phase, at: new Date().toISOString(), verified });
  } catch {
    // Delivery evidence and its operation receipt remain authoritative.
  }
}
