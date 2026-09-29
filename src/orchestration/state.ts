import { canonical, stableId } from "../core/ids.js";
import type { Task } from "../core/types.js";
import type { Store } from "../storage/store.js";
import { independentReviewer, restoreImplementationParticipants } from "./authorship.js";
import type { StatusBlock } from "./status-block.js";
import { templatePlan } from "./templates.js";
import { validatePlan, WORKFLOWS, type WorkflowNode, type WorkflowState } from "./workflow.js";

export function workflowState(store: Store, task: Task, userRevision: string): WorkflowState {
  const existing = store.get<WorkflowState>(WORKFLOWS, task.id);
  if (existing) {
    restoreImplementationParticipants(store, existing);
    return existing;
  }
  const plan = templatePlan(task, task.orchestration?.template);
  validatePlan(plan, task);
  const state: WorkflowState = {
    taskId: task.id,
    plan,
    phase: plan.nodes[0]?.phase ?? "planning",
    userRevision,
    nodes: Object.fromEntries(
      plan.nodes.map((node) => [node.id, { status: "pending", attempt: 0 }]),
    ),
    issues: [],
    implementationParticipants: [],
    evidence: [],
    artifacts: [],
    consumedOutputs: [],
    batches: [],
    stall: { open: [], unchanged: 0, awaitingUser: false },
    planning: "needed",
  };
  store.set(WORKFLOWS, task.id, state);
  return state;
}

export function readyNodes(state: WorkflowState): WorkflowNode[] {
  return state.plan.nodes.filter(
    (node) =>
      state.nodes[node.id]?.status === "pending" &&
      node.dependsOn.every((id) => state.nodes[id]?.status === "completed"),
  );
}

export function invalidateFrom(state: WorkflowState, nodeId: string): void {
  const invalid = new Set([nodeId]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of state.plan.nodes) {
      if (!invalid.has(node.id) && node.dependsOn.some((id) => invalid.has(id))) {
        invalid.add(node.id);
        changed = true;
      }
    }
  }
  for (const id of invalid)
    state.nodes[id] = {
      status: "pending",
      attempt: state.nodes[id]?.attempt ?? 0,
      ...(id === nodeId && state.nodes[id]?.repair ? { repair: state.nodes[id]?.repair } : {}),
    };
  state.report = undefined;
}

export function mergeStatus(
  state: WorkflowState,
  node: WorkflowNode,
  block: StatusBlock,
  outputId: string,
  artifactRevision: string,
): void {
  const progress = state.nodes[node.id];
  if (!progress || state.consumedOutputs.includes(outputId)) return;
  progress.outputId = outputId;
  progress.repair = undefined;
  progress.summary = block.summary;
  progress.artifactRevision = artifactRevision;
  progress.status =
    block.status === "completed" && !block.blockers.length ? "completed" : "blocked";
  progress.error =
    block.blockers.join("；") || (block.status === "needs_work" ? "需要返工或补证据。" : undefined);
  const independent =
    node.role === "reviewer" && independentReviewer(state, progress.participantId);
  if (node.role === "reviewer" && !independent) {
    progress.status = "blocked";
    progress.error = "实现参与者不能提供本任务的独立评审，请安排未参与实现的评审者。";
  }
  for (const issue of block.issues) {
    let old = state.issues.find((entry) => entry.id === issue.id);
    // A renamed duplicate must not reset the open-set stall window.
    old ??= state.issues.find((entry) => entry.description.trim() === issue.description.trim());
    if (old) {
      Object.assign(old, { ...issue, id: old.id });
      old.responses.push({ outputId, summary: block.summary });
    } else
      state.issues.push({
        ...issue,
        raisedBy: progress.participantId ?? "",
        responses: [{ outputId, summary: block.summary }],
      });
  }
  for (const [index, evidence] of block.evidence.entries()) {
    state.evidence.push({
      ...evidence,
      id: stableId(outputId, String(index)),
      artifactRevision,
      outputId,
      participantId: progress.participantId,
      source:
        evidence.result === "not_run"
          ? "not_run"
          : independent && evidence.command
            ? "agent_review"
            : "self_report",
    });
  }
  state.consumedOutputs.push(outputId);
}

export function countSettledBatch(state: WorkflowState, batch: string, rounds: number): void {
  if (state.batches.includes(batch)) return;
  state.batches.push(batch);
  const open = state.issues
    .filter((issue) => issue.status === "open")
    .map((issue) => issue.id)
    .sort();
  state.stall.unchanged =
    open.length && canonical(open) === canonical(state.stall.open) ? state.stall.unchanged + 1 : 0;
  state.stall.open = open;
  if (open.length && state.stall.unchanged >= rounds) state.stall.awaitingUser = true;
}
