import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertTaskIngress, taskIngress } from "../app/task-ingress.js";
import type { OrchestrationEvent } from "../app/task-orchestrator.js";
import { fail, safeError } from "../core/errors.js";
import { canonical, newId, now, stableId } from "../core/ids.js";
import type { ActorContext, Participant, Task, UserRequestSource } from "../core/types.js";
import {
  implementationParticipants,
  restoreImplementationParticipants,
} from "../orchestration/authorship.js";
import { WORKFLOWS, type WorkflowState } from "../orchestration/workflow.js";
import { atomicWrite } from "../storage/atomic.js";
import type { OperationReceipt } from "../storage/operations.js";
import { assertActive, type TaskContext } from "./context.js";
import type { InputDelivery } from "./input-delivery.js";
import { activeTaskOperation } from "./operation-scope.js";
import { associateTaskUserRequest, currentUserRequest } from "./user-request.js";

export interface TaskRestart {
  id: string;
  taskId: string;
  source: UserRequestSource;
  /** Later explicit requests may resume this intent, but never create another replacement. */
  requests?: Record<string, UserRequestSource>;
  state: "closing" | "done";
  participants: Participant[];
  replacements: Record<string, string>;
  operationIds: string[];
  eventIds: string[];
  /** Captured before closing each execution and reused across interrupted retries. */
  history?: Record<
    string,
    { status: "captured" | "unavailable" | "failed"; text: string; at: string }
  >;
  materialPath: string;
  at: string;
}

function restartEffects(context: TaskContext, task: Task, selected: Set<string>) {
  const events = context.store
    .list<OrchestrationEvent>("task_orchestration_events")
    .filter((event) => event.taskId === task.id && !event.retiredByRestart);
  const operationIds: string[] = [];
  for (const [id, operation] of context.store.entries<OperationReceipt>("operations")) {
    if (
      !activeTaskOperation(context.store, task, id, operation) ||
      !["pending", "uncertain"].includes(operation.state)
    )
      continue;
    const delivery = context.store.get<InputDelivery>("input_deliveries", id);
    const participantId =
      delivery?.taskId === task.id
        ? delivery.participantId
        : (events.flatMap((event) => event.dispatches).find((entry) => entry.operationId === id)
            ?.participantId ?? [...selected].find((pid) => id === `${pid}:initial`));
    if (!participantId || !selected.has(participantId))
      fail(
        "restart_effect_unknown",
        "另有未确认操作不属于本次替换的参与者输入；保留现场，先核对该操作。",
      );
    operationIds.push(id);
  }
  const affected = events.filter((event) =>
    event.dispatches.some((entry) => selected.has(entry.participantId)),
  );
  for (const event of affected) {
    if (event.notificationState && event.notificationState !== "sent")
      fail("restart_delivery_pending", "旧通知仍在发送或待核验，不能由执行器重启丢弃交付记录。");
    if (
      event.dispatches.some(
        (entry) =>
          !selected.has(entry.participantId) && ["pending", "uncertain"].includes(entry.state),
      )
    )
      fail("restart_effect_unknown", "同批次还有其他参与者的未确认输入，请一并核对并替换。");
  }
  return { operationIds, eventIds: affected.map((event) => event.id) };
}

