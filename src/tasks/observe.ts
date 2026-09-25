import { OperationError, safeError } from "../core/errors.js";
import { now, stableId } from "../core/ids.js";
import type { AgentSnapshot, Participant, Task, TranscriptEntry } from "../core/types.js";
import { assertActive, type TaskContext } from "./context.js";
import { recoverInitialInputs } from "./input-recovery.js";
import { relayDiscussion } from "./send.js";

interface PendingOutput {
  taskId: string;
  participantId: string;
  entry: TranscriptEntry;
  sequence?: number;
  delivery?: "sending" | "retryable" | "uncertain";
  error?: ReturnType<typeof safeError>;
}
interface PendingRelay {
  taskId: string;
  participantId: string;
  outputId: string;
  text: string;
  entry?: TranscriptEntry;
  sequence?: number;
}

export async function observeTask(context: TaskContext, task: Task): Promise<void> {
  assertActive(context);
  await recoverInitialInputs(context, task);
  await flushPendingTaskEvents(context, task, false);
  // Reload each participant: an earlier output can dispatch work to a later one.
  // Reusing the initial array would overwrite that dispatch's durable state.
  for (const id of task.participantIds) {
    assertActive(context);
    const participant = context.store.get<Participant>("participants", id);
    if (
      !participant?.execution ||
      !participant.started ||
      ["removed", "gone"].includes(participant.status)
    )
      continue;
    participant.execution.transcriptReceipt = participant.initialReceipt;
    let agent: AgentSnapshot;
    try {
      agent = await context.herdr.get(participant.execution.paneId);
    } catch (error) {
      if (
        error instanceof OperationError &&
        ["agent_not_found", "pane_not_found", "not_found"].includes(error.code)
      ) {
        participant.status = "gone";
        participant.error = "参与者执行现场已不存在。";
        task.discussion.paused = true;
        // A process can exit after writing its final transcript. Recover that
        // result before forgetting the execution; a failed read is retried.
        const latest = await context.herdr.sampleLastReply(participant.execution);
        const baseline = context.store.get<{ id: string }>(
          "participant_input_baseline",
          participant.id,
        );
        if (participant.initialSent && latest?.final && latest.id !== baseline?.id) {
          await recordOutput(context, task, participant, latest);
        }
        context.records.saveParticipant(participant);
        if (!["completed", "destroying", "destroyed", "paused"].includes(task.status))
          task.status = "attention";
        task.error = participant.error;
        context.records.save(task);
        continue;
      }
      throw error;
    }
    if (
      agent.paneId !== participant.execution.paneId ||
      agent.workspaceId !== participant.execution.workspaceId ||
      agent.kind !== participant.kind
    ) {
      task.discussion.paused = true;
      throw new OperationError("agent_replaced", "参与者身份发生变化，已停止调度。");
    }
    const previousStatus = participant.status;
    if (
      participant.execution.sessionId &&
      agent.sessionId &&
      agent.sessionId !== participant.execution.sessionId
    ) {
      participant.sessionNote =
        "同一 herdr 窗口的原生会话已变化（可能是清空、压缩或重启）；任务记录保留，不自动重投旧要求。";
      // An unfinished turn cannot silently become review when its native
      // session disappears. A new explicit arrangement clears this diagnostic.
      const interrupted =
        context.store.get("participant_awaiting_output", participant.id) ||
        context.store
          .list<PendingRelay>("pending_relays")
          .some(
            (pending) => pending.taskId === task.id && pending.participantId === participant.id,
          );
      if (interrupted) {
        participant.error =
          "原生会话已变化，本轮工作中断；请查看现场并发送新的安排，系统不会重发旧要求。";
        task.error = `${participant.name}：${participant.error}`;
      }
      context.store.delete("participant_awaiting_output", participant.id);
      for (const [key, pending] of context.store.entries<PendingRelay>("pending_relays"))
        if (pending.taskId === task.id && pending.participantId === participant.id)
          context.store.delete("pending_relays", key);
      participant.execution.sessionId = agent.sessionId;
      participant.cursor = (await context.herdr.transcript(participant.execution)).cursor;
      const latest = await context.herdr.sampleLastReply(participant.execution);
      context.store.set("participant_input_baseline", participant.id, { id: latest?.id ?? "" });
    }
    participant.status = agent.status;
    participant.execution.sessionId = agent.sessionId;
    participant.lastStateSeq = agent.stateSeq;
    const legacy = context.store.get<{
      taskId: string;
      promptSent: boolean;
      resultDelivered: boolean;
      lastResult: string;
      baseline?: boolean;
    }>("legacy_imports", participant.id);
    if (legacy && !legacy.baseline) {
      participant.cursor = (await context.herdr.transcript(participant.execution)).cursor;
      const before = await context.herdr.sampleLastReply(participant.execution);
      participant.lastOutput = legacy.lastResult || participant.lastOutput;
      participant.initialSent = legacy.promptSent;
      context.store.transaction(() => {
        context.records.saveParticipant(participant);
        context.store.set("legacy_imports", participant.id, { ...legacy, baseline: true });
        context.store.set("participant_input_baseline", participant.id, { id: before?.id ?? "" });
      });
      continue;
    }
    const page = await context.herdr.transcript(participant.execution, participant.cursor);
    for (const entry of page.entries) {
      if (entry.role === "assistant" && entry.final && participant.initialSent) {
        await recordOutput(context, task, participant, entry);
      }
    }
    if (participant.initialSent && ["idle", "done"].includes(agent.status)) {
      const latest = await context.herdr.sampleLastReply(participant.execution);
      const baseline = context.store.get<{ id: string }>(
        "participant_input_baseline",
        participant.id,
      );
      if (
        latest?.final &&
        latest.id !== baseline?.id &&
        (previousStatus === "working" || latest.text !== participant.lastOutput)
      ) {
        await recordOutput(context, task, participant, latest);
      }
    }
    participant.cursor = page.cursor;
    context.records.saveParticipant(participant);
    if (
      agent.status === "blocked" &&
      (!participant.initialSent ||
        participant.lastNotifiedState !== agent.stateSeq ||
        (context.hooks.blockedVersion &&
          context.store.get<string>("approval_observation_versions", participant.id) !==
            context.hooks.blockedVersion))
    ) {
      assertActive(context);
      await context.hooks.blocked?.(task, participant);
      if (context.hooks.blockedVersion)
        context.store.set(
          "approval_observation_versions",
          participant.id,
          context.hooks.blockedVersion,
        );
      participant.lastNotifiedState = agent.stateSeq;
      context.records.saveParticipant(participant);
    }
  }
  // Native status and the whole transcript page must settle before a final
  // message can transfer ownership to another participant.
  await flushPendingTaskEvents(context, task);
  if (!["completed", "destroying", "destroyed", "paused"].includes(task.status)) {
    const active = context.records.participants(task).filter((entry) => entry.status !== "removed");
    const stalled = active.filter((entry) => idleWithoutReply(context, entry));
    task.status =
      active.some((entry) => entry.status === "gone" || entry.error) || stalled.length > 0
        ? "attention"
        : active.some((entry) => entry.status === "blocked")
          ? "blocked"
          : active.some(
                (entry) =>
                  entry.status === "working" ||
                  context.store.get("participant_awaiting_output", entry.id),
              )
            ? "running"
            : active.some((entry) => !entry.started)
              ? "starting"
              : "review";
    if (stalled.length && !active.some((entry) => entry.status === "gone" || entry.error))
      task.error = `${stalled.map((entry) => entry.name).join("、")} 的输入已确认，但执行器空闲超过 60 秒仍无最终回复；请查看参与者现场，系统不会自动重发。`;
    context.records.save(task);
  }
}

