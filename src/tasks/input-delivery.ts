import { OperationError } from "../core/errors.js";
import { canonical, stableId } from "../core/ids.js";
import type { ExecutionRef, Participant, Task } from "../core/types.js";
import type { TaskContext } from "./context.js";

export interface InputDelivery {
  taskId: string;
  participantId: string;
  operationId: string;
  fingerprint: string;
  execution: ExecutionRef;
  prompt: string;
  receipt: string;
  initial: boolean;
  discussionWasPaused: boolean;
  pauseRevision?: number;
  outputSequence: number;
}

/** Persist the exact attempted input before the herdr write, including every later turn. */
export function prepareInputDelivery(
  context: TaskContext,
  task: Task,
  participant: Participant,
  operationId: string,
  parameters: unknown,
  prompt: string,
): { prompt: string; receipt: string } {
  if (!participant.execution)
    throw new OperationError("participant_unavailable", "参与者尚未就绪。");
  const initial = !participant.initialSent;
  const receipt = initial
    ? participant.initialReceipt
    : `HERDR_RECEIPT_${stableId(operationId, participant.id)}`;
  const body = initial ? prompt : `${prompt}\n\n投递标识（无需复述）：\n${receipt}`;
  const fingerprint = stableId(canonical(parameters));
  const previous = context.store.get<InputDelivery>("input_deliveries", operationId);
  if (previous && (previous.fingerprint !== fingerprint || previous.prompt !== body))
    throw new OperationError("operation_conflict", "投递记录与本次参数不一致，未发送。");
  context.store.set<InputDelivery>("input_deliveries", operationId, {
    taskId: task.id,
    participantId: participant.id,
    operationId,
    fingerprint,
    execution: { ...participant.execution },
    prompt: body,
    receipt,
    initial,
    discussionWasPaused: task.discussion.paused,
    pauseRevision: context.store.get<number>("task_pause_revision", task.id) ?? 0,
    outputSequence: context.store.get<number>("task_output_sequence", task.id) ?? 0,
  });
  return { prompt: body, receipt };
}

const transientRefusals = new Set([
  "agent_blocked",
  "approval_required",
  "agent_not_ready",
  "screen_incomplete",
  "transcript_unavailable",
  "server_unavailable",
]);

/** Only retry an input that was definitely refused, with its exact original fingerprint. */
export function retryUnsentInput(
  context: Pick<TaskContext, "store">,
  operationId: string,
  parameters: unknown,
): void {
  const previous = context.store.get<import("../storage/operations.js").OperationReceipt>(
    "operations",
    operationId,
  );
  const fingerprint = stableId(canonical(parameters));
  if (
    !previous ||
    previous.fingerprint !== fingerprint ||
    previous.state !== "failed" ||
    previous.error?.outcome !== "not_executed" ||
    !transientRefusals.has(previous.error.code)
  )
    return;
  const retries = context.store.get<{ fingerprint: string; count: number }>(
    "input_retry_counts",
    operationId,
  );
  const count = retries?.fingerprint === fingerprint ? retries.count : 0;
  if (count >= 2)
    throw new OperationError(
      "input_retry_exhausted",
      "输入连续三次明确未执行；请检查现场后重试，已保留原要求。",
    );
  context.store.transaction(() => {
    context.store.set("input_retry_counts", operationId, {
      fingerprint,
      count: count + 1,
      previousError: previous.error,
    });
    context.store.delete("operations", operationId);
  });
}
