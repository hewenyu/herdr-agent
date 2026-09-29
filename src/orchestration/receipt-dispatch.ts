import type { OrchestrationEvent } from "../app/task-orchestrator.js";
import { fail } from "../core/errors.js";
import type { Task } from "../core/types.js";
import type { Store } from "../storage/store.js";
import {
  receiptRepairOwner,
  receiptRepairRevision,
  type WorkflowRepair,
} from "./receipt-recovery.js";
import type { WorkflowState } from "./workflow.js";
import { workspaceRevision } from "./workspace.js";

/** Freeze/recover only a rule-selected repair addressed to the rejected output's author. */
export async function selectedReceiptRepair(
  store: Store,
  task: Task,
  state: WorkflowState,
  event: OrchestrationEvent,
  assignment: { nodeId: string; participantId: string },
  artifactRevision: string | undefined,
): Promise<WorkflowRepair | undefined> {
  if (event.decision?.source !== "rule" || event.decision.reason !== "receipt_repair")
    return undefined;
  const candidate = event.workflow?.candidate;
  const repair = state.nodes[assignment.nodeId]?.repair;
  if (
    event.taskId !== task.id ||
    state.taskId !== task.id ||
    event.workflow?.planVersion !== state.plan.version ||
    candidate?.kind !== "rework" ||
    candidate.assignments?.length !== 1 ||
    candidate.assignments[0]?.nodeId !== assignment.nodeId ||
    candidate.assignments[0]?.participantId !== assignment.participantId ||
    !repair?.recoverable ||
    repair.inputRevision !== event.userRevision ||
    repair.planVersion !== state.plan.version ||
    receiptRepairOwner(store, task.id, assignment.nodeId, repair) !== assignment.participantId ||
    receiptRepairRevision(repair) !== artifactRevision ||
    artifactRevision !== (await workspaceRevision(task.directories))
  )
    fail("orchestration_superseded", "定向回执补正已不匹配原作者、任务或源码版本，需重新选择。");
  return repair;
}
