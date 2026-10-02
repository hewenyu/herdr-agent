import type { Participant, Task } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { OrchestrationEvent } from "./contracts.js";
import { WORKFLOWS, type WorkflowNode, type WorkflowPlan, type WorkflowState } from "./workflow.js";
import { workspaceRevision } from "./workspace.js";

/** Reviewers may run checks; other writable roles can author code regardless of their label. */
export function implementationNode(node: WorkflowNode): boolean {
  return node.role === "implementer" || (node.access === "write" && node.role !== "reviewer");
}

/** A new snapshot does not prove that earlier authors' changes disappeared. */
export function implementationParticipants(state: WorkflowState): Set<string> {
  return new Set([
    ...(state.implementationParticipants ?? []),
    ...state.plan.nodes.filter(implementationNode).flatMap((node) => {
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

/** Capture possible writes before malformed outputs or a new plan can discard their baseline. */
export async function observeImplementationParticipants(
  store: Store,
  task: Task,
  state: WorkflowState,
  participants: Participant[],
): Promise<void> {
  const settled = Object.values(state.nodes).filter(
    (progress) =>
      ["dispatched", "blocked"].includes(progress.status) &&
      progress.participantId &&
      participants.some(
        (participant) =>
          participant.id === progress.participantId && participant.status !== "working",
      ) &&
      !store.get("participant_awaiting_output", progress.participantId),
  );
  if (!settled.length) return;
  const revision = await workspaceRevision(task.directories);
  const before = JSON.stringify(state.implementationParticipants);
  for (const progress of settled)
    if (progress.artifactRevision !== revision && progress.participantId)
      rememberImplementer(state, progress.participantId);
  if (JSON.stringify(state.implementationParticipants) !== before)
    store.set(WORKFLOWS, state.taskId, state);
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
      if (!node || implementationNode(node)) authors.add(dispatch.participantId);
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