/** A stuck idle prompt is visible, without treating a long working turn as failed. */
function idleWithoutReply(context: TaskContext, participant: Participant): boolean {
  const input = context.store.get<{ operationId: string }>(
    "participant_awaiting_output",
    participant.id,
  );
  if (!input || !["idle", "done"].includes(participant.status)) {
    context.store.delete("participant_idle_wait", participant.id);
    return false;
  }
  const previous = context.store.get<{ operationId: string; since: string }>(
    "participant_idle_wait",
    participant.id,
  );
  if (previous?.operationId !== input.operationId) {
    context.store.set("participant_idle_wait", participant.id, {
      operationId: input.operationId,
      since: now(),
    });
    return false;
  }
  return Date.now() - Date.parse(previous.since) >= 60_000;
}

export async function flushPendingTaskEvents(
  context: TaskContext,
  task: Task,
  relay = true,
): Promise<void> {
  for (const [key, pending] of context.store
    .entries<PendingOutput>("pending_outputs")
    .sort((a, b) => (a[1].sequence ?? 0) - (b[1].sequence ?? 0))) {
    assertActive(context);
    if (pending.taskId !== task.id) continue;
    const participant = context.store.get<Participant>("participants", pending.participantId);
    if (!participant)
      throw new OperationError("participant_missing", "待投递输出的参与者记录不存在。");
    captureOutput(context, task, participant, key, pending.entry, pending.sequence);
    // First recover native facts, then observe the whole current transcript.
    // Notification failure must not prevent reading or settling later output.
    if (relay) await deliverOutput(context, task, participant, key);
  }
  if (!relay) return;
  const pendingRelays = context.store
    .entries<PendingRelay>("pending_relays")
    .filter(([, pending]) => pending.taskId === task.id)
    .sort((a, b) => (a[1].sequence ?? 0) - (b[1].sequence ?? 0));
  // A native turn can emit several prose records before it stops. Transfer only
  // its latest final output, retaining all records for delivery and audit.
  const latest = new Map<string, string>();
  for (const [key, pending] of pendingRelays) latest.set(pending.participantId, key);
  for (const [key, pending] of pendingRelays) {
    assertActive(context);
    if (pending.taskId !== task.id) continue;
    const participant = context.store.get<Participant>("participants", pending.participantId);
    if (!participant)
      throw new OperationError("participant_missing", "待转发发言的参与者记录不存在。");
    if (latest.get(pending.participantId) !== key) {
      context.store.delete("pending_relays", key);
      continue;
    }
    if (
      !["idle", "done"].includes(participant.status) &&
      !["completed", "destroying", "destroyed"].includes(task.status)
    )
      continue;
    if (["idle", "done"].includes(participant.status)) {
      context.store.transaction(() => {
        if (!context.store.get("task_settled_outputs", key))
          context.store.set("task_settled_outputs", key, {
            taskId: task.id,
            participantId: participant.id,
            entry: {
              ...(pending.entry ?? { role: "assistant", final: true, text: pending.text }),
              id: key,
            },
            sequence: pending.sequence,
            observedAt: now(),
          });
        context.store.delete("participant_awaiting_output", participant.id);
      });
    }
    if (await relayDiscussion(context, task, participant, pending.outputId, pending.text))
      context.store.delete("pending_relays", key);
  }
  if (task.status === "destroying") {
    const pending = context.store
      .list<PendingOutput>("pending_outputs")
      .find((output) => output.taskId === task.id);
    if (pending)
      throw new OperationError(
        pending.error?.code ?? "output_delivery_pending",
        pending.error?.message ?? "最终输出尚未确认送达，保留执行资源等待核验。",
        pending.error?.outcome ?? "unknown",
      );
  }
}

