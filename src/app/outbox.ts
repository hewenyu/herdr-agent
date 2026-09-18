import { OperationError, safeError } from "../core/errors.js";
import { canonical, now, stableId } from "../core/ids.js";
import type { PlatformPort } from "../core/ports.js";
import type { Store } from "../storage/store.js";

interface Outbound {
  id: string;
  chatId: string;
  text: string;
  parts: string[];
  ids: string[];
  envelope?: { version: 1; replyTo: string | null; fingerprint: string };
  state: "prepared" | "sending" | "delivered" | "uncertain" | "retryable";
  error?: ReturnType<typeof safeError>;
  updatedAt: string;
}

function fingerprint(
  record: Pick<Outbound, "id" | "chatId" | "text" | "parts">,
  replyTo: string | null,
) {
  return stableId(
    canonical({
      id: record.id,
      chatId: record.chatId,
      text: record.text,
      parts: record.parts,
      replyTo,
    }),
  );
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

  /**
   * Recover only the fact that legacy content reached this chat. This cannot
   * prove its reply target and must never authorize a new send or reply ACK.
   */
  legacyDeliveredToChat(
    chatId: string,
    text: string,
    id: string,
  ): Pick<Outbound, "ids" | "updatedAt"> | undefined {
    const record = this.store.get<Outbound>("outbox", id);
    return record &&
      !record.envelope &&
      record.state === "delivered" &&
      record.id === id &&
      record.chatId === chatId &&
      record.text === text &&
      Array.isArray(record.parts) &&
      record.parts.length > 0 &&
      record.parts.every((part) => typeof part === "string" && part.length > 0) &&
      record.parts.join("") === text &&
      Array.isArray(record.ids) &&
      record.ids.length === record.parts.length &&
      record.ids.every((messageId) => typeof messageId === "string" && messageId.length > 0)
      ? { ids: record.ids, updatedAt: record.updatedAt }
      : undefined;
  }

  async send(chatId: string, text: string, id: string, replyTo?: string): Promise<string[]> {
    const existing = this.store.get<Outbound>("outbox", id);
    if (existing && (existing.id !== id || existing.chatId !== chatId || existing.text !== text)) {
      throw new OperationError("outbox_conflict", "发送回执与消息不匹配。");
    }
    const target = replyTo ?? null;
    if (
      existing?.envelope &&
      (existing.envelope.version !== 1 ||
        existing.envelope.replyTo !== target ||
        existing.envelope.fingerprint !== fingerprint(existing, target))
    )
      throw new OperationError("outbox_conflict", "发送回执与原消息或回复目标不匹配。");
    if (existing?.state === "sending" || existing?.state === "uncertain") {
      throw new OperationError(
        "delivery_uncertain",
        "消息送达结果未知，不能自动重复发送。",
        "unknown",
      );
    }
    if (
      existing &&
      !existing.envelope &&
      !(
        existing.ids.length === 0 &&
        ((existing.state === "prepared" && !existing.error) ||
          (existing.state === "retryable" && existing.error?.outcome === "not_executed"))
      )
    ) {
      // Legacy receipts did not distinguish a direct message from a reply.
      // Preserve their known IDs/state, but never invent a target or resend.
      throw new OperationError(
        "outbox_envelope_unknown",
        "旧发送回执未保存回复目标，无法确认本次目标；已保存的送达记录保留，不重新发送。",
        "unknown",
      );
    }
    if (existing?.state === "delivered") return existing.ids;
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
    record.envelope ??= { version: 1, replyTo: target, fingerprint: fingerprint(record, target) };
    const platform = this.platform();
    if (!platform) throw new OperationError("platform_unavailable", "飞书尚未连接。");
    this.store.set("outbox", id, record);
    for (let index = record.ids.length; index < record.parts.length; index += 1) {
      record.state = "sending";
      record.updatedAt = now();
      this.store.set("outbox", id, record);
      try {
        const messageId = await platform.sendText(
          record.chatId,
          record.parts[index] as string,
          stableId(id, String(index)),
          index === 0 ? (record.envelope.replyTo ?? undefined) : undefined,
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
