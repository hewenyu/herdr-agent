import { fail } from "../core/errors.js";
import { now } from "../core/ids.js";
import type { ActorContext, Delivery, Participant, Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import type { Store } from "../storage/store.js";
import type { InputDelivery } from "./input-delivery.js";

export type ParticipantProjection = Participant & {
  initialDelivery: "confirmed" | "decided" | "pending";
};

export class TaskRecords {
  constructor(
    readonly store: Store,
    private readonly allowed: () => string[],
  ) {}

  authorize(ownerId: string): void {
    if (!ownerId || !this.allowed().includes(ownerId)) fail("unauthorized", "当前用户未获授权。");
  }

  get(actor: Pick<ActorContext, "ownerId" | "taskId" | "chatId" | "source">, id: string): Task {
    this.authorize(actor.ownerId);
    const task = this.store.get<Task>("tasks", id);
    if (!task || task.ownerId !== actor.ownerId) fail("task_missing", "任务不存在或无权访问。");
    const bound = this.byChat(actor.chatId);
    if (actor.source !== "web" && bound && (bound.id !== id || actor.taskId !== bound.id))
      fail("task_scope", "任务群身份必须使用服务端绑定任务。");
    const localOrchestrator =
      actor.source === "system" &&
      ["model", "workflow"].includes(task.orchestration?.mode ?? "") &&
      !task.chatId &&
      actor.taskId === task.id &&
      actor.chatId === task.entryChatId;
    if (
      actor.taskId &&
      (actor.taskId !== id ||
        (actor.source !== "web" && !localOrchestrator && task.chatId !== actor.chatId))
    ) {
      fail("task_scope", "本群只能操作绑定任务。");
    }
    return task;
  }

  list(ownerId: string, all = false): Task[] {
    this.authorize(ownerId);
    return this.store
      .list<Task>("tasks")
      .filter(
        (task) =>
          task.ownerId === ownerId && (all || !["completed", "destroyed"].includes(task.status)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  byChat(chatId: string): Task | undefined {
    return this.store
      .list<Task>("tasks")
      .find((task) => task.chatId === chatId && !task.groupDeleted);
  }

  /**
   * Return the durable task binding even after its group has been dissolved.
   * Active routing must use byChat(); callbacks still need this historical
   * binding so a late message or card cannot be treated as a new main-chat
   * conversation after cleanup.
   */
  historyByChat(chatId: string): Task | undefined {
    return this.store
      .list<Task>("tasks")
      .filter((task) => task.chatId === chatId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  participants(task: Task): Participant[] {
    return task.participantIds
      .map((id) => this.store.get<Participant>("participants", id))
      .filter((participant): participant is Participant => !!participant);
  }

  /** Read-only delivery facts; initialSent remains the scheduler's compatibility flag. */
  projectParticipants(task: Task): ParticipantProjection[] {
    const prepared = this.store.entries<InputDelivery>("input_deliveries");
    return this.participants(task).map((participant) => {
      const ids = new Set([`${participant.id}:initial`]);
      for (const [id, delivery] of prepared) {
        if (
          delivery.operationId === id &&
          delivery.taskId === task.id &&
          delivery.participantId === participant.id &&
          delivery.initial &&
          delivery.receipt === participant.initialReceipt &&
          this.store.get<OperationReceipt>("operations", id)?.fingerprint === delivery.fingerprint
        )
          ids.add(id);
      }
      let initialDelivery: ParticipantProjection["initialDelivery"] = "pending";
      for (const id of ids) {
        const operation = this.store.get<OperationReceipt>("operations", id);
        if (!operation || operation.retiredByRestart) continue;
        const resolution = operation.resolution;
        if (resolution) {
          if (resolution.choice !== "treat_done") continue;
          if (resolution.decidedBy !== "evidence") {
            initialDelivery = "decided";
            continue;
          }
          if ((resolution.result as Delivery | undefined)?.verified !== true) continue;
        } else if (
          operation.state !== "done" ||
          (operation.result as Delivery | undefined)?.verified !== true
        ) {
          continue;
        }
        initialDelivery = "confirmed";
        break;
      }
      return { ...participant, initialDelivery };
    });
  }

  save(task: Task): Task {
    task.updatedAt = now();
    this.store.set("tasks", task.id, task);
    return task;
  }

  saveParticipant(participant: Participant): Participant {
    participant.updatedAt = now();
    this.store.set("participants", participant.id, participant);
    return participant;
  }
}
