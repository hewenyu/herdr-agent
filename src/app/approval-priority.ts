import { stableId } from "../core/ids.js";
import type { Task } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { InboxRecord } from "./inbox.js";

/** Durable ingress wins before its worker can acquire the task/model locks. */
export function approvalIngress(store: Store, task: Task): { pending: boolean; revision: string } {
  const records = store.list<InboxRecord>("inbox").filter((record) => {
    const payload = record.payload;
    if (record.type === "task") return "id" in payload && payload.id === task.remoteTaskId;
    if (record.type === "group") return "id" in payload && payload.id === task.chatId;
    if (!("ownerId" in payload) || payload.ownerId !== task.ownerId) return false;
    return (
      record.actor?.taskId === task.id ||
      payload.chatId === task.chatId ||
      payload.chatId === task.entryChatId
    );
  });
  return {
    pending: records.some((record) => ["queued", "processing"].includes(record.state)),
    // Keep the accepted event identity after processing: a harmless remote update
    // or an explicit user instruction can reopen a proven no-effect selection.
    revision: stableId(...records.map((record) => `${record.sequence}:${record.id}`).sort()),
  };
}
