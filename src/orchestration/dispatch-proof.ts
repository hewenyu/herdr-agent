import type { Task } from "../core/types.js";
import { isDurableReceipt, type OperationReceipt } from "../storage/operations.js";
import type { Store } from "../storage/store.js";
import { activeTaskOperation, ownsTaskOperation } from "../tasks/operation-scope.js";

/**
 * The authority a persisted receipt can prove for one dispatch identity.
 * `absent` is deliberately distinct from `unknown`: no durable row means the
 * effect may still be attempted for the first time, while a present-but-corrupt
 * or unproven row is a barrier that must never authorize a replay or a
 * settlement. `retryable` is only a definite `not_executed` refusal.
 */
export type DispatchProof = "delivered" | "retry" | "retryable" | "settled" | "unknown" | "absent";

/**
 * Derive dispatch authority read-only, only after the existing full durable
 * receipt validator accepts the row. A malformed row (including `null`/`false`/
 * `0`/`""`) is an unknown outcome, never an absent one. A failed receipt whose
 * declared outcome is `unknown` stays unresolved, and a retirement only settles
 * when a completed audited `task_restarts` row names this exact task and
 * operation. Nothing here rewrites or deletes evidence.
 */
export function dispatchProof(store: Store, task: Task, operationId: string): DispatchProof {
  const receipt = store.get<OperationReceipt>("operations", operationId);
  // Only `undefined` is absence; every other present value must validate first.
  if (receipt === undefined) return "absent";
  if (!isDurableReceipt(operationId, receipt)) return "unknown";
  if (receipt.state === "done" || receipt.resolution?.choice === "treat_done") return "delivered";
  // A completed replacement revokes even an earlier unused retry. Ownership is
  // a precondition: an unowned id cannot be settled by another task's restart.
  if (
    receipt.retiredByRestart != null &&
    ownsTaskOperation(task, operationId) &&
    !activeTaskOperation(store, task, operationId, receipt)
  )
    return "settled";
  if (receipt.resolution?.choice === "retry") return "retry";
  if (receipt.resolution?.choice === "abandon") return "settled";
  if (receipt.state === "failed")
    // A definite refusal is the only failed shape that authorizes a retry; a
    // failure whose effect stayed unknown is not evidence of non-execution.
    return receipt.error?.outcome === "unknown" ? "unknown" : "retryable";
  return "unknown";
}