async function recordOutput(
  context: TaskContext,
  task: Task,
  participant: Participant,
  entry: TranscriptEntry,
): Promise<void> {
  const key = stableId(participant.id, participant.execution?.sessionId ?? "", entry.id);
  if (context.store.get("task_outputs", key)) return;
  const sequence = (context.store.get<number>("task_output_sequence", task.id) ?? 0) + 1;
  context.store.transaction(() => {
    context.store.set("task_output_sequence", task.id, sequence);
    context.store.set<PendingOutput>("pending_outputs", key, {
      taskId: task.id,
      participantId: participant.id,
      entry,
      sequence,
    });
    participant.lastOutput = entry.text;
    task.result = `${participant.name} (${participant.kind})：\n${entry.text}`;
    context.records.saveParticipant(participant);
    context.records.save(task);
    captureOutput(context, task, participant, key, entry, sequence);
  });
}

/** Native capture is durable independently of user-visible notification receipts. */
function captureOutput(
  context: TaskContext,
  task: Task,
  participant: Participant,
  key: string,
  entry: TranscriptEntry,
  sequence?: number,
): void {
  if (context.store.get("task_outputs", key)) return;
  const relay = {
    taskId: task.id,
    participantId: participant.id,
    outputId: key,
    text: entry.text,
    entry,
    sequence,
  };
  context.store.transaction(() => {
    context.store.set("task_outputs", key, {
      at: now(),
      participantId: participant.id,
      captured: true,
    });
    context.store.set<PendingRelay>("pending_relays", key, relay);
    context.store.set<PendingRelay>("discussion_last_output", task.id, relay);
  });
}

async function deliverOutput(
  context: TaskContext,
  task: Task,
  participant: Participant,
  key: string,
): Promise<void> {
  assertActive(context);
  const pending = context.store.get<PendingOutput>("pending_outputs", key);
  if (!pending) return;
  const confirmed =
    context.hooks.outputConfirmed?.(task, participant, { ...pending.entry, id: key }) === true;
  const retryable =
    !confirmed &&
    (pending.delivery === "sending" ||
      pending.delivery === "uncertain" ||
      pending.error?.outcome === "unknown") &&
    context.hooks.outputRetryable?.(task, participant, { ...pending.entry, id: key }) === true;
  if (
    !confirmed &&
    !retryable &&
    (pending.delivery === "uncertain" || pending.error?.outcome === "unknown")
  )
    return;
  if (!confirmed && !retryable && pending.delivery === "sending") {
    // Without receipt proof, a crash may have crossed the notification boundary.
    // Preserve that uncertainty;
    // native work may continue, but this message must never be blindly resent.
    context.store.set("pending_outputs", key, {
      ...pending,
      delivery: "uncertain",
      error: {
        code: "output_delivery_unknown",
        message: "输出通知的投递结果尚未确认，保留原回执等待核验。",
        outcome: "unknown",
      },
    });
    return;
  }
  context.store.set<PendingOutput>("pending_outputs", key, { ...pending, delivery: "sending" });
  try {
    await context.hooks.output?.(task, participant, { ...pending.entry, id: key });
    context.store.delete("pending_outputs", key);
  } catch (error) {
    const failure = safeError(error);
    context.store.set<PendingOutput>("pending_outputs", key, {
      ...pending,
      delivery: failure.outcome === "not_executed" ? "retryable" : "uncertain",
      error: failure,
    });
  }
}