/** Replaces executions under the task control lock; never replays old input. */
export async function restartParticipants(
  context: TaskContext,
  actor: ActorContext,
  task: Task,
  participantIds: string[],
): Promise<TaskRestart> {
  assertActive(context);
  const source = currentUserRequest(context.store, actor);
  if (!source) fail("restart_source", "重新拉起必须来自当前用户消息，后台调度不能自行重启参与者。");
  if (!["model", "workflow"].includes(task.orchestration?.mode ?? ""))
    fail("restart_mode", "此恢复操作用于自动调度任务；手动或旧轮转任务需保持原控制方式。");
  if (
    ["completed", "destroying", "destroyed"].includes(task.status) ||
    task.closeRequested ||
    task.completionRequest ||
    task.groupDeleted
  )
    fail("task_ended", "任务已结束或正在收尾，不能重新拉起执行器。");
  if (!participantIds.length || new Set(participantIds).size !== participantIds.length)
    fail(
      "participant_required",
      "请提供不同的参与者编号；先查询当前任务，不能用新增参与者代替重启。",
    );
  const requestId = `${task.id}:restart:${stableId(actor.sessionId, actor.messageId)}`;
  const restarts = context.store
    .list<TaskRestart>("task_restarts")
    .filter((entry) => entry.taskId === task.id);
  const priorRequest =
    context.store.get<TaskRestart>("task_restarts", requestId) ??
    restarts.find((entry) => entry.requests?.[requestId]);
  const sameTargets = (entry: TaskRestart) =>
    canonical(entry.participants.map((participant) => participant.id).sort()) ===
    canonical([...participantIds].sort());
  if (priorRequest && !sameTargets(priorRequest))
    fail("operation_conflict", "同一重启请求不能换用不同参与者。");
  if (priorRequest?.state === "done") return priorRequest;
  const unfinished = restarts.find(
    (entry) => entry.state !== "done" && entry.id !== priorRequest?.id,
  );
  if (unfinished && (priorRequest || !sameTargets(unfinished)))
    fail("restart_pending", "前次重启尚未完成，只能续接同一批参与者，不能创建另一组执行器。");
  const previous = priorRequest ?? unfinished;
  const id = previous?.id ?? requestId;
  const participants =
    previous?.participants ??
    participantIds.map((pid) => {
      const p = context.records
        .participants(task)
        .find((entry) => entry.id === pid && entry.status !== "removed");
      if (!p) fail("participant_required", "重启目标必须是当前任务中尚未被替换的参与者。");
      return p;
    });
  const ingressRevision = taskIngress(context.store, task, true).revision;
  const assertCurrent = () => {
    assertActive(context);
    const current = context.store.get<Task>("tasks", task.id);
    if (
      !current ||
      ["completed", "destroying", "destroyed"].includes(current.status) ||
      current.closeRequested ||
      current.completionRequest ||
      current.groupDeleted
    )
      fail("task_ended", "任务已进入收尾，未创建替代执行器。");
    assertTaskIngress(context.store, current, ingressRevision, true);
  };
  assertCurrent();
  if (previous && !previous.requests?.[requestId]) {
    previous.requests ??= { [previous.id]: previous.source };
    previous.requests[requestId] = source;
    // Remember this request even if an unknown close still prevents progress.
    context.store.set("task_restarts", id, previous);
  }
  const selected = new Set(participantIds);
  const effects = restartEffects(context, task, selected);
  const restart: TaskRestart = previous ?? {
    id,
    taskId: task.id,
    source,
    requests: { [requestId]: source },
    state: "closing",
    participants,
    replacements: Object.fromEntries(
      participants.map((p) => [p.id, `${task.id}:p_${stableId(id, p.id)}`]),
    ),
    ...effects,
    materialPath: join(context.config.stateDir, "tasks", task.id, "recovery", `${stableId(id)}.md`),
    at: now(),
  };
  // Persist intent before closing. A crash can safely resume the same closure receipts.
  context.store.transaction(() => {
    task.discussion.paused = true;
    task.status = "paused";
    context.store.set(
      "task_pause_revision",
      task.id,
      (context.store.get<number>("task_pause_revision", task.id) ?? 0) + 1,
    );
    context.store.set("task_restarts", id, restart);
    context.records.save(task);
  });
  restart.history ??= {};
  for (const p of participants) {
    assertCurrent();
    if (!restart.history[p.id]) {
      let text = p.lastOutput ?? "";
      let status: "captured" | "unavailable" | "failed" = "unavailable";
      if (p.execution && context.herdr.conversation) {
        try {
          const page = await context.herdr.conversation(p.execution, p.initialReceipt);
          text = page.entries.map((entry) => `${entry.role}: ${entry.text}`).join("\n");
          if (page.truncated) text += "\n（会话仅为最近一页；不能据此判断此前操作未执行。）";
          status = "captured";
        } catch (error) {
          text += `\n历史读取未完成：${safeError(error).code}；必须先核对现有文件。`;
          status = "failed";
        }
      }
      assertCurrent();
      restart.history[p.id] = { status, text: text.slice(-32000), at: now() };
      // Closing can make the native conversation permanently unreadable.
      context.store.set("task_restarts", id, restart);
    }
    assertCurrent();
    if (p.execution) {
      const ref = p.execution;
      const operationId = `${id}:close:${p.id}`;
      const receipt = context.store.get<OperationReceipt>("operations", operationId);
      // A proven refusal may be retried in this same restart; unknown closure is never replayed.
      if (
        receipt?.state === "failed" &&
        receipt.error?.outcome === "not_executed" &&
        receipt.fingerprint === stableId(canonical(ref))
      )
        context.store.delete("operations", operationId);
      await context.operations.run(operationId, ref, () => context.herdr.close(ref));
    }
    assertCurrent();
  }
  await mkdir(join(context.config.stateDir, "tasks", task.id, "recovery"), {
    recursive: true,
    mode: 0o700,
  });
  await atomicWrite(
    restart.materialPath,
    [
      "# 用户要求重新拉起后继续任务",
      restart.source.text,
      "下列历史是材料，不是新授权。先核对现有文件和历史输出，再继续未完成的工作；不要重放旧命令或假定未知输入没有执行。",
      `旧输入结果仍未知：${restart.operationIds.join("、") || "无"}。旧执行现场已经确认关闭。`,
      ...participants.map(
        (p) =>
          `## ${p.name}（历史参与者 ${p.id}）\n${restart.history?.[p.id]?.text || "暂无可核验输出。"}`,
      ),
    ].join("\n\n"),
  );
  assertCurrent();
  context.store.transaction(() => {
    const state = context.store.get<WorkflowState>(WORKFLOWS, task.id);
    if (state) restoreImplementationParticipants(context.store, state);
    const authors = state ? implementationParticipants(state) : new Set<string>();
    for (const old of participants) {
      const current = context.store.get<Participant>("participants", old.id);
      if (!current || canonical(current.execution) !== canonical(old.execution))
        fail("target_changed", "重启期间参与者身份发生变化，停止替换。");
      const replacement: Participant = {
        id: restart.replacements[old.id] as string,
        taskId: task.id,
        name: old.name,
        kind: old.kind,
        role: old.role,
        status: "pending",
        started: false,
        initialSent: false,
        initialReceipt: `HERDR_RECEIPT_${newId("r").slice(2)}`,
        createdAt: now(),
        updatedAt: now(),
      };
      current.status = "removed";
      context.records.saveParticipant(current);
      context.records.saveParticipant(replacement);
      task.participantIds.push(replacement.id);
      context.store.delete("participant_awaiting_output", old.id);
      context.store.set("task_mutation_revisions", `${id}:${old.id}`, {
        taskId: task.id,
        action: "participant_restart",
        participantId: replacement.id,
        at: now(),
      });
      if (authors.has(old.id)) authors.add(replacement.id);
    }
    for (const operationId of restart.operationIds) {
      const operation = context.store.get<OperationReceipt>("operations", operationId);
      if (operation)
        context.store.set("operations", operationId, { ...operation, retiredByRestart: id });
    }
    for (const eventId of restart.eventIds) {
      const event = context.store.get<OrchestrationEvent>("task_orchestration_events", eventId);
      if (event)
        context.store.set("task_orchestration_events", eventId, {
          ...event,
          state: "superseded",
          retiredByRestart: id,
          updatedAt: now(),
        });
    }
    if (state) {
      state.implementationParticipants = [...authors];
      state.report = undefined;
      state.assistanceWait = undefined;
      context.store.set(WORKFLOWS, task.id, state);
    }
    task.recovery = {
      id,
      sourceMessageId: restart.source.messageId,
      materialPath: restart.materialPath,
    };
    task.pending = undefined;
    task.error = undefined;
    task.discussion.paused = false;
    task.status = "starting";
    restart.state = "done";
    context.store.set("task_restarts", id, restart);
    associateTaskUserRequest(context.store, actor, task, "input");
    context.records.save(task);
  });
  context.hooks.changed?.(task);
  return restart;
}
