import { dirname } from "node:path";
import { assertTaskIngress, taskIngress } from "../app/task-ingress.js";
import { OperationError, safeError } from "../core/errors.js";
import { newId, stableId } from "../core/ids.js";
import type { Participant, Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import { assertActive, type TaskContext } from "./context.js";
import { recordOutput } from "./observe.js";

export interface ExecutionRecovery {
  id: string;
  taskId: string;
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
 * is deliberately untouched: repair must not look like a user control.
 */
export function setExecutionRecoveryPause(context: Pick<TaskContext, "store">, task: Task): void {
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
 * plain send. Only user controls keep repair deferred; a persisted `gone` task
 * may carry a scheduling pause from the very observation that found it.
 */
export function userControlPaused(context: Pick<TaskContext, "store">, task: Task): boolean {
  if (!task.discussion.paused) return false;
  if (task.status === "paused") return true;
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
  if (task.error === diagnostic || task.error === readyDiagnostic) task.error = undefined;
  return true;
}

/** Deleting a definite refusal lets Operations.run retry the identical parameters. */
function retryRefused(context: Pick<TaskContext, "store" | "operations">, id: string): void {
  const receipt = context.store.get<OperationReceipt>("operations", id);
  if (receipt?.state === "failed" && receipt.error?.outcome === "not_executed")
    context.store.delete("operations", id);
}

function eligible(task: Task): boolean {
  return !(
    ["paused", "completed", "destroying", "destroyed"].includes(task.status) ||
    task.closeRequested ||
    task.completionRequest ||
    task.groupDeleted
  );
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

/** Execution-only repair under the task lock. Never send input or alter old operation receipts. */
export async function recoverMissingExecutions(
  context: TaskContext,
  task: Task,
  controlPending: () => boolean,
): Promise<void> {
  if (!eligible(task) || controlPending()) return;
  // A plain send or automatic observation pause is not a user control; only an
  // explicit pause/interrupt/removal keeps repair deferred.
  if (userControlPaused(context, task)) return;
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
    // A close receipt may refer to intentionally removed resources, including legacy records.
    if (context.store.get("operations", `${participant.id}:close`)) continue;
    const guard = () => {
      assertActive(context);
      const latest = context.store.get<Task>("tasks", task.id);
      const current = context.store.get<Participant>("participants", participant.id);
      if (
        controlPending() ||
        !latest ||
        !eligible(latest) ||
        // An explicit pause/interrupt/removal that arrived while creating must
        // defer the repair, even before its participant record is written.
        userControlPaused(context, latest) ||
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
    if (recovery?.state !== "building") {
      if (!participant.started) continue;
      try {
        const agent = await context.herdr.get(participant.execution.paneId, context.signal);
        guard();
        if (
          agent.paneId !== participant.execution.paneId ||
          agent.workspaceId !== participant.execution.workspaceId ||
          agent.kind !== participant.kind
        )
          throw new OperationError("agent_replaced", "参与者身份发生变化，已停止调度。");
        // A historical gone marker is not authority to replace a live target.
        continue;
      } catch (error) {
        if (
          !(error instanceof OperationError) ||
          !["agent_not_found", "pane_not_found"].includes(error.code)
        )
          throw error;
      }
      guard();
      // Do not churn workspaces if the empty replacement itself exits before a fresh arrangement.
      if (participant.recoveryPending) continue;
      const id = `${participant.id}:recovery:${newId("execution")}`;
      recovery = {
        id,
        taskId: task.id,
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
        participant.executionRecovery = id;
        participant.recoveryPending = true;
        participant.status = "gone";
        participant.error = diagnostic;
        task.status = "attention";
        task.error = diagnostic;
        setExecutionRecoveryPause(context, task);
        context.store.set("execution_recoveries", id, recovery);
        context.records.saveParticipant(participant);
        context.records.save(task);
      });
      // Salvage a final reply without allowing a missing transcript to prevent process repair.
      try {
        const latest = await context.herdr.sampleLastReply(recovery.previous.execution!);
        guard();
        const baseline = recovery.baseline as { id?: string } | undefined;
        if (participant.initialSent && latest?.final && latest.id !== baseline?.id)
          await recordOutput(context, task, participant, latest);
      } catch (error) {
        guard();
        recovery.historyError = safeError(error);
        context.store.set("execution_recoveries", id, recovery);
      }
    }
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
    const agent = await context.operations.run(
      `${recovery.id}:start`,
      { pane: workspace.paneId, kind: participant.kind, directories, bypass: task.bypass },
      () => {
        guard();
        return context.herdr.startAgent(workspace.paneId, participant.kind, participant.name, {
          directories,
          bypass: task.bypass,
          signal: context.signal,
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
    const page = await context.herdr.transcript(participant.execution);
    guard();
    context.store.transaction(() => {
      participant.cursor = page.cursor;
      participant.started = true;
      participant.status = agent.status;
      participant.error = readyDiagnostic;
      participant.sessionNote = readyDiagnostic;
      recovery.state = "ready";
      context.store.set("execution_recoveries", recovery.id, recovery);
      context.records.saveParticipant(participant);
      task.error = readyDiagnostic;
      context.records.save(task);
    });
  }
}
