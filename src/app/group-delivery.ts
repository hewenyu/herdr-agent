import type { Task } from "../core/types.js";
import { proveInertExhaustedTurn } from "../runtime/turn-settlement.js";
import type { Store } from "../storage/store.js";
import type { InboxRecord } from "./inbox.js";

/**
 * Keep the chat until accepted user turns and every outgoing text have settled.
 *
 * An `uncertain` inbox row normally blocks deletion forever. The single
 * exception is a turn that the durable journal proves was effect-free and whose
 * user-visible interruption notice was really delivered; see
 * `runtime/turn-settlement.ts` for the exact read-only proof. Nothing is
 * rewritten, resolved or replayed here, so a task settled by that proof keeps
 * its original audit records and an unknown write still blocks.
 */
export function canDeleteTaskGroup(store: Store, task: Task): boolean {
  if (!task.chatId || task.groupDeleted) return true;
  const chatId = task.chatId;
  const incoming = store
    .list<InboxRecord>("inbox")
    .filter((record) => payloadChatId(record) === chatId)
    .some((record) => {
      if (!["queued", "processing", "uncertain"].includes(record.state)) return false;
      if (record.state !== "uncertain") return true;
      return !isSettledExhaustedTurn(store, record, task);
    });
  const outgoing = store
    .list<{ chatId: string; state: string }>("outbox")
    .some((record) => record.chatId === chatId && record.state !== "delivered");
  return !incoming && !outgoing;
}

/** Read-only diagnostic view: the uncertain rows this task may settle. */
export function settledUncertainInbox(store: Store, task: Task): InboxRecord[] {
  if (!task.chatId || task.groupDeleted) return [];
  return store
    .list<InboxRecord>("inbox")
    .filter(
      (record) =>
        record.state === "uncertain" &&
        payloadChatId(record) === task.chatId &&
        isSettledExhaustedTurn(store, record, task),
    );
}

function isSettledExhaustedTurn(store: Store, record: InboxRecord, task: Task): boolean {
  return proveInertExhaustedTurn(store, record, {
    ownerId: task.ownerId,
    taskId: task.id,
    chatId: task.chatId as string,
  }).proven;
}

function payloadChatId(record: InboxRecord): string | undefined {
  return "chatId" in record.payload ? record.payload.chatId : undefined;
}
