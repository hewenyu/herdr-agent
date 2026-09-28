import { fail, safeError } from "../core/errors.js";
import type { HerdrPort } from "../core/ports.js";
import type { ActorContext } from "../core/types.js";
import { visibleOutput } from "../orchestration/status-block.js";
import { WORKFLOWS, type WorkflowState } from "../orchestration/workflow.js";
import type { Store } from "../storage/store.js";
import type { TaskService } from "../tasks/service.js";

export async function taskProgress(
  services: { tasks: TaskService; herdr: HerdrPort; store: Store },
  actor: ActorContext,
  taskId: string,
  participantId?: string,
  cursor?: string,
) {
  const task = services.tasks.get(actor, taskId);
  const selected = participantId
    ? task.participants.filter(
        (participant) => participant.id === participantId || participant.name === participantId,
      )
    : task.participants.filter((participant) => participant.status !== "removed");
  if (participantId && selected.length !== 1)
    fail("participant_missing", "参与者不属于当前任务或名称不唯一。");
  if (cursor && selected.length !== 1) fail("invalid_cursor", "分页查询必须指定唯一参与者。");
  const selectedIds = new Set(selected.map((participant) => participant.id));
  const participants = await Promise.all(
    task.participants.map(async (participant) => {
      const facts = {
        id: participant.id,
        name: participant.name,
        kind: participant.kind,
        status: participant.status,
        initialSent: participant.initialSent,
        error: participant.error,
      };
      if (participant.taskId !== task.id) fail("participant_scope", "参与者任务绑定不匹配。");
      if (!selectedIds.has(participant.id)) return { ...facts, conversationRead: false };
      if (!participant.execution || !participant.initialSent)
        return { ...facts, conversation: [], readError: "初始要求尚未确认投递，暂无可核验会话。" };
      try {
        if (!services.herdr.conversation)
          fail("transcript_unavailable", "当前执行接口未提供原生会话查询。");
        const ref = structuredClone(participant.execution);
        const runtime = await services.herdr.get(ref.paneId).catch((error: unknown) => {
          if (["agent_not_found", "pane_not_found", "not_found"].includes(safeError(error).code))
            return undefined;
          throw error;
        });
        if (
          runtime &&
          (runtime.paneId !== ref.paneId ||
            runtime.workspaceId !== ref.workspaceId ||
            runtime.kind !== ref.kind ||
            runtime.cwd !== ref.cwd ||
            runtime.sessionId !== ref.sessionId)
        )
          fail("target_changed", "现场已不属于原参与者会话。");
        const conversation = await services.herdr.conversation(
          ref,
          participant.initialReceipt,
          cursor,
        );
        const latest = services.tasks
          .get(actor, taskId)
          .participants.find((entry) => entry.id === participant.id);
        if (JSON.stringify(latest?.execution) !== JSON.stringify(ref))
          fail("target_changed", "读取期间参与者绑定已变化。");
        return {
          ...facts,
          observedAt: new Date().toISOString(),
          runtime: runtime
            ? { status: runtime.status, sessionId: runtime.sessionId }
            : { status: "gone" },
          conversation: conversation.entries
            .map((entry) => ({ ...entry, text: visibleOutput(entry.text) }))
            .filter((entry) => entry.text.trim()),
          cursor: conversation.cursor,
          truncated: conversation.truncated,
        };
      } catch (error) {
        return { ...facts, conversation: [], readError: safeError(error).message };
      }
    }),
  );
  const state = services.store.get<WorkflowState>(WORKFLOWS, task.id);
  return {
    id: task.id,
    taskId: task.id,
    remoteTaskId: task.remoteTaskId,
    remoteTaskUrl: task.remoteTaskUrl,
    chatId: task.chatId,
    groupDeleted: task.groupDeleted,
    title: task.title,
    status: task.status,
    completedAt: task.completedAt,
    error: task.error,
    participants,
    workflow: state
      ? {
          phase: state.phase,
          nodes: state.plan.nodes.map((node) => ({
            id: node.id,
            phase: node.phase,
            ...state.nodes[node.id],
          })),
          issues: state.issues,
          artifacts: state.artifacts,
          evidence: state.evidence,
          report: state.report,
          awaitingUser: state.stall.awaitingUser,
          waitingForEvidence: state.assistanceWait?.reason,
        }
      : undefined,
    interpretation:
      "会话文本是参与者自述；工具记录、产物证据、最终交付和用户验收分别判断。读取失败不证明未执行或未完成，不得补发输入。",
  };
}
