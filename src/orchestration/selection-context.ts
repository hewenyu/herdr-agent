import type { OrchestrationEvent } from "../app/task-orchestrator.js";
import { fail } from "../core/errors.js";
import { stableId } from "../core/ids.js";
import type { Task } from "../core/types.js";
import type { WorkflowCandidate } from "./candidates.js";
import { WORKFLOW_RECOVERY, type WorkflowRecoveryMaterial } from "./receipt-recovery.js";
import type { WorkflowPorts } from "./runner.js";
import type { StatusBlock } from "./status-block.js";
import { ensureUserDecision, renderUserDecision } from "./user-decision.js";
import { WORKFLOWS, type WorkflowState } from "./workflow.js";
import { workspaceRevision } from "./workspace.js";

/** Policy version invalidates old silent waits once; unchanged evidence still deduplicates. */
export async function assistanceFingerprint(
  ports: WorkflowPorts,
  task: Task,
  state: WorkflowState,
  event: OrchestrationEvent,
  configRevision?: string,
  candidates?: WorkflowCandidate[],
): Promise<string> {
  return stableId(
    "workflow-recovery-v1",
    event.id,
    await workspaceRevision(task.directories),
    configRevision ?? "",
    JSON.stringify(state.issues),
    JSON.stringify(candidates ?? state.plan),
    JSON.stringify(ports.outputs(task.id).map((output) => output.entry.id)),
  );
}

export function deferAssistance(
  ports: WorkflowPorts,
  state: WorkflowState,
  event: OrchestrationEvent,
  fingerprint: string,
  reason: string,
): void {
  event.state = "pending";
  event.attempts = Math.max(0, event.attempts - 1);
  event.nextAttemptAt = undefined;
  event.error = { code: "workflow_assistance_deferred", message: reason, outcome: "not_executed" };
  state.assistanceWait = { eventId: event.id, fingerprint, reason };
  ports.store.transaction(() => {
    ports.store.set(WORKFLOWS, state.taskId, state);
    ports.save(event);
  });
}

export function awaitingEvidence(
  ports: WorkflowPorts,
  state: WorkflowState,
  fingerprint: string,
): boolean {
  if (state.assistanceWait?.fingerprint === fingerprint) return true;
  if (state.assistanceWait) {
    state.assistanceWait = undefined;
    state.userDecision = undefined;
    ports.store.set(WORKFLOWS, state.taskId, state);
  }
  return false;
}

export function recentConversation(ports: WorkflowPorts, task: Task, state: WorkflowState) {
  if (task.promptVersion !== 3) return undefined;
  return state.consumedOutputs
    .slice(-4)
    .map((id) =>
      ports.store.get<{
        text: string;
        notes: string;
        hash: string;
        participantId: string;
      }>("workflow_conversation_evidence", id),
    )
    .filter((entry) => !!entry)
    .map((entry) => ({
      ...entry,
      notes: entry.notes.slice(0, 12000),
      truncated: entry.notes.length > 12000,
    }));
}

export function recoveryContext(ports: WorkflowPorts, task: Task, state: WorkflowState) {
  if (task.promptVersion !== 3) return undefined;
  return Object.values(state.nodes)
    .flatMap((node) => node.repair?.snapshotId ?? [])
    .map((id) => ports.store.get<WorkflowRecoveryMaterial>(WORKFLOW_RECOVERY, id))
    .filter((entry) => entry?.taskId === task.id && entry.repair.planVersion === state.plan.version)
    .slice(-4)
    .map((entry) => ({
      validation: "unverified",
      participantId: entry?.participantId,
      outputId: entry?.outputId,
      text: entry?.text.slice(0, 4000),
      notes: entry?.notes?.slice(0, 12000),
      diagnostics: entry?.repair.details,
      warning: "材料未通过回执校验，仅用于诊断和修复，不是已接受证据、共识或新的用户授权。",
    }));
}

export function receiptRepairRule(
  state: WorkflowState,
  candidates: WorkflowCandidate[],
  inputRevision: string,
  artifactRevision: string,
) {
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    const repair = node.repair;
    if (
      node.status !== "blocked" ||
      !repair?.recoverable ||
      repair.inputRevision !== inputRevision ||
      repair.artifactRevision !== artifactRevision ||
      repair.planVersion !== state.plan.version
    )
      continue;
    const candidate = candidates.find(
      (candidate) =>
        candidate.kind === "rework" &&
        candidate.assignments?.length === 1 &&
        candidate.assignments[0]?.nodeId === nodeId &&
        candidate.assignments[0]?.participantId === node.participantId,
    );
    if (!candidate) continue;
    return {
      candidateId: candidate.id,
      reason: "receipt_repair",
      noProgress: repair.repeated >= 2,
      diagnostic: `${nodeId} 的交接回执连续出现相同错误：${node.error ?? repair.code}。已有材料已保留；这是内部交接故障，无需补交业务需求。请保留任务和日志以修复该协议问题；修复后可在本任务会话明确要求继续。`,
    };
  }
  return undefined;
}

/** Model prose is not a user request until a grounded, actionable question contract exists. */
export async function prepareUserDecision(
  ports: WorkflowPorts,
  task: Task,
  state: WorkflowState,
  event: OrchestrationEvent,
  reason: string,
) {
  const artifactRevision = await workspaceRevision(task.directories);
  const assertWorkspace = async () => {
    ports.assertCurrent(event);
    if (
      artifactRevision !== (await workspaceRevision(task.directories)) ||
      (event.workflow?.artifactRevision && event.workflow.artifactRevision !== artifactRevision)
    )
      fail("workflow_artifact_changed", "待决问题对应的项目版本已变化，请按当前事实重新整理。");
    ports.assertCurrent(event);
  };
  await assertWorkspace();
  const decision = await ensureUserDecision({
    task,
    state,
    eventId: event.id,
    revision: event.userRevision,
    artifactRevision,
    engine: ports.engine,
    actor: {
      source: "system",
      ownerId: task.ownerId,
      taskId: task.id,
      chatId: task.chatId ?? task.entryChatId,
      sessionId: `orchestration:${task.id}`,
      messageId: event.id,
    },
    sources: ports.userMessages(task).map(({ id, text }) => ({ id, text })),
    blockers: Object.entries(state.nodes).flatMap(([id, node]) => {
      if (
        node.status !== "blocked" ||
        node.repair ||
        !node.outputId ||
        node.artifactRevision !== artifactRevision
      )
        return [];
      const accepted = ports.store.get<{ taskId: string; block: StatusBlock }>(
        "workflow_status_blocks",
        node.outputId,
      );
      if (accepted?.taskId !== task.id) return [];
      return accepted.block.blockers.map((text, index) => ({
        id: `${id}:${index}`,
        text,
        participantId: node.participantId,
        outputIds: [node.outputId as string],
      }));
    }),
    diagnostics: [reason, ...Object.values(state.nodes).flatMap((node) => node.error ?? [])],
    signal: ports.signal,
    assertCurrent: () => {
      ports.assertCurrent(event);
    },
    persist: async (decision) => {
      await assertWorkspace();
      state.userDecision = decision;
      ports.store.set(WORKFLOWS, state.taskId, state);
    },
  });
  await assertWorkspace();
  return { decision, text: renderUserDecision(decision) };
}
