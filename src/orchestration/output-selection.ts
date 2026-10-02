import type { Store } from "../storage/store.js";
import type { InputDelivery } from "../tasks/input-delivery.js";
import type { Dispatch, SettledTaskOutput } from "./contracts.js";
import { handoffDirectory } from "./handoff.js";
import { parseStatusBlock, statusOperationId } from "./status-block.js";

/** Unknown/malformed bindings must reach protocol validation instead of waiting forever. */
export function selectWorkflowOutput(
  outputs: SettledTaskOutput[],
  current: InputDelivery,
  dispatches: Dispatch[],
  store: Pick<Store, "get">,
  handoff?: { stateDir: string; taskId: string },
): SettledTaskOutput | undefined {
  if (handoff) {
    const belongs = (entry: SettledTaskOutput, operationId: string) =>
      entry.entry.text.includes(
        `${handoffDirectory(handoff.stateDir, handoff.taskId, operationId)}/notes.md`,
      );
    return (
      outputs.findLast((entry) => belongs(entry, current.operationId)) ??
      outputs.findLast(
        (entry) =>
          !dispatches.some((dispatch) => {
            if (
              dispatch.operationId === current.operationId ||
              dispatch.participantId !== current.participantId ||
              dispatch.state !== "sent"
            )
              return false;
            const prior = store.get<InputDelivery>("input_deliveries", dispatch.operationId);
            return (
              prior?.taskId === current.taskId &&
              prior.participantId === current.participantId &&
              prior.outputSequence <= current.outputSequence &&
              belongs(entry, dispatch.operationId)
            );
          }),
      )
    );
  }
  const belongsToPriorDispatch = (output: SettledTaskOutput): boolean => {
    const operationId = statusOperationId(output.entry.text);
    if (!operationId || operationId === current.operationId) return false;
    const dispatch = dispatches.find(
      (entry) =>
        entry.operationId === operationId &&
        entry.participantId === current.participantId &&
        entry.state === "sent",
    );
    const previous = store.get<InputDelivery>("input_deliveries", operationId);
    if (
      !dispatch?.nodeId ||
      !dispatch.inputRevision ||
      previous?.operationId !== operationId ||
      previous.taskId !== current.taskId ||
      previous.participantId !== current.participantId ||
      previous.outputSequence > current.outputSequence
    )
      return false;
    try {
      parseStatusBlock(output.entry.text, {
        nodeId: dispatch.nodeId,
        operationId,
        inputRevision: dispatch.inputRevision,
      });
      return true;
    } catch {
      // Merely copying an old identifier does not prove the reply belongs to it.
      return false;
    }
  };
  return (
    outputs.findLast((entry) => statusOperationId(entry.entry.text) === current.operationId) ??
    outputs.findLast((entry) => !belongsToPriorDispatch(entry))
  );
}
