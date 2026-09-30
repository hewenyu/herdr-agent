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
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          throw new OperationError("operation_conflict", "同一操作标识对应不同参数，未执行。");
        }
        if (previous.state === "done") return previous.result as T;
        if (previous.state === "failed" && previous.error) {
          throw new OperationError(previous.error.code, previous.error.message, "not_executed");
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
      if (!receipt || !["pending", "uncertain"].includes(receipt.state))
        throw new OperationError("operation_resolution_invalid", "只有未知操作可以决议。");
      if (this.inFlight(id))
        throw new OperationError("operation_resolution_invalid", "操作仍在执行，不能决议。");
      if (receipt.resolution)
        throw new OperationError("operation_resolution_conflict", "已有决议不能覆盖。");
      if (
        resolution.choice === "retry" &&
        receipt.history?.some((attempt) => attempt.resolution?.choice === "retry")
      )
        throw new OperationError("operation_retry_exhausted", "未知操作最多允许重试一次。");
      if (!resolution.reason.trim() || !Number.isFinite(Date.parse(resolution.at)))
        throw new OperationError("operation_resolution_invalid", "决议需要依据与有效时间。");
      this.store.set("operations", id, { ...receipt, resolution: structuredClone(resolution) });
    });
  }

  resetFailed(prefix: string, include?: (id: string, receipt: OperationReceipt) => boolean): void {
    const rows = this.store
      .entries<OperationReceipt>("operations")
      .filter(([id, receipt]) => id.startsWith(prefix) && (!include || include(id, receipt)));
    if (
      rows.some(([, operation]) => operation.state === "pending" || operation.state === "uncertain")
    ) {
      throw new OperationError(
        "operation_uncertain",
        "存在结果未知的操作，需先核对现场。",
        "unknown",
      );
    }
    this.store.transaction(() => {
      for (const [id, operation] of rows)
        if (operation.state === "failed") this.store.delete("operations", id);
    });
  }
}
