import type { Task } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { InboxRecord } from "./inbox.js";

/** Keep the chat until accepted user turns and every outgoing text have settled. */
export function canDeleteTaskGroup(store: Store, task: Task): boolean {
  if (!task.chatId || task.groupDeleted) return true;
  const incoming = store
    .list<InboxRecord>("inbox")
    .some(
      (record) =>
        "chatId" in record.payload &&
        record.payload.chatId === task.chatId &&
        ["queued", "processing", "uncertain"].includes(record.state),
    );
  const outgoing = store
    .list<{ chatId: string; state: string }>("outbox")
    .some((record) => record.chatId === task.chatId && record.state !== "delivered");
  return !incoming && !outgoing;
}
