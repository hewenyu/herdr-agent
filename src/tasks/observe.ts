import { OperationError } from "../core/errors.js";
import { now, stableId } from "../core/ids.js";
import type { AgentSnapshot, Participant, Task, TranscriptEntry } from "../core/types.js";
import { assertActive, type TaskContext } from "./context.js";
import { relayDiscussion } from "./send.js";

interface PendingOutput {
  taskId: string;
  participantId: string;
  entry: TranscriptEntry;
}
interface PendingRelay {
  taskId: string;
  participantId: string;
  outputId: string;
  text: string;
}

export async function observeTask(context: TaskContext, task: Task): Promise<void> {
  assertActive(context);
  await flushPendingTaskEvents(context, task);
  if (
    task.discussion.mode === "round_robin" &&
    task.discussion.startedAt &&
    Date.now() - Date.parse(task.discussion.startedAt) >= task.discussion.maxMinutes * 60_000
  ) {
    task.discussion.paused = true;
    context.records.save(task);
  }
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
        if (participant.initialSent && latest && latest.id !== baseline?.id) {
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
        latest &&
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
      (!participant.initialSent || participant.lastNotifiedState !== agent.stateSeq)
    ) {
      assertActive(context);
      await context.hooks.blocked?.(task, participant);
      participant.lastNotifiedState = agent.stateSeq;
      context.records.saveParticipant(participant);
    }
  }
  if (!["completed", "destroying", "destroyed", "paused"].includes(task.status)) {
    const active = context.records.participants(task).filter((entry) => entry.status !== "removed");
    task.status = active.some((entry) => entry.status === "gone" || entry.error)
      ? "attention"
      : active.some((entry) => entry.status === "blocked")
        ? "blocked"
        : active.some((entry) => entry.status === "working")
          ? "running"
          : active.some((entry) => !entry.started)
            ? "starting"
            : "review";
    context.records.save(task);
  }
}

export async function flushPendingTaskEvents(context: TaskContext, task: Task): Promise<void> {
  for (const [key, pending] of context.store.entries<PendingOutput>("pending_outputs")) {
    assertActive(context);
    if (pending.taskId !== task.id) continue;
    const participant = context.store.get<Participant>("participants", pending.participantId);
    if (!participant)
      throw new OperationError("participant_missing", "待投递输出的参与者记录不存在。");
    await deliverOutput(context, task, participant, key, pending.entry);
  }
  for (const [key, pending] of context.store.entries<PendingRelay>("pending_relays")) {
    assertActive(context);
    if (pending.taskId !== task.id) continue;
    const participant = context.store.get<Participant>("participants", pending.participantId);
    if (!participant)
      throw new OperationError("participant_missing", "待转发发言的参与者记录不存在。");
    await relayDiscussion(context, task, participant, pending.outputId, pending.text);
    context.store.delete("pending_relays", key);
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
  context.store.set<PendingOutput>("pending_outputs", key, {
    taskId: task.id,
    participantId: participant.id,
    entry,
  });
  participant.lastOutput = entry.text;
  task.result = `${participant.name} (${participant.kind})：\n${entry.text}`;
  context.records.saveParticipant(participant);
  context.records.save(task);
  await deliverOutput(context, task, participant, key, entry);
  await flushPendingTaskEvents(context, task);
}

async function deliverOutput(
  context: TaskContext,
  task: Task,
  participant: Participant,
  key: string,
  entry: TranscriptEntry,
): Promise<void> {
  assertActive(context);
  await context.hooks.output?.(task, participant, { ...entry, id: key });
  const relay = { taskId: task.id, participantId: participant.id, outputId: key, text: entry.text };
  context.store.transaction(() => {
    context.store.set("task_outputs", key, { at: now(), participantId: participant.id });
    context.store.delete("pending_outputs", key);
    context.store.set<PendingRelay>("pending_relays", key, relay);
    context.store.set<PendingRelay>("discussion_last_output", task.id, relay);
  });
}
