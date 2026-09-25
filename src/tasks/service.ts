import { fail, OperationError, safeError } from "../core/errors.js";
import { newId, now, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { RemoteTask } from "../core/ports.js";
import type { ActorContext, AgentKind, Participant, Task, TaskCreateInput } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import { assertActive, type TaskContext } from "./context.js";
import { createTask } from "./create.js";
import { hasFinalDescription, syncDescription, syncFinalDescription } from "./description.js";
import {
  closeTask,
  requestAction,
  syncCompletion,
  syncGroupState,
  type TaskAction,
  type TaskActionOptions,
} from "./lifecycle.js";
import { observeTask } from "./observe.js";
import { ownsTaskOperation } from "./operation-scope.js";
import { TaskOperations } from "./operations.js";
import { taskDescription } from "./prompts.js";
import { provision } from "./provision.js";
import { TaskRecords } from "./records.js";
import { RemotePolls } from "./remote-poll.js";
import { resolveCompletedRetention, resolveGroupRetention } from "./retention.js";
import { relayDiscussion, sendParticipant } from "./send.js";
import { currentUserRequest } from "./user-request.js";

export type TaskServiceOptions = Omit<TaskContext, "records" | "operations" | "signal">;

export class TaskService {
  readonly records: TaskRecords;
  private readonly context: TaskContext;
  private readonly remotePolls: RemotePolls;
  private readonly locks = new KeyedMutex();
  private readonly running = new Set<string>();
  private readonly queued = new Map<string, { start(): void; cancel(): void }>();
  private readonly control = new AbortController();

  constructor(options: TaskServiceOptions) {
    this.remotePolls = new RemotePolls(options.store, () => options.config.tasks.pollIntervalMs);
    this.records = new TaskRecords(options.store, () => options.config.feishu.allowedOpenIds);
    this.context = {
      ...options,
      signal: this.control.signal,
      records: this.records,
      operations: new TaskOperations(options.store, this.control.signal),
    };
  }

  stop(): void {
    this.control.abort();
    for (const pending of this.queued.values()) pending.cancel();
    this.queued.clear();
  }

  create(actor: ActorContext, input: TaskCreateInput): Promise<Task> {
    // A message identity is scoped to the selected pi session. Keeping the
    // creation lock at that same scope prevents a slow project registration
    // in one session from blocking an independent task in another session
    // that happens to reuse the request/message id.
    return this.locks.run(`create:${actor.ownerId}:${actor.sessionId}:${actor.messageId}`, () =>
      createTask(this.context, actor, input),
    );
  }

  get(actor: ActorContext, id: string): Task & { participants: Participant[] } {
    const task = this.records.get(actor, id);
    return { ...task, participants: this.records.participants(task) };
  }

  list(actor: ActorContext, all = false): Task[] {
    if (actor.taskId) return [this.records.get(actor, actor.taskId)];
    return this.records.list(actor.ownerId, all);
  }

  async action(
    actor: ActorContext,
    id: string,
    action: TaskAction,
    options: TaskActionOptions = {},
  ): Promise<Task> {
    return this.locks.run(id, async () => {
      assertActive(this.context);
      const task = this.records.get(actor, id);
      const actionId = `${task.id}:${stableId(actor.messageId, action)}`;
      const applied = this.context.store.transaction(() => {
        const prior = this.context.store.get<TaskActionOptions>("task_actions", actionId);
        if (prior) {
          if (
            prior.keepGroup !== options.keepGroup ||
            prior.keepExecution !== options.keepExecution
          )
            fail("operation_conflict", "同一任务操作不能换用不同的资源保留策略。");
          return false;
        }
        requestAction(this.context, task, action, options);
        this.context.store.set("task_actions", actionId, {
          action,
          keepGroup: options.keepGroup,
          keepExecution: options.keepExecution,
          at: now(),
        });
        return true;
      });
      const current = this.records.get(actor, id);
      Object.assign(task, current);
      // Complete/reopen must finish their explicit transition before a follow-up
      // send in the same pi turn. Failed remote synchronization stays durable.
      try {
        if (
          task.remoteTaskId &&
          task.completionRequest &&
          !["destroying", "destroyed"].includes(task.status)
        )
          await this.remotePolls.run(task.id, "task", true, () =>
            syncCompletion(this.context, task),
          );
        else await syncCompletion(this.context, task);
      } catch (error) {
        task.syncError = safeError(error).message;
        this.records.save(task);
      }
      if (applied && action === "resume" && task.discussion.mode === "round_robin") {
        const previous = this.context.store.get<{
          participantId: string;
          outputId: string;
          text: string;
        }>("discussion_last_output", task.id);
        const participant = previous
          ? this.context.store.get<Participant>("participants", previous.participantId)
          : undefined;
        if (previous && participant && ["idle", "done", "removed"].includes(participant.status)) {
          await relayDiscussion(
            this.context,
            task,
            participant,
            `resume:${actor.messageId}:${previous.outputId}`,
            previous.text,
            true,
          );
        } else if (!previous) {
          const roster = this.records.participants(task);
          const departed = roster.findIndex(
            (entry) => entry.id === task.discussion.activeParticipant && entry.status === "removed",
          );
          if (departed >= 0) {
            const next = [...roster.slice(departed + 1), ...roster.slice(0, departed + 1)].find(
              (entry) => entry.status !== "removed",
            );
            if (next) {
              await sendParticipant(
                this.context,
                task,
                next,
                "用户已恢复讨论。请根据本任务要求完成本轮发言；目前没有已保存的参与者反馈。",
                `${task.id}:relay:resume:${actor.messageId}:initial:${next.id}`,
              );
              task.discussion.nextParticipant = roster
                .filter((entry) => entry.status !== "removed")
                .findIndex((entry) => entry.id === next.id);
              this.records.save(task);
            }
          }
        }
      }
      this.context.hooks.changed?.(task);
      return task;
    });
  }

  async send(
    actor: ActorContext,
    id: string,
    participantId: string | undefined,
    text: string,
  ): Promise<unknown> {
    return this.locks.run(id, async () => {
      const task = this.records.get(actor, id);
      const participant = this.selectParticipant(task, participantId);
      task.discussion.paused = true;
      this.records.save(task);
      return sendParticipant(
        this.context,
        task,
        participant,
        text,
        `${task.id}:send:${stableId(actor.messageId, participant.id, text)}`,
        currentUserRequest(this.context.store, actor),
      );
    });
  }

  async interrupt(actor: ActorContext, id: string, participantId?: string): Promise<void> {
    await this.locks.run(id, async () => {
      const task = this.records.get(actor, id);
      task.discussion.paused = true;
      this.records.save(task);
      const selected =
        participantId === "all"
          ? this.records.participants(task)
          : [this.selectParticipant(task, participantId)];
      for (const participant of selected) {
        if (participant.execution && !["removed", "gone"].includes(participant.status)) {
          await this.context.operations.run(
            `${task.id}:stop:${stableId(actor.messageId, participant.id)}`,
            participant.execution,
            () =>
              this.context.herdr.interrupt(
                participant.execution as NonNullable<typeof participant.execution>,
              ),
          );
        }
      }
    });
  }

  async screen(actor: ActorContext, id: string, participantId?: string) {
    const task = this.records.get(actor, id);
    const participant = this.selectParticipant(task, participantId);
    if (!participant.execution) fail("participant_unavailable", "参与者尚未启动。");
    return this.context.herdr.screen(participant.execution);
  }

  async addParticipant(
    actor: ActorContext,
    id: string,
    input: { kind: AgentKind; name?: string; role?: string },
  ): Promise<Participant> {
    return this.locks.run(id, async () => {
      assertActive(this.context);
      const task = this.records.get(actor, id);
      if (["completed", "destroying", "destroyed"].includes(task.status))
        fail("task_ended", "结束的任务不能新增参与者。");
      if (!["codex", "claude"].includes(input.kind)) fail("participant_kind", "参与者类型无效。");
      const participantId = `${id}:p_${stableId(actor.messageId, input.kind, input.name ?? "")}`;
      const existing = this.context.store.get<Participant>("participants", participantId);
      if (existing) return existing;
      if (
        this.records.participants(task).filter((entry) => entry.status !== "removed").length >= 8
      ) {
        fail("participant_limit", "单任务最多 8 位参与者。");
      }
      const participant: Participant = {
        id: participantId,
        taskId: id,
        kind: input.kind,
        name: input.name || `${input.kind}-${task.participantIds.length + 1}`,
        role: input.role ?? "",
        status: "pending",
        started: false,
        initialSent: false,
        initialReceipt: `HERDR_RECEIPT_${newId("r").slice(2)}`,
        createdAt: now(),
        updatedAt: now(),
      };
      task.participantIds.push(participant.id);
      this.context.store.transaction(() => {
        this.records.saveParticipant(participant);
        this.records.save(task);
      });
      return participant;
    });
  }

  async removeParticipant(actor: ActorContext, id: string, participantId: string): Promise<void> {
    await this.locks.run(id, async () => {
      const task = this.records.get(actor, id);
      const participant = this.selectParticipant(task, participantId);
      task.discussion.paused = true;
      this.records.save(task);
      if (participant.execution)
        await this.context.operations.run(`${participant.id}:close`, participant.execution, () =>
          this.context.herdr.close(
            participant.execution as NonNullable<typeof participant.execution>,
          ),
        );
      participant.status = "removed";
      this.records.saveParticipant(participant);
    });
  }

  async tick(): Promise<void> {
    if (this.control.signal.aborted) return;
    const added: Promise<void>[] = [];
    for (const task of this.context.store.list<Task>("tasks")) {
      if (
        (task.status === "destroyed" &&
          !hasFinalDescription(this.context, task) &&
          !(task.chatId && !task.groupDeleted && this.context.platform?.getGroupStatus)) ||
        this.running.has(task.id) ||
        this.queued.has(task.id)
      )
        continue;
      added.push(
        new Promise<void>((resolve, reject) => {
          this.queued.set(task.id, {
            cancel: resolve,
            start: () => {
              this.running.add(task.id);
              void this.reconcile(task.id, { forceRemote: false })
                .finally(() => {
                  this.running.delete(task.id);
                  this.schedule();
                })
                .then(resolve, reject);
            },
          });
        }),
      );
    }
    this.schedule();
    // A later poll can enqueue newly created tasks while earlier work is still running.
    // Await only this poll's additions; do not retain another waiter for every slow task.
    await Promise.all(added);
  }

  private schedule(): void {
    while (
      !this.control.signal.aborted &&
      this.running.size < this.context.config.runtime.maxConcurrentTasks
    ) {
      const next = this.queued.entries().next().value;
      if (!next) return;
      this.queued.delete(next[0]);
      next[1].start();
    }
  }

  /** Direct event/manual reconciliation is immediate; background ticks opt into remote polling. */
  async reconcile(id: string, options: { forceRemote?: boolean } = {}): Promise<void> {
    await this.locks.run(id, async () => {
      if (this.control.signal.aborted) return;
      const task = this.context.store.get<Task>("tasks", id);
      if (!task || !this.context.config.feishu.allowedOpenIds.includes(task.ownerId)) return;
      const forceRemote = options.forceRemote ?? true;
      try {
        if (task.status === "destroyed") {
          // Retained groups remain externally observable after executor cleanup.
          // Poll only while a group is still present; this branch must never
          // reopen the task or repeat native close effects.
          if (task.chatId && !task.groupDeleted && this.context.platform?.getGroupStatus)
            await this.remotePolls.run(task.id, "group", forceRemote, () =>
              syncGroupState(this.context, task),
            );
          await this.syncFinalRemote(task, forceRemote);
          // A successful group read clears a prior group/task poll error, but
          // a pending final projection owns its own unresolved syncError and
          // must remain visible until its exact remote readback succeeds.
          if (!hasFinalDescription(this.context, task)) {
            // A destroyed task must not keep reporting an abandoned completion
            // GET/PATCH failure after its final description has been observed.
            // Only a retained group's current read can still block this
            // terminal projection; task polling is no longer active here.
            task.syncError = this.context.store.get<{ error?: string }>(
              "remote_poll",
              `${task.id}:group`,
            )?.error;
            this.records.save(task);
          }
          return;
        }
        if (task.chatId && !task.groupDeleted && this.context.platform?.getGroupStatus)
          await this.remotePolls.run(task.id, "group", forceRemote, () =>
            syncGroupState(this.context, task),
          );
        else await syncGroupState(this.context, task);
        let completionPolled = false;
        if (
          task.remoteTaskId &&
          task.completionRequest &&
          !["destroying", "destroyed"].includes(task.status)
        )
          completionPolled = await this.remotePolls.run(task.id, "task", forceRemote, () =>
            syncCompletion(this.context, task),
          );
        else await syncCompletion(this.context, task);
        let remote: RemoteTask | undefined;
        let remoteError: unknown;
        let remotePolled = completionPolled;
        const readRemote = async () => {
          if (
            remotePolled ||
            !task.remoteTaskId ||
            !this.context.platform ||
            task.completionRequest ||
            (task.status === "completed" && task.closeRequested) ||
            ["destroying", "destroyed"].includes(task.status)
          )
            return;
          try {
            // Read lifecycle facts before local execution recovery can fail. Reuse
            // this snapshot for the later description instead of issuing another GET.
            await this.remotePolls.run(task.id, "task", forceRemote, async () => {
              remotePolled = true;
              remote = await this.readRemote(task);
            });
          } catch (error) {
            if (error instanceof OperationError && error.code === "stopping") throw error;
            remoteError = error;
          }
        };
        await readRemote();
        if (task.status === "completed" && !task.completionRequest) {
          resolveCompletedRetention(this.context, task);
          this.records.save(task);
        }
        if (task.closeRequested || task.status === "destroying")
          await closeTask(this.context, task);
        if (["destroyed", "destroying"].includes(task.status)) {
          await this.syncFinalRemote(task, forceRemote);
          return;
        }
        const legacyPending = this.context.store.get<OperationReceipt>(
          "operations",
          `${task.id}:legacy-pending`,
        );
        if (legacyPending && ["pending", "uncertain"].includes(legacyPending.state)) return;
        const needsProvision = this.records
          .participants(task)
          .some(
            (participant) =>
              participant.status !== "removed" &&
              (!participant.started ||
                (participant.id === task.participantIds[0] && !participant.initialSent)),
          );
        if (needsProvision && !["completed", "paused"].includes(task.status))
          await provision(this.context, task);
        await observeTask(this.context, task);
        assertActive(this.context);
        // Newly provisioned tasks did not have a remote ID during the early read.
        await readRemote();
        if (remoteError) throw remoteError;
        if (remote) {
          try {
            await syncDescription(
              this.context,
              task,
              remote,
              taskDescription(task, this.records.participants(task)),
            );
          } catch (error) {
            this.remotePolls.recordFailure(task.id, "task", error);
            throw error;
          }
        }
        assertActive(this.context);
        await this.context.hooks.notice?.(task, "progress");
        if (!task.completionRequest) task.syncError = this.remotePolls.error(task.id);
        if (task.status !== "attention") task.error = undefined;
        if (
          task.status === "completed" &&
          !task.closeRequested &&
          !task.completionRequest &&
          task.chatId &&
          !task.keepGroup
        ) {
          task.closeRequested = true;
          this.records.save(task);
          await closeTask(this.context, task);
          await this.syncFinalRemote(task, forceRemote);
        }
        this.records.save(task);
      } catch (error) {
        if (error instanceof OperationError && error.code === "stopping") return;
        const safe = safeError(error);
        const uncertain = this.context.store
          .entries<OperationReceipt>("operations")
          .some(
            ([key, receipt]) =>
              ownsTaskOperation(task, key) && ["pending", "uncertain"].includes(receipt.state),
          );
        if (
          uncertain ||
          (error instanceof OperationError &&
            ["agent_replaced", "directory_missing", "operation_conflict"].includes(error.code))
        ) {
          task.error = safe.message;
          if (!["completed", "paused", "destroying", "destroyed"].includes(task.status))
            task.status = "attention";
          task.pending = uncertain ? "存在已尝试但未确认的操作；只查询，不能重发。" : undefined;
          task.discussion.paused = true;
        } else task.syncError = safe.message;
        this.records.save(task);
      } finally {
        this.context.hooks.changed?.(task);
      }
    });
  }

  private async syncFinalRemote(task: Task, force: boolean): Promise<void> {
    if (task.status !== "destroyed" || !hasFinalDescription(this.context, task)) return;
    await this.remotePolls.run(task.id, "final_description", force, () =>
      syncFinalDescription(this.context, task),
    );
  }

  private async readRemote(task: Task): Promise<RemoteTask | undefined> {
    const platform = this.context.platform;
    if (!platform || !task.remoteTaskId) return;
    const remote = await platform.getTask(task.remoteTaskId);
    assertActive(this.context);
    task.remoteCheckedAt = now();
    if (remote.completedAt && remote.completedAt !== "0" && !task.completedAt) {
      resolveGroupRetention(this.context, task);
      task.completedAt = remote.completedAt;
      task.status = "completed";
      task.closeRequested = true;
      task.discussion.paused = true;
    }
    this.records.save(task);
    return remote;
  }

  private selectParticipant(task: Task, id?: string): Participant {
    const participants = this.records
      .participants(task)
      .filter((entry) => entry.status !== "removed");
    const exact = id ? participants.find((entry) => entry.id === id) : undefined;
    const named = id ? participants.filter((entry) => entry.name === id) : [];
    if (!exact && named.length > 1)
      fail("participant_ambiguous", "有多位同名参与者，请使用参与者编号。");
    const participant = id
      ? (exact ?? named[0])
      : participants.length === 1
        ? participants[0]
        : undefined;
    if (!participant) fail("participant_required", "请指定参与者；可先查看任务的参与者列表。");
    return participant;
  }
}
