/**
 * Failure-only, bounded snapshot of one `spawnSync` result, for assertion
 * messages. Pure formatting: it records observed fields and makes no claim
 * that a pid was initialized, that an empty stream means nothing executed,
 * or that a signal confirms that a whole process group exited.
 */
import type { SpawnSyncReturns } from "node:child_process";

/** Retained tail per stream, measured in UTF-16 code units (not bytes, not graphemes). */
export const CHILD_RESULT_TAIL_UNITS = 512;
/**
 * Declared upper bound on the returned single-line JSON message, in UTF-16 code
 * units. Worst case counted in escaped characters: (2 tails * 512 + error
 * message 128 + error name/code 2 * 32) * 6 JSON characters per unit is about
 * 7.3k, and fixed keys, numbers and punctuation add only a few hundred.
 */
export const CHILD_RESULT_MESSAGE_UNITS = 8192;
const ERROR_NAME_UNITS = 32;
const ERROR_CODE_UNITS = 32;
const ERROR_MESSAGE_UNITS = 128;

export type ChildResultDiagnosticFields = Pick<SpawnSyncReturns<string>, "error" | "signal">;
export interface ChildResultSnapshotInput
  extends Pick<SpawnSyncReturns<string>, "pid" | "status" | "signal" | "error"> {
  stdout: string | null;
  stderr: string | null;
}
/** Only `undefined` is an absent error; a falsey error is still an error. */
export function childResultDiagnosticRequired(result: ChildResultDiagnosticFields): boolean {
  return result.error !== undefined || result.signal !== null;
}

function headText(value: string, max: number): { text: string; truncated: boolean } {
  return value.length <= max
    ? { text: value, truncated: false }
    : { text: value.slice(0, max), truncated: true };
}

/** `missing` means the runtime returned no stream at all; `empty` is a real empty string. */
function streamSnapshot(text: string | null): Record<string, unknown> {
  if (text === null) return { state: "missing" };
  if (text === "") return { state: "empty", codeUnits: 0, truncated: false, tail: "" };
  const truncated = text.length > CHILD_RESULT_TAIL_UNITS;
  return {
    state: "present",
    codeUnits: text.length,
    truncated,
    tail: truncated ? text.slice(-CHILD_RESULT_TAIL_UNITS) : text,
  };
}

/** Name, code and a bounded message only: never the stack or `spawnargs`. */
function errorSnapshot(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "non-error", type: typeof error };
  const code = (error as NodeJS.ErrnoException).code;
  const message = headText(error.message, ERROR_MESSAGE_UNITS);
  return {
    name: headText(error.name, ERROR_NAME_UNITS).text,
    ...(code === undefined ? {} : { code: headText(String(code), ERROR_CODE_UNITS).text }),
    message: message.text,
    messageTruncated: message.truncated,
  };
}

/** Single-line JSON, so a recorded failure can be pasted and re-parsed verbatim. */
export function childResultSnapshot(result: ChildResultSnapshotInput): string {
  return JSON.stringify({
    pid: result.pid,
    status: result.status,
    signal: result.signal,
    error: result.error === undefined ? null : errorSnapshot(result.error),
    stdout: streamSnapshot(result.stdout),
    stderr: streamSnapshot(result.stderr),
  }).replace(
    /[\u0085\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
