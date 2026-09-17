import { OperationError, safeError } from "../core/errors.js";
import { now, stableId } from "../core/ids.js";
import type { PlatformPort } from "../core/ports.js";
import type { Store } from "../storage/store.js";

interface Outbound {
  id: string;
  chatId: string;
  text: string;
  parts: string[];
  ids: string[];
  state: "prepared" | "sending" | "delivered" | "uncertain" | "retryable";
  error?: ReturnType<typeof safeError>;
  updatedAt: string;
}

export function splitText(text: string, max = 3500): string[] {
  const characters = [...text];
  const parts: string[] = [];
  for (let index = 0; index < characters.length; index += max)
    parts.push(characters.slice(index, index + max).join(""));
  return parts;
}

export class Outbox {
  constructor(
    private readonly store: Store,
    private readonly platform: () => PlatformPort | undefined,
  ) {}

  receipt(id: string): Pick<Outbound, "state" | "ids"> | undefined {
    const record = this.store.get<Outbound>("outbox", id);
    return record ? { state: record.state, ids: record.ids } : undefined;
  }

  async send(chatId: string, text: string, id: string, replyTo?: string): Promise<string[]> {
    const existing = this.store.get<Outbound>("outbox", id);
    if (existing && (existing.chatId !== chatId || existing.text !== text)) {
      throw new OperationError("outbox_conflict", "发送回执与消息不匹配。");
    }
    if (existing?.state === "delivered") return existing.ids;
    if (existing?.state === "sending" || existing?.state === "uncertain") {
      throw new OperationError(
        "delivery_uncertain",
        "消息送达结果未知，不能自动重复发送。",
        "unknown",
      );
    }
    const record: Outbound = existing ?? {
      id,
      chatId,
      text,
      parts: splitText(text),
      ids: [],
      state: "prepared",
      updatedAt: now(),
    };
    if (!record.parts.length) return [];
    const platform = this.platform();
    if (!platform) throw new OperationError("platform_unavailable", "飞书尚未连接。");
    this.store.set("outbox", id, record);
    for (let index = record.ids.length; index < record.parts.length; index += 1) {
      record.state = "sending";
      record.updatedAt = now();
      this.store.set("outbox", id, record);
      try {
        const messageId = await platform.sendText(
          chatId,
          record.parts[index] as string,
          stableId(id, String(index)),
          index === 0 ? replyTo : undefined,
        );
        if (!messageId)
          throw new OperationError("delivery_uncertain", "飞书未返回消息标识。", "unknown");
        record.ids.push(messageId);
        record.state = index === record.parts.length - 1 ? "delivered" : "prepared";
        this.store.set("outbox", id, record);
      } catch (error) {
        record.error = safeError(error);
        record.state = record.error.outcome === "not_executed" ? "retryable" : "uncertain";
        this.store.set("outbox", id, record);
        throw error;
      }
    }
    return record.ids;
  }
}
