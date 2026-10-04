/**
 * Failure-only inspection of existing verification logs, never an execution probe.
 * The trusted fixture root is given by the caller; every component below it is
 * checked, and only a terminal, exit-confirmed run of that task is eligible.
 * Fixed paths, no-follow/nonblocking opens and descriptor identity checks refuse
 * static path escapes and detected replacements. Separate checks are NOT atomic
 * confinement against concurrent ancestor replacement. Byte caps bound data, not
 * filesystem latency. Empty/missing output proves no execution stage.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

export const LOG_TAIL_MAX_BYTES = 512;
export const LOG_TAIL_MAX_RENDERED = 512;
const TASK_ID = /^[A-Za-z0-9_-]+$/;
// runId()/digest() in src/orchestration/verify.ts produces lowercase SHA-256.
const RUN_ID = /^[0-9a-f]{64}$/;
const TERMINAL_RUNS = ["passed", "failed", "timed_out", "cancelled"] as const;

export type LogTailStatus = "readable" | "empty" | "missing" | "rejected" | "unreadable";
export interface LogTailStream {
  status: LogTailStatus;
  bytes: number;
  truncated: boolean;
  renderTruncated: boolean;
  rendered: string;
  /** Fixed token, never an exception message or path. */
  reason?: string;
}
export interface VerificationLogTails {
  stdout: LogTailStream;
  stderr: LogTailStream;
}

/** Test-local IO seam, without process-global filesystem mocks. */
export interface LogTailIo {
  lstat(path: string): Stats;
  open(path: string, flags: number, mode: number): number;
  fstat(fd: number): Stats;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}
export const defaultLogTailIo: LogTailIo = {
  lstat: (path) => lstatSync(path),
  open: (path, flags, mode) => openSync(path, flags, mode),
  fstat: (fd) => fstatSync(fd),
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  close: (fd) => closeSync(fd),
};
export function logTailFlags(platform: string = process.platform): number | undefined {
  return platform !== "win32" &&
    typeof constants.O_NOFOLLOW === "number" &&
    constants.O_NOFOLLOW !== 0 &&
    typeof constants.O_NONBLOCK === "number" &&
    constants.O_NONBLOCK !== 0
    ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    : undefined;
}
export const logTailOpenFlags = logTailFlags();

const HEX = "0123456789abcdef";
function escapeByte(value: number): string {
  if (value === 0x0a) return "\\n";
  if (value === 0x0d) return "\\r";
  if (value === 0x09) return "\\t";
  if (value >= 0x20 && value <= 0x7e && value !== 0x22 && value !== 0x5c)
    return String.fromCharCode(value);
  return `\\x${HEX[(value >> 4) & 0xf]}${HEX[value & 0xf]}`;
}

/** Retain the most recent complete byte escapes within the render budget. */
function renderTail(bytes: Buffer): Pick<LogTailStream, "rendered" | "renderTruncated"> {
  const chunks = Array.from(bytes, escapeByte);
  let start = chunks.length;
  let length = 0;
  while (start > 0 && length + (chunks[start - 1] as string).length <= LOG_TAIL_MAX_RENDERED) {
    start -= 1;
    length += (chunks[start] as string).length;
  }
  return { rendered: chunks.slice(start).join(""), renderTruncated: start > 0 };
}
function tailStream(status: LogTailStatus, reason?: string): LogTailStream {
  return { status, bytes: 0, truncated: false, renderTruncated: false, rendered: "", reason };
}
interface EligibleRun {
  id: string;
  stdoutPath: unknown;
  stderrPath: unknown;
}
function eligibleRun(taskId: string, row: unknown): EligibleRun | undefined {
  if (!TASK_ID.test(taskId)) return undefined;
  if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
  const candidate = row as Record<string, unknown>;
  if (candidate.taskId !== taskId) return undefined;
  const id = candidate.id;
  const status = candidate.status;
  if (typeof id !== "string" || !RUN_ID.test(id)) return undefined;
  if (typeof status !== "string" || !(TERMINAL_RUNS as readonly string[]).includes(status))
    return undefined;
  if (candidate.exitConfirmed !== true) return undefined;
  return { id, stdoutPath: candidate.stdoutPath, stderrPath: candidate.stderrPath };
}

type Located =
  | { ok: true; directory: string }
  | { ok: false; status: "missing" | "rejected" | "unreadable"; reason?: string };
function locate(stateDir: string, taskId: string, runId: string, io: LogTailIo): Located {
  let directory = stateDir;
  for (const part of ["tasks", taskId, "verification", runId]) {
    directory = join(directory, part);
    let stats: Stats;
    try {
      stats = io.lstat(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, status: "missing" };
      return { ok: false, status: "unreadable", reason: "lstat" };
    }
    if (stats.isSymbolicLink())
      return { ok: false, status: "rejected", reason: "ancestor_symlink" };
    if (!stats.isDirectory())
      return { ok: false, status: "rejected", reason: "ancestor_non_directory" };
  }
  return { ok: true, directory };
}

