import type { Participant, Task } from "../core/types.js";
import type { OrchestrationEvent } from "../orchestration/contracts.js";
import { revisionHash, revisionInputs } from "../orchestration/revision.js";
import {
  currentUserDecision,
  currentUserDecisionAtWorkspace,
  renderUserDecision,
} from "../orchestration/user-decision.js";
import { orchestrationUserMessages } from "../orchestration/user-messages.js";
import { WORKFLOWS, type WorkflowState } from "../orchestration/workflow.js";
import { workspaceRevision } from "../orchestration/workspace.js";
import type { Store } from "../storage/store.js";

export const quietWorkflow = (task: Task): boolean =>
  task.orchestration?.mode === "workflow" && task.promptVersion === 3;

/** Recheck frozen questions at the actual notification boundary, including retries. */
export async function workflowWaitText(
  store: Store,
  event: OrchestrationEvent,
  current: () => Task,
): Promise<string | undefined> {
  const artifactRevision = await workspaceRevision(current().directories);
  const task = current();
  const state = store.get<WorkflowState>(WORKFLOWS, task.id);
  const decision = state && currentUserDecision(state);
  if (
    !decision ||
    decision.eventId !== event.id ||
    decision.revision !== event.userRevision ||
    !decision.artifactRevision ||
    decision.artifactRevision !== artifactRevision
  )
    return undefined;
  return renderUserDecision(decision);
}

/** A stale lifecycle question is deferred without recording a completed/silent notice. */
export async function currentWorkflowNotice(
  task: Task,
  kind: string,
  participants: Participant[],
  store: Store,
): Promise<ReturnType<typeof workflowNotice> | undefined> {
  const state = kind === "progress" ? store.get<WorkflowState>(WORKFLOWS, task.id) : undefined;
  if (state?.userDecision && (state.stall.awaitingUser || state.assistanceWait)) {
    if (!(await currentTaskUserDecision(store, task))) return undefined;
  }
  return workflowNotice(task, kind, participants, store);
}

/** A user update takes effect immediately, before the scheduling tick clears old state. */
export async function currentTaskUserDecision(store: Store, task: Task) {
  const snapshot = () => {
    const current = store.get<Task>("tasks", task.id);
    const state = store.get<WorkflowState>(WORKFLOWS, task.id);
    if (
      !current ||
      current.ownerId !== task.ownerId ||
      !state ||
      state.userRevision !==
        revisionHash(
          revisionInputs(store, current, orchestrationUserMessages(store, current), false),
        )
    )
      return undefined;
    return { task: current, state };
  };
  const before = snapshot();
  if (!before) return undefined;
  const decision = await currentUserDecisionAtWorkspace(before.state, before.task.directories);
  const after = snapshot();
  if (
    !decision ||
    !after ||
    JSON.stringify(before.task.directories) !== JSON.stringify(after.task.directories) ||
    currentUserDecision(after.state)?.fingerprint !== decision.fingerprint
  )
    return undefined;
  return decision;
}

/** v3 only sends lifecycle facts that need attention, with no background pi turn. */
export function workflowNotice(
  task: Task,
  kind: string,
  participants: Participant[],
  store: Store,
): { notify: boolean; text: string; evidenceFingerprint?: string } {
  const silent = { notify: false, text: "" };
  if (kind === "welcome")
    return {
      notify: true,
      text: `任务「${task.title}」已登记。参与者的过程交流保存在任务记录中，最终产物会发到这里；可随时询问进度。`,
    };
  if (kind !== "progress") return silent;
  const state = store.get<WorkflowState>(WORKFLOWS, task.id);
  const decision = state && currentUserDecision(state);
  const event =
    decision && store.get<OrchestrationEvent>("task_orchestration_events", decision.eventId);
  // A wait event owns its durable send, including unknown/retryable delivery.
  // A second lifecycle key could duplicate a question already on its way.
  if (
    event?.taskId === task.id &&
    event.userRevision === decision?.revision &&
    event.decision?.action === "wait"
  )
    return silent;
  if (decision && (state?.stall.awaitingUser || state?.assistanceWait))
    return {
      notify: true,
      evidenceFingerprint: decision.fingerprint,
      text: `「${task.title}」${decision.status === "ready" ? "需要你回答以下具体问题" : "需要系统处理"}：\n${renderUserDecision(decision)}`,
    };
  if (state?.stall.awaitingUser)
    return {
      notify: true,
      text: `「${task.title}」的讨论暂时停住，旧记录尚未整理出可回答的具体问题。\n已记录的争议：${
        state.issues
          .filter((issue) => issue.status === "open" && issue.blocking)
          .map((issue) => issue.description)
          .join("；")
          .slice(0, 1200) || "讨论中的未决问题持续没有变化。"
      }\n你无需猜测应补充什么。请在本任务会话回复“查看当前卡点及失败原因”，先核对具体争议、备选方案和影响范围。`,
    };
  if (task.status === "attention" && task.error)
    return {
      notify: true,
      text: `「${task.title}」需要处理：${task.error.slice(0, 1200)}`,
    };
  if (participants.some((participant) => participant.error))
    return {
      notify: true,
      text: `「${task.title}」需要处理：${participants
        .filter((participant) => participant.error)
        .map((participant) => `${participant.name}：${participant.error}`)
        .join("；")
        .slice(0, 1200)}`,
    };
  if (state?.assistanceWait)
    return {
      notify: true,
      evidenceFingerprint: state.assistanceWait.fingerprint,
      text: `「${task.title}」的调度已暂停，判断依据尚未整理为具体问题。\n已记录原因：${state.assistanceWait.reason.slice(0, 1200)}\n这条旧等待记录不能证明缺少你的需求或材料。你无需猜测应补充什么；可回复“查看当前卡点及失败原因”，核对实际阻塞。`,
    };
  // Native blocked menus are handled by automatic approval or its own actionable card.
  return silent;
}
