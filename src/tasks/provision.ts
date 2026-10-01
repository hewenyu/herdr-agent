import { dirname } from "node:path";
import { fail, OperationError } from "../core/errors.js";
import { now } from "../core/ids.js";
import type { Participant, Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import { captureInputBaseline } from "./baseline.js";
import { assertActive, type TaskContext } from "./context.js";
import { prepareInputDelivery, retryUnsentInput } from "./input-delivery.js";
import { inputGuard, launchGuard } from "./input-guard.js";
import { recoverInitialInputs } from "./input-recovery.js";
import { inputTiming } from "./input-timing.js";
import { businessPaused, executorHeld } from "./pause.js";
import { participantPrompt, taskDescription } from "./prompts.js";
import { type ExecutionObservation, inputReady, reconcileReadiness } from "./readiness.js";

export async function provision(context: TaskContext, task: Task): Promise<void> {
  assertActive(context);
  await recoverInitialInputs(context, task);
  const { records, platform, operations, catalog } = context;
  // A blocked, attention or business-paused task can still need provisioning
  // work (the executor is lifecycle, not business). Do not expose a transient
  // starting state while a user-action fact or an explicit pause is settled;
  // observeTask keeps the durable status aligned with the live participants.
  if (!["blocked", "attention", "paused"].includes(task.status)) {
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
  // Execution repair has its own durable operations and must never fall through to old input.
  if (participant.executionRecovery || executorHeld(context.store, participant.id)) return;
  if (!participant.execution) {
    const workspace = await operations.run(
      `${participant.id}:workspace`,
      { cwd: task.directories[0] },
      () =>
        herdr.createWorkspace(
          task.directories[0] as string,
          `myrix ${task.id} ${participant.name}`,
        ),
    );
    participant.execution = { ...workspace, kind: participant.kind };
    records.saveParticipant(participant);
  }
  const ref = participant.execution;
  ref.transcriptReceipt = participant.initialReceipt;
  if (!participant.started) {
    const directories = [
      ...new Set([
        ...task.directories,
        ...(task.boardDirectory ? [task.boardDirectory] : []),
        ...(task.recovery ? [dirname(task.recovery.materialPath)] : []),
      ]),
    ];
    const assertLaunch = launchGuard(context, task, participant);
    assertLaunch();
    const refused = context.store.get<OperationReceipt>("operations", `${participant.id}:start`);
    if (
      refused?.state === "failed" &&
      refused.error?.outcome === "not_executed" &&
      ["lifecycle_revoked", "orchestration_deferred", "stopping", "cancelled"].includes(
        refused.error.code,
      )
    )
      context.store.delete("operations", `${participant.id}:start`);
    const agent = await operations.run(
      `${participant.id}:start`,
      {
        pane: ref.paneId,
        kind: participant.kind,
        directories,
        bypass: task.bypass,
      },
      () => {
        assertLaunch();
        return herdr.startAgent(ref.paneId, participant.kind, participant.name, {
          directories,
          bypass: task.bypass,
          signal: context.signal,
          beforeWrite: assertLaunch,
        });
      },
    );
    participant.started = true;
    participant.status = agent.status;
    participant.execution.sessionId = agent.sessionId;
    // Establish the output cursor before the first task input can generate a reply.
    // A start receipt is not readiness; record the observed lifecycle phase too.
    const observation: ExecutionObservation = { kind: "snapshot", agent };
    const readiness = reconcileReadiness(context.store, records, task, participant, observation);
    // Never report a blocked or launch-pending executor as ready.
    if (!inputReady(readiness) && readiness.phase !== "busy") {
      participant.cursor = (await herdr.transcript(ref)).cursor;
      records.saveParticipant(participant);
      return;
    }
    participant.cursor = (await herdr.transcript(ref)).cursor;
    records.saveParticipant(participant);
  }
  // Business input is fenced by any settled business pause; lifecycle
  // provisioning above is explicitly not.
  if (businessPaused(task)) return;
  if (participant.initialSent || ["model", "workflow"].includes(task.orchestration?.mode ?? ""))
    return;
  // Round-robin discussion starts one participant. Manual mode waits for the
  // owner to address subsequent participants, avoiding unsolicited parallel turns.
  const first = task.participantIds[0] === participant.id;
  if (!first && !participant.initialSent) return;
  const agent = await herdr.get(ref.paneId);
  if (agent.workspaceId !== ref.workspaceId || agent.kind !== ref.kind)
    fail("agent_replaced", "参与者身份发生变化，停止初始投递。");
  const fresh = reconcileReadiness(context.store, records, task, participant, {
    kind: "snapshot",
    agent,
  });
  if (!inputReady(fresh)) {
    participant.status = agent.status;
    records.saveParticipant(participant);
    return;
  }
  retryUnsentInput(context, `${participant.id}:initial`, { receipt: participant.initialReceipt });
  const assertCurrent = inputGuard(context, task, participant);
  const delivery = await operations.run(
    `${participant.id}:initial`,
    { receipt: participant.initialReceipt },
    async () => {
      await captureInputBaseline(context, participant);
      assertCurrent();
      const prepared = prepareInputDelivery(
        context,
        task,
        participant,
        `${participant.id}:initial`,
        { receipt: participant.initialReceipt },
        participantPrompt(task, participant),
      );
      const result = await herdr.send(ref, prepared.prompt, {
        receipt: prepared.receipt,
        signal: context.signal,
        assertCurrent,
        onProgress: inputTiming(context, task, participant, `${participant.id}:initial`),
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
  context.store.transaction(() => {
    context.store.set("participant_awaiting_output", participant.id, {
      operationId: `${participant.id}:initial`,
      at: now(),
    });
    context.store.set("task_input_applied", `${participant.id}:initial`, { at: now() });
    participant.initialSent = delivery.verified;
    participant.status = "working";
    records.saveParticipant(participant);
    task.status = "running";
    task.discussion.startedAt ??= now();
    records.save(task);
  });
}
