import type { Store } from "../storage/store.js";
import {
  booleans,
  fields,
  hash,
  type ImportPlan,
  invalid,
  list,
  type SourceFile,
  text,
  version,
} from "./common.js";

export function importReceipts(file: SourceFile, plan: ImportPlan): void {
  const data = fields(file.data);
  version(data);
  if (file.name === "dedup.json") {
    for (const raw of list(data.entries)) {
      const entry = fields(raw);
      const key = text(entry.k);
      if (
        !/^(msg|card|nonce):.+/.test(key) ||
        !text(entry.exp) ||
        !Number.isFinite(Date.parse(text(entry.exp)))
      )
        invalid("旧事件去重标识无效");
      plan.add("legacy_event_receipts", key, { expiresAt: entry.exp, source: file.name });
    }
  } else if (file.name === "assistant-operations.json") {
    for (const [key, raw] of Object.entries(fields(data.operations))) {
      const value = fields(raw);
      booleans(value, ["done", "not_executed"]);
      if (
        !key ||
        !/^[a-f0-9]{64}$/i.test(text(value.fingerprint)) ||
        (value.done && !value.result && !value.error) ||
        (value.not_executed && (!value.done || !value.error))
      )
        invalid("旧工具操作回执不完整");
      plan.add("legacy_operations", key, value);
    }
  } else if (file.name === "deliveries.json") {
    for (const [key, raw] of Object.entries(fields(data.receipts))) {
      const value = fields(raw);
      booleans(value, ["complete"]);
      const chunks = value.chunks ?? 0;
      if (
        !key ||
        typeof chunks !== "number" ||
        !Number.isSafeInteger(chunks) ||
        chunks < 0 ||
        (!value.complete && chunks === 0)
      )
        invalid("旧结果送达回执无效");
      plan.add("legacy_deliveries", key, value);
    }
  } else if (file.name === "routes.json" || file.name === "selection.json") {
    for (const raw of list(data.entries)) {
      const value = fields(raw);
      const key = text(file.name === "routes.json" ? value.m : value.c);
      if (!key) invalid("旧聊天路由标识无效");
      plan.add(file.name === "routes.json" ? "legacy_routes" : "legacy_selection", key, value);
    }
  } else if (file.name.startsWith("notifications/")) {
    booleans(data, ["decided", "notify", "sending", "delivered", "recorded"]);
    if (!text(data.event_id) || !text(data.owner_id) || !text(data.chat_id) || !text(data.task_id))
      invalid("旧通知作用域无效");
    plan.add("legacy_notifications", text(data.event_id), data);
  }
}

/** Check before enqueueing. Imported facts never expire into permission to replay. */
export function isLegacyReplay(
  store: Store,
  input: {
    kind?: "message" | "action";
    eventId?: string;
    messageId?: string;
    ownerId?: string;
    chatId?: string;
    nonce?: string;
  },
): boolean {
  const ns = input.kind === "action" ? "card" : "msg";
  if (input.eventId && store.get("legacy_event_receipts", `${ns}:${input.eventId}`)) return true;
  if (
    input.kind === "action" &&
    input.nonce &&
    store.get("legacy_event_receipts", `nonce:${input.nonce}`)
  )
    return true;
  return !!(
    input.ownerId &&
    input.chatId &&
    input.messageId &&
    store.get("legacy_message_receipts", hash(input.ownerId, input.chatId, input.messageId))
  );
}
export function legacyOperation(store: Store, ownerId: string, requestId: string): unknown {
  return store.get("legacy_operations", `${ownerId}\0${requestId}`);
}
