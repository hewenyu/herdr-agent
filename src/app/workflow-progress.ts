import { fail, safeError } from "../core/errors.js";
import type { HerdrPort } from "../core/ports.js";
import type { ActorContext } from "../core/types.js";
import { visibleOutput } from "../orchestration/status-block.js";
import { WORKFLOWS, type WorkflowState } from "../orchestration/workflow.js";
import type { Store } from "../storage/store.js";
import type { TaskService } from "../tasks/service.js";
import {
  boundConversation,
  boundTaskView,
  boundWorkflowSummary,
  decisionFacts,
  deliveryFacts,
  participantFacts,
  reportFacts,
  runtimeFacts,
  truncateText,
  workflowSummary,
} from "./task-views.js";
import { currentTaskUserDecision } from "./workflow-notifications.js";

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
      const facts = participantFacts(participant);
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
            (ref.sessionId && runtime.sessionId !== ref.sessionId))
        )
          fail("target_changed", "现场已不属于原参与者会话。");
        // Pin only this read to the observed live session; keep the durable binding unchanged.
        const target = { ...ref, sessionId: ref.sessionId ?? runtime?.sessionId };
        const conversation = await services.herdr.conversation(
          target,
          participant.initialReceipt,
          cursor,
        );
        const latest = services.tasks
          .get(actor, taskId)
          .participants.find((entry) => entry.id === participant.id);
        if (JSON.stringify(latest?.execution) !== JSON.stringify(ref))
          fail("target_changed", "读取期间参与者绑定已变化。");
        const page = boundConversation(
          conversation.entries
            .map((entry) => ({ text: visibleOutput(entry.text) }))
            .filter((entry) => entry.text.trim()),
        );
        return {
          ...facts,
          observedAt: new Date().toISOString(),
          runtime: runtimeFacts(participant.id, {
            kind: "observed",
            status: runtime?.status ?? "gone",
            sessionId: runtime?.sessionId,
            context: runtime?.cwd ?? "",
          }),
          conversation: page.entries,
          omittedEntries: page.omittedEntries,
          conversationTruncated: page.truncated,
          cursor: conversation.cursor,
          truncated: conversation.truncated,
        };
      } catch (error) {
        return { ...facts, conversation: [], readError: safeError(error).message };
      }
    }),
  );
  const state = services.store.get<WorkflowState>(WORKFLOWS, task.id);
  const decision = state?.userDecision && (await currentTaskUserDecision(services.store, task));
  return boundTaskView({
    id: task.id,
    taskId: task.id,
    remoteTaskId: task.remoteTaskId,
    remoteTaskUrl: task.remoteTaskUrl,
    chatId: task.chatId,
    groupDeleted: task.groupDeleted,
    title: truncateText(task.title, 200),
    status: task.status,
    completedAt: task.completedAt,
    error: task.error ? truncateText(task.error, 800) : undefined,
    participants,
    workflow: state
      ? boundWorkflowSummary({
          ...workflowSummary(state),
          awaitingUser: state.userDecision
            ? decision?.status === "ready"
            : state.stall.awaitingUser,
          waitingForEvidence: state.assistanceWait
            ? truncateText(
                state.userDecision && !decision
                  ? "待决问题依据暂未通过当前项目版本核验，等待重新整理。"
                  : state.assistanceWait.reason,
                480,
              )
            : undefined,
          userDecision: decisionFacts(decision),
          delivery: deliveryFacts(state),
          report: reportFacts(state),
        })
      : undefined,
    interpretation:
      "会话文本是参与者自述；工具记录、产物证据、最终交付和用户验收分别判断。读取失败不证明未执行或未完成，不得补发输入。" +
      "只有 userDecision.status=ready 的当前具体问题才需要用户回答；system/failed 表示系统恢复或问题整理失败，不能笼统要求用户补需求或材料。" +
      "会话页、问题、证据与报告正文按字节预算分页或计数；缺失内容不代表记录不存在，可用 task_detail 按 section 读取。",
  });
}
