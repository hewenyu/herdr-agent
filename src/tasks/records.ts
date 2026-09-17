import { fail } from "../core/errors.js";
import { now } from "../core/ids.js";
import type { ActorContext, Participant, Task } from "../core/types.js";
import type { Store } from "../storage/store.js";

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
    if (
      actor.taskId &&
      (actor.taskId !== id || (actor.source !== "web" && task.chatId !== actor.chatId))
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

  participants(task: Task): Participant[] {
    return task.participantIds
      .map((id) => this.store.get<Participant>("participants", id))
      .filter((participant): participant is Participant => !!participant);
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