function readStream(path: string, io: LogTailIo): LogTailStream {
  const flags = logTailOpenFlags;
  if (flags === undefined) return tailStream("rejected", "unsupported_platform");
  let stats: Stats;
  try {
    stats = io.lstat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
      ? tailStream("missing")
      : tailStream("unreadable", "lstat");
  }
  if (stats.isSymbolicLink()) return tailStream("rejected", "symlink");
  if (!stats.isFile()) return tailStream("rejected", "nonregular");
  if (stats.nlink !== 1) return tailStream("rejected", "hardlink");
  let fd: number;
  try {
    fd = io.open(path, flags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ELOOP") return tailStream("rejected", "symlink");
    if (code === "ENOENT") return tailStream("missing");
    return tailStream("unreadable", "open");
  }
  let failure = "fstat";
  try {
    const opened = io.fstat(fd);
    if (!opened.isFile()) return tailStream("rejected", "nonregular");
    if (opened.nlink !== 1) return tailStream("rejected", "hardlink");
    if (opened.dev !== stats.dev || opened.ino !== stats.ino)
      return tailStream("rejected", "identity_changed");
    if (!Number.isSafeInteger(opened.size) || opened.size < 0)
      return tailStream("rejected", "unsupported_size");
    if (opened.size === 0) return tailStream("empty");
    const window = Math.min(LOG_TAIL_MAX_BYTES, opened.size);
    const position = opened.size - window;
    const buffer = Buffer.allocUnsafe(window);
    let filled = 0;
    failure = "read";
    while (filled < window) {
      const count = io.read(fd, buffer, filled, window - filled, position + filled);
      if (!Number.isSafeInteger(count) || count < 0 || count > window - filled)
        return tailStream("unreadable", "read");
      if (count === 0) break;
      filled += count;
    }
    return {
      status: "readable",
      bytes: filled,
      truncated: opened.size > filled,
      ...renderTail(buffer.subarray(0, filled)),
    };
  } catch {
    return tailStream("unreadable", failure);
  } finally {
    // Always attempt close; a native close failure is not proof of fd release.
    try {
      io.close(fd);
    } catch {
      // Never replace the original assertion, or retry a potentially reused fd.
    }
  }
}

/** First eligible row within the six displayed observations; not necessarily latest. */
export function selectVerificationLogTails(
  stateDir: string,
  taskId: string,
  rows: readonly unknown[],
  io: LogTailIo = defaultLogTailIo,
): (VerificationLogTails & { rowIndex: number }) | undefined {
  for (let rowIndex = 0; rowIndex < Math.min(6, rows.length); rowIndex++) {
    try {
      const run = eligibleRun(taskId, rows[rowIndex]);
      if (run) return { rowIndex, ...readEligibleRun(stateDir, taskId, run, io) };
    } catch {
      // An unreadable row must not suppress other observations in this window.
    }
  }
  return undefined;
}

/** Missing eligibility returns undefined; all diagnostic failures stay contained. */
export function verificationLogTails(
  stateDir: string,
  taskId: string,
  row: unknown,
  io: LogTailIo = defaultLogTailIo,
): VerificationLogTails | undefined {
  try {
    const run = eligibleRun(taskId, row);
    return run ? readEligibleRun(stateDir, taskId, run, io) : undefined;
  } catch {
    return unreadableRun();
  }
}

function unreadableRun(): VerificationLogTails {
  return { stdout: tailStream("unreadable", "reader"), stderr: tailStream("unreadable", "reader") };
}

function readEligibleRun(
  stateDir: string,
  taskId: string,
  run: EligibleRun,
  io: LogTailIo,
): VerificationLogTails {
  try {
    const located = locate(stateDir, taskId, run.id, io);
    if (!located.ok) {
      const failed = tailStream(located.status, located.reason);
      return { stdout: failed, stderr: failed };
    }
    const stdoutPath = join(located.directory, "stdout.log");
    const stderrPath = join(located.directory, "stderr.log");
    if (
      (run.stdoutPath !== undefined && run.stdoutPath !== stdoutPath) ||
      (run.stderrPath !== undefined && run.stderrPath !== stderrPath)
    )
      return {
        stdout: tailStream("rejected", "path_mismatch"),
        stderr: tailStream("rejected", "path_mismatch"),
      };
    const read = (path: string): LogTailStream => {
      try {
        return readStream(path, io);
      } catch {
        return tailStream("unreadable", "reader");
      }
    };
    return { stdout: read(stdoutPath), stderr: read(stderrPath) };
  } catch {
    return unreadableRun();
  }
}
