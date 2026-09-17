import { isAbsolute } from "node:path";
import type { AgentStatus, Participant, Session, Task, TaskStatus } from "../core/types.js";
import {
  booleans,
  type Fields,
  fields,
  hash,
  type ImportPlan,
  invalid,
  sessionId,
  strings,
  text,
  timestamp,
  version,
} from "./common.js";

const states = new Set([
  "queued",
  "starting",
  "running",
  "blocked",
  "review",
  "attention",
  "completed",
  "destroying",
  "destroyed",
]);
export function importTasks(data: Fields, plan: ImportPlan, at: string): void {
  version(data);
  const panes = new Set<string>();
  for (const [id, raw] of Object.entries(fields(data.records))) {
    const old = fields(raw);
    booleans(old, [
      "started",
      "prompt_sent",
      "bypass",
      "chat_deleted",
      "close_requested",
      "pane_closed",
      "result_delivered",
    ]);
    const ownerId = text(old.owner_id);
    const kind = old.agent;
    if (
      !id ||
      old.id !== id ||
      !ownerId ||
      (kind !== "codex" && kind !== "claude") ||
      !states.has(text(old.status))
    )
      invalid("旧任务身份或状态无效");
    const directories = strings(old.directories).length
      ? strings(old.directories)
      : [text(old.path)];
    if (!directories.length || directories.some((path) => !isAbsolute(path)))
      invalid("旧任务目录无效");
    const paneId = text(old.pane_id);
    const workspaceId = text(old.workspace_id);
    const cwd = text(old.agent_cwd) || text(old.workspace_cwd) || (directories[0] as string);
    if (!isAbsolute(cwd)) invalid("旧执行会话目录无效");
    if (
      (paneId && (!workspaceId || panes.has(paneId))) ||
      (old.started && !paneId) ||
      (old.prompt_sent && !old.started)
    )
      invalid("旧任务执行资源绑定无效或重复");
    if (paneId) panes.add(paneId);
    const chatId = text(old.chat_id);
    const currentSession = sessionId(ownerId, chatId || text(old.entry_chat_id), id);
    const participantId = `legacy_p_${hash(id).slice(0, 32)}`;
    const createdAt = timestamp(old.created_at, at);
    const pending = text(old.pending);
    const status = pending && old.status !== "destroyed" ? "attention" : (old.status as TaskStatus);
    const task: Task = {
      id,
      ownerId,
      sessionId: currentSession,
      entryChatId: text(old.entry_chat_id),
      project: text(old.project) || undefined,
      kind: "development",
      title: text(old.title),
      requirements: text(old.title),
      directories,
      directoryMode: "shared",
      bypass: old.bypass === true,
      status,
      participantIds: [participantId],
      remoteTaskId: text(old.task_guid) || undefined,
      remoteTaskUrl: text(old.task_url) || undefined,
      chatId: chatId || undefined,
      groupDeleted: old.chat_deleted === true,
      keepGroup: false,
      createGroup: true,
      createRemoteTask: true,
      worktreeReady: false,
      discussion: {
        mode: "manual",
        maxRounds: 1,
        maxMinutes: 30,
        rounds: 0,
        nextParticipant: 0,
        paused: true,
      },
      result: text(old.result),
      error: pending
        ? "旧版操作结果未确认，迁移后禁止重试；请核对现场。"
        : text(old.error) || undefined,
      syncError: text(old.sync_error) || undefined,
      pending: pending || undefined,
      completionRequest:
        old.completion_request === "complete" || old.completion_request === "reopen"
          ? old.completion_request
          : undefined,
      closeRequested: old.close_requested === true,
      completedAt: text(old.completed_at) || undefined,
      createdAt,
      updatedAt: timestamp(old.updated_at, at),
      remoteCheckedAt: text(old.remote_checked_at) || undefined,
    };
    const agentState: AgentStatus =
      status === "running" ? "working" : status === "blocked" ? "blocked" : "idle";
    const participant: Participant = {
      id: participantId,
      taskId: id,
      name: kind,
      kind,
      role: "执行者",
      status:
        old.pane_closed || status === "destroyed" ? "gone" : old.started ? agentState : "pending",
      ...(paneId
        ? {
            execution: {
              paneId,
              workspaceId,
              kind,
              cwd,
              sessionId: text(old.session_id) || undefined,
            },
          }
        : {}),
      started: old.started === true,
      initialSent: old.prompt_sent === true,
      initialReceipt: text(old.prompt_receipt) || `legacy_${hash(id, "initial").slice(0, 32)}`,
      lastOutput: text(old.result) || undefined,
      createdAt,
      updatedAt: task.updatedAt,
    };
    const session: Session = {
      id: currentSession,
      ownerId,
      name: `旧任务：${task.title}`,
      taskId: id,
      generation: 0,
      archived: status === "destroyed",
      summary: "",
      createdAt,
      updatedAt: task.updatedAt,
    };
    plan.add("tasks", id, task);
    plan.add("participants", participantId, participant);
    plan.add("sessions", currentSession, session);
    plan.add("legacy_imports", participantId, {
      taskId: id,
      promptSent: participant.initialSent,
      resultDelivered: old.result_delivered === true,
      lastResult: text(old.result),
    });
    if (pending) {
      const operationId = `${id}:legacy-pending`;
      plan.add("operations", operationId, {
        id: operationId,
        fingerprint: hash("legacy", id, pending).slice(0, 32),
        state: "uncertain",
        error: { code: "migration_pending", message: task.error, outcome: "unknown" },
        updatedAt: at,
      });
      plan.warnings.add(`任务 ${id} 有未确认操作，已冻结自动重试。`);
    }
  }
}
