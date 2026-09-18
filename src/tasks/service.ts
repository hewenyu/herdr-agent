import { fail, OperationError, safeError } from "../core/errors.js";
import { newId, now, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { ActorContext, AgentKind, Participant, Task, TaskCreateInput } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import { assertActive, type TaskContext } from "./context.js";
import { createTask } from "./create.js";
import { syncDescription } from "./description.js";
import {
  closeTask,
  requestAction,
  syncCompletion,
  syncGroupState,
  type TaskAction,
  type TaskActionOptions,
} from "./lifecycle.js";
import { observeTask } from "./observe.js";
import { TaskOperations } from "./operations.js";
import { taskDescription } from "./prompts.js";
import { provision } from "./provision.js";
import { TaskRecords } from "./records.js";
import { resolveCompletedRetention, resolveGroupRetention } from "./retention.js";
import { relayDiscussion, sendParticipant } from "./send.js";

export type TaskServiceOptions = Omit<TaskContext, "records" | "operations" | "signal">;

export class TaskService {
  readonly records: TaskRecords;
  private readonly context: TaskContext;
  private readonly locks = new KeyedMutex();
  private readonly running = new Set<string>();
  private readonly queued = new Map<string, { start(): void; cancel(): void }>();
  private readonly control = new AbortController();

  constructor(options: TaskServiceOptions) {
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
    return this.locks.run(`create:${actor.ownerId}:${actor.messageId}`, () =>
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
        await syncCompletion(this.context, task);
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
        if (previous && participant && ["idle", "done"].includes(participant.status)) {
          await relayDiscussion(
            this.context,
            task,
            participant,
            `resume:${actor.messageId}:${previous.outputId}`,
            previous.text,
            true,
          );
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
      if (task.status === "destroyed" || this.running.has(task.id) || this.queued.has(task.id))
        continue;
      added.push(
        new Promise<void>((resolve, reject) => {
          this.queued.set(task.id, {
            cancel: resolve,
            start: () => {
              this.running.add(task.id);
              void this.reconcile(task.id)
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

  async reconcile(id: string): Promise<void> {
    await this.locks.run(id, async () => {
      if (this.control.signal.aborted) return;
      const task = this.context.store.get<Task>("tasks", id);
      if (
        !task ||
        task.status === "destroyed" ||
        !this.context.config.feishu.allowedOpenIds.includes(task.ownerId)
      )
        return;
      try {
        await syncGroupState(this.context, task);
        await syncCompletion(this.context, task);
        if (task.status === "completed" && !task.completionRequest) {
          resolveCompletedRetention(this.context, task);
          this.records.save(task);
        }
        if (task.closeRequested || task.status === "destroying")
          await closeTask(this.context, task);
        if (["destroyed", "destroying"].includes(task.status)) return;
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
        if (task.remoteTaskId && this.context.platform) await this.syncRemote(task);
        assertActive(this.context);
        await this.context.hooks.notice?.(task, "progress");
        task.syncError = undefined;
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
        }
        this.records.save(task);
      } catch (error) {
        if (error instanceof OperationError && error.code === "stopping") return;
        const safe = safeError(error);
        const uncertain = this.context.store
          .entries<OperationReceipt>("operations")
          .some(
            ([key, receipt]) =>
              key.startsWith(`${task.id}:`) && ["pending", "uncertain"].includes(receipt.state),
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

  private async syncRemote(task: Task): Promise<void> {
    const platform = this.context.platform;
    if (!platform || !task.remoteTaskId) return;
    const remote = await platform.getTask(task.remoteTaskId);
    task.remoteCheckedAt = now();
    if (remote.completedAt && remote.completedAt !== "0" && !task.completedAt) {
      resolveGroupRetention(this.context, task);
      task.completedAt = remote.completedAt;
      task.status = "completed";
      task.closeRequested = true;
      task.discussion.paused = true;
      this.records.save(task);
      return;
    }
    const description = taskDescription(task, this.records.participants(task));
    assertActive(this.context);
    await syncDescription(this.context, task, remote, description);
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
