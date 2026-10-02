import { fail } from "../core/errors.js";
import { stableId } from "../core/ids.js";
import type { InboxRecord } from "../core/inbox.js";
import type { Task } from "../core/types.js";
import type { Store } from "../storage/store.js";

/** Durable ingress wins before its worker can acquire the task/model locks. */
export function taskIngress(store: Store, task: Task, lifecycleOnly = false) {
  const records = store.list<InboxRecord>("inbox").filter((record) => {
    const payload = record.payload;
    if (record.type === "task") return "id" in payload && payload.id === task.remoteTaskId;
    if (record.type === "group") return "id" in payload && payload.id === task.chatId;
    const payloadOwner = "ownerId" in payload ? payload.ownerId : undefined;
    if (
      lifecycleOnly ||
      (record.actor?.ownerId ?? payloadOwner) !== task.ownerId ||
      (payloadOwner !== undefined && payloadOwner !== task.ownerId)
    )
      return false;
    return (
      record.actor?.taskId === task.id ||
      ("chatId" in payload &&
        (payload.chatId === task.chatId || payload.chatId === task.entryChatId))
    );
  });
  return {
    pending: records.some((record) => ["queued", "processing"].includes(record.state)),
    unverifiedLifecycle: records.some(
      (record) =>
        ["task", "group"].includes(record.type) &&
        !!store.get<{ error?: string }>("remote_poll", `${task.id}:${record.type}`)?.error,
    ),
    // Processed harmless events still invalidate in-flight decisions, but never
    // change the user's requirements or replenish a model/native retry budget.
    revision: stableId(...records.map((record) => `${record.sequence}:${record.id}`).sort()),
  };
}

export function assertTaskIngress(
  store: Store,
  task: Task,
  revision?: string,
  lifecycleOnly = false,
): void {
  const ingress = taskIngress(store, task, lifecycleOnly);
  if (
    ingress.pending ||
    (revision !== undefined && ingress.revision !== revision) ||
    ingress.unverifiedLifecycle
  )
    fail("orchestration_deferred", "任务相关事件正在核对，暂缓新的执行输入。");
}
