import { isNotExecuted, OperationError, safeError } from "../core/errors.js";
import { canonical, now, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { Store } from "./store.js";

export interface OperationReceipt {
  id: string;
  fingerprint: string;
  state: "pending" | "done" | "failed" | "uncertain";
  result?: unknown;
  error?: ReturnType<typeof safeError>;
  updatedAt: string;
}

export class Operations {
  private readonly mutex = new KeyedMutex();
  constructor(private readonly store: Store) {}

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
        throw new OperationError(
          "operation_uncertain",
          "前次操作结果未知；请先核对现场，不能自动重发。",
          "unknown",
        );
      }
      const receipt: OperationReceipt = { id, fingerprint, state: "pending", updatedAt: now() };
      this.store.set("operations", id, receipt);
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
      }
    });
  }

  resetFailed(prefix: string): void {
    const rows = this.store
      .entries<OperationReceipt>("operations")
      .filter(([id]) => id.startsWith(prefix));
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
