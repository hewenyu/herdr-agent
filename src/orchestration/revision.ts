import { canonical, stableId } from "../core/ids.js";
import type { StoredMessage, Task, TaskMutationRevision } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { TaskUserRevision } from "../tasks/user-request.js";
import { WORKFLOWS, type WorkflowState } from "./workflow.js";

export interface RevisionInputs {
  requirements: string;
  messages: string[];
  resumes: string[];
  mutations: string[];
  workflow: string[];
  /** Explicit task input provenance; not part of the historical scheduling hash. */
  inputMessages: string[];
}

export interface ReportRevisionEvidence {
  version: 1;
  revision: string;
  inputs: RevisionInputs;
}

export function revisionInputs(
  store: Store,
  task: Task,
  messages: StoredMessage[],
  includeWorkflow = true,
): RevisionInputs {
  const resumes = store
    .entries<{ action?: string }>("task_actions")
    .filter(([id, action]) => id.startsWith(`${task.id}:`) && action.action === "resume")
    .map(([id]) => id)
    .sort();
  const mutations = store
    .entries<TaskMutationRevision>("task_mutation_revisions")
    .filter(([, mutation]) => mutation.taskId === task.id)
    .map(([id]) => id)
    .sort();
  const state =
    includeWorkflow && task.orchestration?.mode === "workflow"
      ? store.get<WorkflowState>(WORKFLOWS, task.id)
      : undefined;
  const sources = store
    .list<TaskUserRevision>("task_user_revisions")
    .filter((entry) => entry.taskId === task.id && entry.source.ownerId === task.ownerId);
  const inputSources = sources
    .filter((entry) => entry.usage === "input")
    .map((entry) => entry.source.messageId);
  const passiveSources =
    task.promptVersion === 3 && task.orchestration?.mode === "workflow"
      ? sources
          .filter((entry) => entry.usage === "read" || entry.usage === "control")
          .map((entry) => entry.source.messageId)
      : [];
  return {
    requirements: task.requirements,
    messages: messages
      .filter((message) => !(message.deliveryIds ?? []).some((id) => passiveSources.includes(id)))
      .map((message) => message.id),
    resumes,
    mutations,
    workflow: state ? [String(state.plan.version), state.phase] : [],
    inputMessages: messages
      .filter((message) => (message.deliveryIds ?? []).some((id) => inputSources.includes(id)))
      .map((message) => message.id),
  };
}

/** Keep the historical hash shape; only classified v3 passive turns are filtered at input. */
export function revisionHash(inputs: RevisionInputs): string {
  return stableId(
    inputs.requirements,
    ...inputs.messages,
    ...inputs.resumes,
    ...inputs.mutations,
    ...inputs.workflow,
  );
}

/** A new chat message alone cannot prove that a pending report should be abandoned. */
export function reportInputsChanged(
  evidence: ReportRevisionEvidence | undefined,
  eventRevision: string,
  current: RevisionInputs,
): boolean {
  if (!evidence || evidence.version !== 1 || evidence.revision !== eventRevision) return false;
  try {
    const before = evidence.inputs;
    if (revisionHash(before) !== evidence.revision || !Array.isArray(before.inputMessages))
      return false;
    return (
      before.requirements !== current.requirements ||
      canonical(before.resumes) !== canonical(current.resumes) ||
      canonical(before.mutations) !== canonical(current.mutations) ||
      current.inputMessages.some((id) => !before.messages.includes(id))
    );
  } catch {
    return false;
  }
}
