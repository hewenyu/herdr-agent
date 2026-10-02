import { dirname } from "node:path";
import { OperationError, safeError } from "../core/errors.js";
import { newId, now, stableId } from "../core/ids.js";
import type { Participant, Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import { assertActive, type TaskContext } from "./context.js";
import { assertTaskIngress, taskIngress } from "./ingress.js";
import { launchGuard } from "./input-guard.js";
import { recordOutput } from "./observe.js";
import {
  businessPaused,
  clearUserPause,
  executorHeld,
  lifecycleActive,
  markUserPause,
  userPauseMarked,
} from "./pause.js";
import {
  bindLegacyTrustEffects,
  type ExecutionObservation,
  generationBoundary,
  inputReady,
  isRecoveryDiagnostic,
  readinessDiagnostic,
  reconcileReadiness,
} from "./readiness.js";

export interface ExecutionRecovery {
  id: string;
  taskId: string;
  at?: string;
  /**
   * `building` while the replacement executor has not been observed
   * input-ready; `ready` only once a fresh readback proves readiness. A start
   * receipt is never readiness.
   */
  state: "building" | "ready";
  previous: Participant;
  baseline?: unknown;
  awaitingOutput?: unknown;
  relays: Array<[string, { taskId: string; participantId: string }]>;
  historyError?: ReturnType<typeof safeError>;
}

const diagnostic = "执行现场已丢失；正在重建执行器，旧输入不会自动重发。";
const readyDiagnostic = "执行器已自动重建；旧输入和未知回执保留，请核对历史后发送新的安排。";

/**
 * Mark the current scheduling pause as automatic repair, not a user control
 * pause. Bumping the scheduling revision is what makes an older delivery's
 * recorded `pauseRevision` stale, so late proof for some other participant can
 * never treat the repair pause as its own to clear. `task_user_pause_revision`
 * and the durable user-pause marker are deliberately untouched: repair must not
 * look like a user control. A business pause also never gates this repair.
 */
export function setExecutionRecoveryPause(context: Pick<TaskContext, "store">, task: Task): void {
  // Preserve explicit pauses from records predating the durable user-pause marker.
  if (userControlPaused(context, task)) markUserPause(context.store, task);
  context.store.set(
    "task_pause_revision",
    task.id,
    (context.store.get<number>("task_pause_revision", task.id) ?? 0) + 1,
  );
  task.discussion.paused = true;
}

/**
 * Whether scheduling is paused by an explicit user control — a `pause` action,
 * an interrupt or a participant removal — rather than by automatic repair or a
 * plain send.
 */
export function userControlPaused(context: Pick<TaskContext, "store">, task: Task): boolean {
  if (!task.discussion.paused) return false;
  if (task.status === "paused") return true;
  if (userPauseMarked(context.store, task.id)) return true;
  return (
    (context.store.get<number>("task_user_pause_revision", task.id) ?? -1) >=
    (context.store.get<number>("task_pause_revision", task.id) ?? 0)
  );
}

/** Record that the pause revision now reflects an explicit user control. */
export function markUserControlPause(context: Pick<TaskContext, "store">, task: Task): void {
  context.store.set(
    "task_user_pause_revision",
    task.id,
    context.store.get<number>("task_pause_revision", task.id) ?? 0,
  );
  markUserPause(context.store, task);
}

/**
 * Release the automatic repair pause once the user has sent a fresh arrangement
 * to the rebuilt executor. This is the only thing that resumes automatic
 * scheduling; an explicit user pause/interrupt (or a manual-mode send) is kept.
 */
export function releaseExecutionRecoveryPause(
  context: Pick<TaskContext, "store">,
  task: Task,
): boolean {
  if (!task.discussion.paused || userControlPaused(context, task)) return false;
  // Arranging one rebuilt executor must not resume scheduling while any other
  // remaining participant still awaits its own fresh arrangement. The roster is
  // read from the durable participant records so a removed peer never blocks.
  const awaitingFreshInput = task.participantIds.some((id) => {
    const participant = context.store.get<Participant>("participants", id);
    return (
      participant !== undefined &&
      participant.status !== "removed" &&
      participant.recoveryPending === true
    );
  });
  if (awaitingFreshInput) return false;
  task.discussion.paused = false;
  clearUserPause(context.store, task.id);
  if (task.error === diagnostic || task.error === readyDiagnostic) task.error = undefined;
  return true;
}

/** Deleting a definite refusal lets Operations.run retry the identical parameters. */
function retryRefused(context: Pick<TaskContext, "store" | "operations">, id: string): void {
  const receipt = context.store.get<OperationReceipt>("operations", id);
  if (receipt?.state === "failed" && receipt.error?.outcome === "not_executed")
    context.store.delete("operations", id);
}

/**
 * Retire the relays of the generation whose pane is being replaced. The snapshot
 * taken when the recovery record was created can miss relays added afterwards by
 * salvaging a final reply, and a leftover relay would let that retired generation
 * settle the replacement's fresh work. Merge every matching relay into the
 * recovery journal first so the audit survives, then delete them in the same
 * durable step as the reference swap.
 */
function retireRelays(
  context: Pick<TaskContext, "store">,
  recovery: ExecutionRecovery,
  participant: Participant,
): void {
  const relays = new Map(recovery.relays);
  for (const [key, pending] of context.store.entries<{
    taskId: string;
    participantId: string;
  }>("pending_relays"))
    if (pending.taskId === recovery.taskId && pending.participantId === participant.id)
      relays.set(key, pending);
  recovery.relays = [...relays];
  context.store.set("execution_recoveries", recovery.id, recovery);
  for (const [key] of recovery.relays) context.store.delete("pending_relays", key);
}

function absent(error: unknown): error is OperationError {
  return (
    error instanceof OperationError && ["agent_not_found", "pane_not_found"].includes(error.code)
  );
}

/**
 * Reconcile the replacement's readiness from a fresh native readback, never
 * from the start receipt. A blocked startup menu, a launch-pending agent, a
 * lost identity or an unreadable target all stay not-ready; only a definite
 * `agent_not_found`/`pane_not_found` is evidence of absence.
 */
async function reconcileReplacement(
  context: TaskContext,
  task: Task,
  participant: Participant,
): Promise<ExecutionObservation> {
  const ref = participant.execution;
  if (!ref) return { kind: "unreadable", code: "unallocated" };
  let observation: ExecutionObservation;
  try {
    const agent = await context.herdr.get(ref.paneId, context.signal);
    observation = { kind: "snapshot", agent };
  } catch (error) {
    if (!absent(error)) return { kind: "unreadable", code: safeError(error).code };
    return { kind: "absent", code: error.code };
  }
  if (observation.kind === "snapshot") {
    const agent = observation.agent;
    if (
      agent.paneId !== ref.paneId ||
      agent.workspaceId !== ref.workspaceId ||
      agent.kind !== participant.kind
    )
      throw new OperationError("agent_replaced", "重建执行器的身份未确认，停止调度。");
    ref.sessionId = agent.sessionId;
    ref.transcriptReceipt = participant.initialReceipt;
  }
  if (observation.kind === "snapshot" && observation.agent.status === "blocked") {
    // A startup menu still awaiting a decision is not readiness. Record the
    // readiness, then let the blocked hook run the same restricted trust
    // reconciliation as a first start.
    reconcileReadiness(context.store, context.records, task, participant, observation);
    return observation;
  }
  return observation;
}

/** Execution-only repair under the task lock. Never send input or alter old operation receipts. */
export async function recoverMissingExecutions(
  context: TaskContext,
  task: Task,
  controlPending: () => boolean,
): Promise<void> {
  // Only a terminal/closing lifecycle stops repair. A business pause does not.
  if (!lifecycleActive(task) || controlPending()) return;
  const ingress = taskIngress(context.store, task, true);
  if (ingress.pending || ingress.unverifiedLifecycle) return;
  if (
    context.store
      .list<{ taskId: string; state: string }>("task_restarts")
      .some((entry) => entry.taskId === task.id && entry.state !== "done")
  )
    return;
  for (const participant of context.records.participants(task)) {
    if (!participant.execution || participant.status === "removed") continue;
    // An executor the user explicitly stopped is not resurrected by a pause.
    if (executorHeld(context.store, participant.id)) continue;
    // A close receipt may refer to intentionally removed resources, including legacy records.
    if (context.store.get("operations", `${participant.id}:close`)) continue;
    const guard = () => {
      assertActive(context);
      const latest = context.store.get<Task>("tasks", task.id);
      const current = context.store.get<Participant>("participants", participant.id);
      if (
        controlPending() ||
        !latest ||
        !lifecycleActive(latest) ||
        executorHeld(context.store, participant.id) ||
        !latest.participantIds.includes(participant.id) ||
        current?.status === "removed" ||
        current?.executionRecovery !== participant.executionRecovery
      )
        throw new OperationError("orchestration_deferred", "控制状态已变化，暂缓重建执行器。");
      assertTaskIngress(context.store, latest, ingress.revision, true);
    };
    guard();
    let recovery = participant.executionRecovery
      ? context.store.get<ExecutionRecovery>("execution_recoveries", participant.executionRecovery)
      : undefined;
    if (recovery?.state === "building" && participant.recoveryPending !== true) {
      // The replacement already took a fresh user arrangement, so the repair
      // has served its purpose even though the startup observation never
      // settled. Finalize it as ready; re-running the build would re-apply the
      // repair diagnostic over a running executor.
      const journal = recovery;
      context.store.transaction(() => {
        journal.state = "ready";
        // This branch only runs once the replacement already took a fresh user
        // arrangement (recoveryPending is false), so it is not in a diagnostic
        // state and must not read as attention.
        participant.error = undefined;
        context.store.set("execution_recoveries", journal.id, journal);
        if (isRecoveryDiagnostic(task.error)) task.error = undefined;
        context.records.saveParticipant(participant);
        context.records.save(task);
      });
      continue;
    }
    // A replacement can disappear before it ever becomes input-ready (for
    // example at the startup trust menu). Only a confirmed start in a NEW pane
    // lets a building journal enter the missing-execution path; an incomplete
    // workspace/start effect must keep its original receipt and never be retried
    // through another generation.
    const replacementStarted =
      recovery &&
      participant.execution.paneId !== recovery.previous.execution?.paneId &&
      context.store.get<OperationReceipt>("operations", `${recovery.id}:start`)?.state === "done";
    let missing = false;
    if (recovery?.state !== "building" || replacementStarted) {
      if (!participant.started && !replacementStarted) continue;
      let observation: ExecutionObservation;
      try {
        const agent = await context.herdr.get(participant.execution.paneId, context.signal);
        observation = { kind: "snapshot", agent };
      } catch (error) {
        // A historical gone marker is not authority to replace a live target;
        // a read failure is not authority to respawn either.
        if (!absent(error)) throw error;
        observation = { kind: "absent", code: error.code };
      }
      guard();
      if (observation.kind === "snapshot") {
        const agent = observation.agent;
        if (
          agent.paneId !== participant.execution.paneId ||
          agent.workspaceId !== participant.execution.workspaceId ||
          agent.kind !== participant.kind
        )
          throw new OperationError("agent_replaced", "参与者身份发生变化，已停止调度。");
        if (recovery?.state !== "building") continue;
      } else missing = true;
    }
    if (missing) {
      guard();
      // recoveryPending fences BUSINESS input, not the executor lifecycle. An
      // unused replacement may disappear too; permanently skipping it strands
      // the task after a second close. Rate-limit repeated repairs by the durable
      // generation boundary instead, including pre-upgrade journals without at.
      const boundary = generationBoundary(context.store, participant);
      if (participant.recoveryPending && boundary && Date.now() - Date.parse(boundary) < 60_000)
        continue;
      const id = `${participant.id}:recovery:${newId("execution")}`;
      recovery = {
        id,
        taskId: task.id,
        at: now(),
        state: "building",
        previous: structuredClone(participant),
        baseline: context.store.get("participant_input_baseline", participant.id),
        awaitingOutput: context.store.get("participant_awaiting_output", participant.id),
        relays: context.store
          .entries<{ taskId: string; participantId: string }>("pending_relays")
          .filter(
            ([, entry]) => entry.taskId === task.id && entry.participantId === participant.id,
          ),
      };
      context.store.transaction(() => {
        bindLegacyTrustEffects(context.store, participant);
        participant.executionRecovery = id;
        participant.recoveryPending = true;
        participant.status = "gone";
        participant.error = diagnostic;
        participant.readiness = undefined;
        // A settled explicit business pause stays paused; only an unpaused
        // task moves to attention so the repair pause is visible.
        if (!businessPaused(task)) {
          task.status = "attention";
          task.error = diagnostic;
        } else if (isRecoveryDiagnostic(task.error)) {
          task.error = diagnostic;
        }
        setExecutionRecoveryPause(context, task);
        context.store.set("execution_recoveries", id, recovery);
        context.records.saveParticipant(participant);
        context.records.save(task);
      });
      // Salvage a final reply without allowing a missing transcript to prevent process repair.
      try {
        const previousExecution = recovery.previous.execution;
        if (!previousExecution) throw new OperationError("missing_execution", "旧执行现场缺失。");
        const latest = await context.herdr.sampleLastReply(previousExecution);
        guard();
        const baseline = recovery.baseline as { id?: string } | undefined;
        if (
          !recovery.previous.recoveryPending &&
          participant.initialSent &&
          latest?.final &&
          latest.id !== baseline?.id
        )
          await recordOutput(context, task, participant, latest);
      } catch (error) {
        guard();
        recovery.historyError = safeError(error);
        context.store.set("execution_recoveries", id, recovery);
      }
    }
    if (!recovery) continue;
    guard();
    await context.catalog.verifyDirectories(task.directories);
    guard();
    // Always use a fresh workspace: agent_not_found does not prove its old shell is ours to reuse.
    // The old pane is left untouched, and its exact reference remains in the recovery journal.
    // A definitely-refused receipt (parameters never crossed the effect boundary) may be
    // retried; unknown/pending receipts stay frozen through Operations.run.
    retryRefused(context, `${recovery.id}:workspace`);
    const workspace = await context.operations.run(
      `${recovery.id}:workspace`,
      { cwd: task.directories[0] },
      () => {
        guard();
        return context.herdr.createWorkspace(
          task.directories[0] as string,
          `myrix ${task.id} ${participant.name} recovery`,
          context.signal,
        );
      },
    );
    // Record allocated resources even if a lifecycle event arrived during creation, so cleanup
    // can close them. Never start them until admission has been checked again.
    if (participant.execution.paneId !== workspace.paneId) {
      context.store.transaction(() => {
        participant.execution = { ...workspace, kind: participant.kind };
        // The legacy `${id}:initial` receipt belongs to the retired generation;
        // a fresh native identity needs its own receipts and cannot resolve it.
        participant.initialReceipt = `HERDR_RECEIPT_${stableId(recovery.id, "receipt")}`;
        participant.started = false;
        participant.cursor = undefined;
        participant.lastStateSeq = undefined;
        participant.lastNotifiedState = undefined;
        participant.readiness = undefined;
        context.store.delete("participant_awaiting_output", participant.id);
        context.store.delete("participant_input_baseline", participant.id);
        context.store.delete("participant_idle_wait", participant.id);
        context.records.saveParticipant(participant);
        // Retire every relay of the old generation, including one salvaged after
        // the snapshot, in this same durable step as the reference swap.
        retireRelays(context, recovery, participant);
      });
    }
    guard();
    const directories = [
      ...new Set([
        ...task.directories,
        ...(task.boardDirectory ? [task.boardDirectory] : []),
        ...(task.recovery ? [dirname(task.recovery.materialPath)] : []),
      ]),
    ];
    retryRefused(context, `${recovery.id}:start`);
    const assertLaunch = launchGuard(context, task, participant);
    assertLaunch();
    const agent = await context.operations.run(
      `${recovery.id}:start`,
      { pane: workspace.paneId, kind: participant.kind, directories, bypass: task.bypass },
      () => {
        assertLaunch();
        guard();
        return context.herdr.startAgent(workspace.paneId, participant.kind, participant.name, {
          directories,
          bypass: task.bypass,
          signal: context.signal,
          beforeWrite: () => {
            assertLaunch();
            guard();
          },
        });
      },
    );
    guard();
    if (
      agent.paneId !== workspace.paneId ||
      agent.workspaceId !== workspace.workspaceId ||
      agent.kind !== participant.kind
    )
      throw new OperationError("agent_replaced", "重建执行器的身份未确认，停止调度。");
    participant.execution.sessionId = agent.sessionId;
    participant.execution.transcriptReceipt = participant.initialReceipt;
    // The start receipt proves allocation, not input-readiness. Mark the
    // execution started before reconciling, then derive readiness from a fresh
    // readback; the blocked hook runs the same restricted trust flow as a first
    // start.
    participant.started = true;
    const observation = await reconcileReplacement(context, task, participant);
    guard();
    const readiness = reconcileReadiness(
      context.store,
      context.records,
      task,
      participant,
      observation,
    );
    // Ready/busy means the executor can take input; it never fabricates business
    // completion and never resumes a settled business pause.
    const settled = inputReady(readiness) || readiness.phase === "busy";
    const observedStatus =
      observation.kind === "snapshot"
        ? observation.agent.status
        : observation.kind === "absent"
          ? ("gone" as const)
          : // An unreadable target proves neither presence nor absence.
            participant.status;
    const cursor =
      observation.kind === "snapshot"
        ? (
            await context.herdr.transcript(
              participant.execution as NonNullable<typeof participant.execution>,
            )
          ).cursor
        : undefined;
    context.store.transaction(() => {
      if (cursor !== undefined) participant.cursor = cursor;
      participant.started = true;
      participant.status = observedStatus;
      if (settled) {
        participant.error = readyDiagnostic;
        participant.sessionNote = readyDiagnostic;
        recovery.state = "ready";
        task.error = businessPaused(task) ? task.error : readyDiagnostic;
      } else {
        // A blocked menu, launch-pending start or unreadable target is not
        // ready. Keep the repair journal building and say so honestly.
        participant.error = readinessDiagnostic(readiness);
        recovery.state = "building";
        task.error = participant.error;
      }
      context.store.set("execution_recoveries", recovery.id, recovery);
      context.records.saveParticipant(participant);
      context.records.save(task);
    });
  }
}
