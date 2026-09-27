import type { OrchestrationEvent } from "../app/task-orchestrator.js";
import type { Store } from "../storage/store.js";
import { WORKFLOWS, type WorkflowPlan, type WorkflowState } from "./workflow.js";

/** A new snapshot does not prove that earlier authors' changes disappeared. */
export function implementationParticipants(state: WorkflowState): Set<string> {
  return new Set([
    ...(state.implementationParticipants ?? []),
    ...state.plan.nodes
      .filter((node) => node.role === "implementer")
      .flatMap((node) => {
        const participant = state.nodes[node.id]?.participantId;
        return participant ? [participant] : [];
      }),
  ]);
}

export function independentReviewer(state: WorkflowState, participantId?: string): boolean {
  return !!participantId && !implementationParticipants(state).has(participantId);
}

export function rememberImplementer(state: WorkflowState, participantId: string): void {
  state.implementationParticipants = [
    ...new Set([...implementationParticipants(state), participantId]),
  ].sort();
}

/** Recover authors from the existing event/plan archive, including superseded revisions. */
export function restoreImplementationParticipants(store: Store, state: WorkflowState): void {
  const authors = implementationParticipants(state);
  const plans = new Map<number, WorkflowPlan | undefined>();
  for (const event of store.list<OrchestrationEvent>("task_orchestration_events")) {
    if (event.taskId !== state.taskId || !event.workflow) continue;
    const version = event.workflow.planVersion;
    if (!plans.has(version))
      plans.set(
        version,
        store.get<{ plan: WorkflowPlan }>("workflow_plans", `${state.taskId}:${version}`)?.plan ??
          (version === state.plan.version ? state.plan : undefined),
      );
    const plan = plans.get(version);
    for (const dispatch of event.dispatches) {
      const node = plan?.nodes.find((entry) => entry.id === dispatch.nodeId);
      // Missing historical role evidence must not certify an independent reviewer.
      if (!node || node.role === "implementer") authors.add(dispatch.participantId);
    }
  }
  const participants = [...authors].sort();
  let changed = JSON.stringify(state.implementationParticipants) !== JSON.stringify(participants);
  state.implementationParticipants = participants;
  for (const evidence of state.evidence) {
    if (evidence.source !== "agent_review" || independentReviewer(state, evidence.participantId))
      continue;
    evidence.source = "self_report";
    // The frozen report may still contain the old independent-review label.
    state.report = undefined;
    changed = true;
  }
  if (changed) store.set(WORKFLOWS, state.taskId, state);
}
