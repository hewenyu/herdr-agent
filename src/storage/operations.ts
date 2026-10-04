import { isNotExecuted, OperationError, safeError } from "../core/errors.js";
import { canonical, now, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { Store } from "./store.js";

export interface OperationResolution {
  choice: "treat_done" | "retry" | "abandon";
  decidedBy: "evidence" | "pi" | "user";
  reason: string;
  evidence?: string[];
  at: string;
  attempt?: number;
  /** Target-state result, distinct from the historical invocation result. */
  result?: unknown;
}

export interface OperationReceipt {
  id: string;
  fingerprint: string;
  state: "pending" | "done" | "failed" | "uncertain";
  /** Closed execution explicitly replaced; original outcome remains unchanged. */
  retiredByRestart?: string;
  result?: unknown;
  error?: ReturnType<typeof safeError>;
  updatedAt: string;
  resolution?: OperationResolution;
  history?: OperationReceipt[];
}

const activeOperations = new WeakMap<Store, Set<string>>();

const operationStates = ["pending", "done", "failed", "uncertain"];
const resolutionChoices = ["treat_done", "retry", "abandon"];
const deciders = ["evidence", "pi", "user"];
const outcomes = ["not_executed", "unknown"];

function isOneOf(values: string[], value: unknown): value is string {
  return typeof value === "string" && values.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function errorDefect(value: unknown): string | undefined {
  if (!isRecord(value)) return "错误字段不是记录对象";
  if (typeof value.code !== "string" || value.code.trim() === "") return "错误缺少错误码";
  if (typeof value.message !== "string") return "错误缺少说明";
  // Legacy receipts may predate `outcome`; when present it must stay meaningful.
  if (value.outcome !== undefined && !isOneOf(outcomes, value.outcome))
    return "错误的执行结果无法识别";
  return undefined;
}

function resolutionDefect(value: unknown): string | undefined {
  if (!isRecord(value)) return "决议不是记录对象";
  if (!isOneOf(resolutionChoices, value.choice)) return "决议选择无法识别";
  if (!isOneOf(deciders, value.decidedBy)) return "决议来源无法识别";
  if (typeof value.reason !== "string" || value.reason.trim() === "") return "决议缺少依据";
  if (!isTimestamp(value.at)) return "决议缺少有效时间";
  if (value.evidence !== undefined) {
    if (!Array.isArray(value.evidence) || value.evidence.some((item) => typeof item !== "string"))
      return "决议证据无法识别";
  }
  if (
    value.attempt !== undefined &&
    (typeof value.attempt !== "number" || !Number.isSafeInteger(value.attempt) || value.attempt < 0)
  )
    return "决议尝试序号无法识别";
  return undefined;
}

/**
 * Whether a persisted operation receipt is complete enough to govern replay.
 * A malformed receipt is not "absent": treating it as absent (or skipping the
 * row) would silently authorize a duplicate effect, so callers must refuse with
 * an unknown outcome and leave the evidence untouched.
 */
function receiptDefect(value: unknown): string | undefined {
  if (!isRecord(value)) return "回执不是记录对象";
  if (typeof value.id !== "string" || value.id.trim() === "") return "回执缺少操作标识";
  if (typeof value.fingerprint !== "string" || value.fingerprint.trim() === "")
    return "回执缺少参数指纹";
  if (!isOneOf(operationStates, value.state)) return "回执执行状态无法识别";
  if (typeof value.updatedAt !== "string" || value.updatedAt.trim() === "")
    return "回执缺少更新时间";
  if (value.retiredByRestart !== undefined && value.retiredByRestart !== null) {
    if (typeof value.retiredByRestart !== "string" || value.retiredByRestart.trim() === "")
      return "回执的替代标识无法识别";
  }
  // A failed receipt is the only shape that authorizes a retry; it must carry a
  // real, attributable refusal. A definite failure without one is corruption.
  if (value.state === "failed" && errorDefect(value.error)) return "失败回执缺少明确错误";
  if (value.resolution !== undefined && resolutionDefect(value.resolution))
    return "回执决议无法识别";
  if (value.history !== undefined) {
    if (!Array.isArray(value.history)) return "回执历史不是数组";
    for (const attempt of value.history) {
      const defect = receiptDefect(attempt);
      if (defect) return `回执历史中包含损坏记录：${defect}`;
      if (attempt.id !== value.id || attempt.fingerprint !== value.fingerprint)
        return "回执历史与当前操作身份不一致";
    }
    if (
      isRecord(value.resolution) &&
      value.resolution.choice === "retry" &&
      value.history.some((attempt: OperationReceipt) => attempt.resolution?.choice === "retry")
    )
      return "回执重复授予了已用完的重试授权";
  }
  return undefined;
}

/** Fail closed on a malformed durable receipt; never rewrite, delete or skip it. */
function assertDurableReceipt(id: string, receipt: unknown): void {
  const defect =
    receiptDefect(receipt) ??
    (isRecord(receipt) && receipt.id !== id ? "回执标识与持久记录键不一致" : undefined);
  if (defect)
    throw new OperationError(
      "state_invalid",
      `操作回执损坏，已拒绝本操作（记录 ${id} 保留未改动）：${defect}。请人工核对现场后处理。`,
      "unknown",
    );
}

/**
 * Read-only durable-receipt check for callers that must derive authority from a
 * persisted row without rewriting it. Returns false for a present-but-malformed
 * row (including `null`/`0`/`false`/`""`) exactly as `assertDurableReceipt`
 * would refuse it; callers must distinguish a truly absent row themselves.
 */
export function isDurableReceipt(id: string, receipt: unknown): boolean {
  try {
    assertDurableReceipt(id, receipt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only check for one persisted operation resolution. Returns false for a
 * present-but-malformed resolution (including `null`/`0`/`false`/`""`) exactly
 * as `resolutionDefect` refuses it inside a durable receipt; callers must
 * distinguish a truly absent value themselves. It never rewrites or deletes.
 */
export function isDurableResolution(value: unknown): boolean {
  return resolutionDefect(value) === undefined;
}

export class Operations {
  private readonly mutex = new KeyedMutex();
  constructor(private readonly store: Store) {}

  /** Shared across Operations instances for this store; never persisted across service starts. */
  inFlight(id: string): boolean {
    return activeOperations.get(this.store)?.has(id) ?? false;
  }

  async run<T>(id: string, parameters: unknown, perform: () => Promise<T>): Promise<T> {
    return this.mutex.run(id, async () => {
      const fingerprint = stableId(canonical(parameters));
      const previous = this.store.get<OperationReceipt>("operations", id);
      // Validate the durable receipt before deriving any authority from it. A
      // null/false/0/"" or otherwise malformed row is a recorded barrier, not an
      // absent one, and must never become permission to perform the effect again.
      if (previous !== undefined) assertDurableReceipt(id, previous);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          throw new OperationError("operation_conflict", "同一操作标识对应不同参数，未执行。");
        }
        if (previous.state === "done") return previous.result as T;
        if (previous.state === "failed" && previous.error) {
          // Preserve the declared outcome: a failure whose effect stayed unknown
          // is not honest evidence of a definite refusal. Legacy receipts that
          // omit the field keep the definite-refusal meaning they already had.
          throw new OperationError(
            previous.error.code,
            previous.error.message,
            previous.error.outcome ?? "not_executed",
          );
        }
        if (previous.resolution?.choice === "treat_done") return previous.resolution.result as T;
        if (previous.resolution?.choice === "abandon")
          throw new OperationError(
            "operation_abandoned",
            "操作已明确放弃，未执行。",
            "not_executed",
          );
        if (previous.resolution?.choice !== "retry")
          throw new OperationError(
            "operation_uncertain",
            "前次操作结果未知；请先核对现场，不能自动重发。",
            "unknown",
          );
      }
      const receipt: OperationReceipt = {
        id,
        fingerprint,
        state: "pending",
        updatedAt: now(),
        ...(previous
          ? { history: [...(previous.history ?? []), { ...previous, history: undefined }] }
          : {}),
      };
      this.store.set("operations", id, receipt);
      let active = activeOperations.get(this.store);
      if (!active) {
        active = new Set();
        activeOperations.set(this.store, active);
      }
      active.add(id);
      try {
        const result = await perform();
        this.store.set("operations", id, { ...receipt, state: "done", result, updatedAt: now() });
        return result;
      } catch (error) {
        this.store.set("operations", id, {
          ...receipt,
          state: isNotExecuted(error) ? "failed" : "uncertain",
          error: safeError(error),
          updatedAt: now(),
        });
        throw error;
      } finally {
        active.delete(id);
      }
    });
  }

  resolve(id: string, resolution: OperationResolution): void {
    this.store.transaction(() => {
      const receipt = this.store.get<OperationReceipt>("operations", id);
      // A malformed row is an unknown outcome, not a missing operation: refuse
      // to decide and never rewrite or drop the evidence.
      if (receipt !== undefined) assertDurableReceipt(id, receipt);
      if (!receipt || !["pending", "uncertain"].includes(receipt.state))
        throw new OperationError("operation_resolution_invalid", "只有未知操作可以决议。");
      if (this.inFlight(id))
        throw new OperationError("operation_resolution_invalid", "操作仍在执行，不能决议。");
      if (receipt.resolution)
        throw new OperationError("operation_resolution_conflict", "已有决议不能覆盖。");
      if (resolutionDefect(resolution))
        throw new OperationError("operation_resolution_invalid", "决议内容无法识别。");
      if (
        resolution.choice === "retry" &&
        receipt.history?.some((attempt) => attempt.resolution?.choice === "retry")
      )
        throw new OperationError("operation_retry_exhausted", "未知操作最多允许重试一次。");
      this.store.set("operations", id, { ...receipt, resolution: structuredClone(resolution) });
    });
  }

  resetFailed(prefix: string, include?: (id: string, receipt: OperationReceipt) => boolean): void {
    const rows = this.store
      .entries<OperationReceipt>("operations")
      // Validate the whole scanned namespace before any ownership filter: an
      // unknown-effect barrier must never be excluded from the refusal by a
      // malformed row failing a property access, and never be normalized away.
      .map(([id, receipt]) => {
        assertDurableReceipt(id, receipt);
        return [id, receipt] as [string, OperationReceipt];
      })
      .filter(([id, receipt]) => id.startsWith(prefix) && (!include || include(id, receipt)));
    this.store.transaction(() => {
      for (const [id, operation] of rows) {
        if (this.inFlight(id))
          throw new OperationError("operation_uncertain", "操作仍在执行，不能重置。", "unknown");
        // A resolved receipt is settled historical state even while its
        // historical state is pending/uncertain (mirrors the task service).
        // Never delete or rewrite it: it carries one-retry authorization and
        // the audit history of the original unknown attempt.
        if (operation.resolution) continue;
        if (operation.state === "failed") {
          // A failed receipt whose outcome is unknown is not retry authority.
          if (operation.error?.outcome === "unknown")
            throw new OperationError(
              "operation_uncertain",
              "存在结果未知的操作，需先核对现场。",
              "unknown",
            );
          // Only definitely unexecuted receipts may be cleared for a retry.
          this.store.delete("operations", id);
          continue;
        }
        if (operation.state === "pending" || operation.state === "uncertain")
          throw new OperationError(
            "operation_uncertain",
            "存在结果未知的操作，需先核对现场。",
            "unknown",
          );
      }
    });
  }
}
