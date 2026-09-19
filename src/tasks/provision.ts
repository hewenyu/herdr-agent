import { fail, OperationError } from "../core/errors.js";
import { now } from "../core/ids.js";
import type { Participant, Task } from "../core/types.js";
import { captureInputBaseline } from "./baseline.js";
import { assertActive, type TaskContext } from "./context.js";
import { recoverInitialInputs } from "./input-recovery.js";
import { participantPrompt, taskDescription } from "./prompts.js";

export async function provision(context: TaskContext, task: Task): Promise<void> {
  assertActive(context);
  await recoverInitialInputs(context, task);
  const { records, platform, operations, catalog } = context;
  // A blocked or attention task can still need provisioning work (for example,
  // the first participant is waiting on a native approval). Do not expose a
  // transient starting state while that user-action fact is being reconciled;
  // observeTask will keep the durable status aligned with the live participants.
  if (task.status !== "blocked" && task.status !== "attention") {
    task.status = "starting";
    records.save(task);
  }
  if (task.createRemoteTask && !task.remoteTaskId) {
    if (!platform) fail("platform_unavailable", "飞书未连接，任务创建等待恢复。");
    const result = await operations.run(
      `${task.id}:remote`,
      { title: task.title, owner: task.ownerId },
      () =>
        platform.createTask({
          title: task.title,
          description: taskDescription(task, records.participants(task)),
          ownerId: task.ownerId,
          key: task.id,
        }),
    );
    task.remoteTaskId = result.id;
    task.remoteTaskUrl = result.url;
    records.save(task);
  }
  if (task.createGroup && !task.chatId) {
    if (!platform) fail("platform_unavailable", "飞书未连接，任务群创建等待恢复。");
    task.chatId = await operations.run(
      `${task.id}:group`,
      { name: task.title, owner: task.ownerId },
      () => platform.createGroup(task.title.slice(0, 80), task.ownerId, task.id),
    );
    records.save(task);
  }
  if (task.createGroup && task.chatId) {
    for (const kind of ["group_ready", "welcome"] as const) {
      assertActive(context);
      const id = `${task.id}:${kind}`;
      if (!context.store.get("task_notices", id)) {
        await context.hooks.notice?.(task, kind);
        context.store.set("task_notices", id, { at: now() });
      }
    }
  }
  if (task.directoryMode === "worktree" && !task.worktreeReady) {
    task.directories = await operations.run(
      `${task.id}:worktree`,
      { directories: task.directories },
      () => catalog.worktree(task.id, task.directories, context.config.stateDir),
    );
    task.worktreeReady = true;
    records.save(task);
  }
  await catalog.verifyDirectories(task.directories);
  for (const participant of records.participants(task)) {
    assertActive(context);
    if (participant.status === "removed") continue;
    await provisionParticipant(context, task, participant);
  }
}

export async function provisionParticipant(
  context: TaskContext,
  task: Task,
  participant: Participant,
): Promise<void> {
  assertActive(context);
  const { herdr, records, operations } = context;
  if (!participant.execution) {
    const workspace = await operations.run(
      `${participant.id}:workspace`,
      { cwd: task.directories[0] },
      () =>
        herdr.createWorkspace(
          task.directories[0] as string,
          `herdr-agent ${task.id} ${participant.name}`,
        ),
    );
    participant.execution = { ...workspace, kind: participant.kind };
    records.saveParticipant(participant);
  }
  const ref = participant.execution;
  ref.transcriptReceipt = participant.initialReceipt;
  if (!participant.started) {
    const agent = await operations.run(
      `${participant.id}:start`,
      {
        pane: ref.paneId,
        kind: participant.kind,
        directories: task.directories,
        bypass: task.bypass,
      },
      () =>
        herdr.startAgent(ref.paneId, participant.kind, participant.name, {
          directories: task.directories,
          bypass: task.bypass,
        }),
    );
    participant.started = true;
    participant.status = agent.status;
    participant.execution.sessionId = agent.sessionId;
    // Establish the output cursor before the first task input can generate a reply.
    participant.cursor = (await herdr.transcript(ref)).cursor;
    records.saveParticipant(participant);
  }
  if (participant.initialSent) return;
  // Round-robin discussion starts one participant. Manual mode waits for the
  // owner to address subsequent participants, avoiding unsolicited parallel turns.
  const first = task.participantIds[0] === participant.id;
  if (!first && !participant.initialSent) return;
  const agent = await herdr.get(ref.paneId);
  if (agent.workspaceId !== ref.workspaceId || agent.kind !== ref.kind)
    fail("agent_replaced", "参与者身份发生变化，停止初始投递。");
  if (agent.status === "blocked" || !agent.interactiveReady || agent.launchPending) {
    participant.status = agent.status;
    records.saveParticipant(participant);
    return;
  }
  const delivery = await operations.run(
    `${participant.id}:initial`,
    { receipt: participant.initialReceipt },
    async () => {
      await captureInputBaseline(context, participant);
      assertActive(context);
      const result = await herdr.send(ref, participantPrompt(task, participant), {
        receipt: participant.initialReceipt,
      });
      if (result.status === "not_executed")
        throw new OperationError("delivery_not_executed", "初始要求未投递，请核对启动状态后重试。");
      if (!result.verified)
        throw new OperationError(
          "delivery_unconfirmed",
          "初始要求已尝试发送但未确认，不能自动重发。",
          "unknown",
        );
      return result;
    },
  );
  participant.initialSent = delivery.verified;
  participant.status = "working";
  records.saveParticipant(participant);
  task.status = "running";
  task.discussion.startedAt ??= now();
  records.save(task);
}
