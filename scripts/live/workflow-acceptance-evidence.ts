import type { OrchestrationEvent, SettledTaskOutput } from "../../src/app/task-orchestrator.js";
import type { Delivery, ExecutionRef, Participant, Task } from "../../src/core/types.js";
import { statusOperationId } from "../../src/orchestration/status-block.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import type { Store } from "../../src/storage/store.js";
import type { InputDelivery } from "../../src/tasks/input-delivery.js";

/** Native session IDs are optional; the product also binds unique transcripts by input receipt. */
export function participantEvidence(
  store: Pick<Store, "list" | "get">,
  task: Task,
  owned: ReadonlyMap<string, ExecutionRef>,
) {
  const sameExecution = (left: ExecutionRef, right: ExecutionRef) =>
    left.paneId === right.paneId &&
    left.workspaceId === right.workspaceId &&
    left.kind === right.kind &&
    left.cwd === right.cwd &&
    (!left.sessionId || !right.sessionId || left.sessionId === right.sessionId);
  const dispatches = store
    .list<OrchestrationEvent>("task_orchestration_events")
    .filter((event) => event.taskId === task.id)
    .flatMap((event) => event.dispatches);
  const outputs = store
    .list<SettledTaskOutput>("task_settled_outputs")
    .filter((output) => output.taskId === task.id && output.entry.role === "assistant");
  return store
    .list<Participant>("participants")
    .filter((participant) => participant.taskId === task.id)
    .map((participant) => {
      const execution = participant.execution;
      const ownedRef = execution ? owned.get(execution.paneId) : undefined;
      const ownedExecution = !!execution && !!ownedRef && sameExecution(execution, ownedRef);
      const confirmedInputs = dispatches.flatMap((dispatch) => {
        if (!execution || dispatch.participantId !== participant.id || dispatch.state !== "sent")
          return [];
        const operation = store.get<OperationReceipt>("operations", dispatch.operationId);
        const input = store.get<InputDelivery>("input_deliveries", dispatch.operationId);
        if (
          operation?.state !== "done" ||
          (operation.result as Delivery | undefined)?.verified !== true ||
          !input ||
          input.taskId !== task.id ||
          input.participantId !== participant.id ||
          input.operationId !== dispatch.operationId ||
          input.fingerprint !== operation.fingerprint ||
          !sameExecution(input.execution, execution) ||
          !store.get("task_input_applied", dispatch.operationId)
        )
          return [];
        return [{ operationId: dispatch.operationId, outputSequence: input.outputSequence }];
      });
      const nativeOutputs = outputs.flatMap((output) => {
        const operationId = statusOperationId(output.entry.text);
        if (
          output.participantId !== participant.id ||
          !confirmedInputs.some(
            (input) =>
              input.operationId === operationId && (output.sequence ?? 0) > input.outputSequence,
          )
        )
          return [];
        return [{ outputId: output.entry.id, operationId, observedAt: output.observedAt }];
      });
      return {
        participantId: participant.id,
        kind: participant.kind,
        started: participant.started,
        ownedExecution,
        identityBinding: !nativeOutputs.length
          ? "unresolved"
          : execution?.sessionId
            ? "native_session_id"
            : "native_input_receipt",
        confirmedOperationIds: confirmedInputs.map((input) => input.operationId),
        nativeOutputs,
        provenParticipation:
          participant.started &&
          ownedExecution &&
          confirmedInputs.length > 0 &&
          nativeOutputs.length > 0,
      };
    });
}
