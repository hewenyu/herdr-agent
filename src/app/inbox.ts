import { safeError } from "../core/errors.js";
import { now } from "../core/ids.js";
import type { Logger } from "../core/ports.js";
import type { ActorContext, CardAction, IncomingMessage } from "../core/types.js";
import type { Store } from "../storage/store.js";

export interface InboxRecord {
  id: string;
  type: "message" | "action" | "task" | "group";
  payload: IncomingMessage | CardAction | { id: string };
  actor?: ActorContext;
  generation?: number;
  lane: string;
  state: "queued" | "processing" | "done" | "uncertain" | "failed";
  error?: ReturnType<typeof safeError>;
  createdAt: string;
  sequence: number;
  attempts?: number;
  nextAttemptAt?: number;
  failureNotice?: "pending" | "attempted" | "delivered";
}

export interface InboxRecovery {
  canRetry(record: InboxRecord, error?: ReturnType<typeof safeError>): boolean;
  exhausted?(record: InboxRecord): Promise<void>;
  retryDelayMs?: number;
}

function logFields(record: Pick<InboxRecord, "id" | "type" | "payload" | "lane">) {
  const payload = record.payload;
  return {
    inboxId: record.id,
    type: record.type,
    lane: record.lane,
    ...("eventId" in payload ? { eventId: payload.eventId } : {}),
    ...("messageId" in payload ? { messageId: payload.messageId } : {}),
    ...("chatId" in payload ? { chatId: payload.chatId } : {}),
  };
}

/** ACK only after durable enqueue; each chat stays ordered and independent chats can run together. */
export class Inbox {
  private readonly active = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(
    private readonly store: Store,
    private readonly process: (record: InboxRecord) => Promise<void>,
    private readonly logger: Logger,
    private readonly concurrency = 8,
    private readonly recovery?: InboxRecovery,
  ) {
    for (const [id, record] of store.entries<InboxRecord>("inbox")) {
      if (
        record.state === "processing" ||
        record.state === "failed" ||
        record.state === "uncertain"
      ) {
        const retry = (record.attempts ?? 0) < 3 && recovery?.canRetry(record, record.error);
        if (retry) store.set("inbox", id, { ...record, state: "queued", nextAttemptAt: 0 });
        else if (record.state === "processing")
          store.set("inbox", id, { ...record, state: "uncertain", failureNotice: "pending" });
      }
    }
  }

  enqueue(
    type: InboxRecord["type"],
    id: string,
    payload: InboxRecord["payload"],
    binding?: { actor: ActorContext; generation: number },
  ): boolean {
    const key = `${type}:${id}`;
    const lane =
      "chatId" in payload ? `${payload.ownerId}:${payload.chatId}` : `${type}:${payload.id}`;
    const fields = logFields({ id: key, type, payload, lane });
    if (this.stopped) {
      this.logger.info("事件未入队：服务正在停止", {
        event: "inbox.rejected",
        ...fields,
        reason: "stopping",
      });
      return false;
    }
    const existing = this.store.get<InboxRecord>("inbox", key);
    if (existing) {
      this.logger.info("重复事件已忽略", {
        event: "inbox.duplicate",
        ...fields,
        state: existing.state,
      });
      return false;
    }
    this.store.transaction(() => {
      const sequence = (this.store.get<number>("counters", "inbox") ?? 0) + 1;
      this.store.set("counters", "inbox", sequence);
      this.store.set<InboxRecord>("inbox", key, {
        id: key,
        type,
        payload,
        ...binding,
        lane,
        state: "queued",
        createdAt: now(),
        sequence,
      });
    });
    this.logger.info("事件已持久入队", { event: "inbox.accepted", ...fields, state: "queued" });
    return true;
  }

  async drain(): Promise<void> {
    if (this.stopped) return;
    const notices = this.store
      .entries<InboxRecord>("inbox")
      .filter(([, record]) => record.failureNotice === "pending")
      .map(([, record]) => this.notifyFailure(record));
    const rows = this.queued();
    for (const [, record] of rows) {
      if (this.active.size >= this.concurrency) break;
      if (this.active.has(record.lane)) continue;
      if ((record.nextAttemptAt ?? 0) > Date.now()) continue;
      const running = this.runLane(record.lane).finally(() => this.active.delete(record.lane));
      this.active.set(record.lane, running);
    }
    await Promise.allSettled([...this.active.values(), ...notices]);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.active.values()]);
  }

  private queued() {
    return this.store
      .entries<InboxRecord>("inbox")
      .filter(([, record]) => record.state === "queued")
      .sort(
        ([, a], [, b]) =>
          (a.sequence ?? 0) - (b.sequence ?? 0) || a.createdAt.localeCompare(b.createdAt),
      );
  }

  private async runLane(lane: string): Promise<void> {
    while (!this.stopped) {
      const next = this.queued().find(([, record]) => record.lane === lane);
      if (!next) return;
      const [id, record] = next;
      if ((record.nextAttemptAt ?? 0) > Date.now()) return;
      record.attempts = (record.attempts ?? 0) + 1;
      this.store.set("inbox", id, { ...record, state: "processing" });
      const startedAt = performance.now();
      const fields = logFields(record);
      this.logger.info("开始处理事件", {
        event: "inbox.processing",
        ...fields,
        state: "processing",
      });
      try {
        await this.process(record);
        this.store.set("inbox", id, {
          ...record,
          state: "done",
          error: undefined,
          nextAttemptAt: undefined,
        });
        this.logger.info("事件处理完成", {
          event: "inbox.completed",
          ...fields,
          state: "done",
          durationMs: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        const safe = safeError(error);
        const retry = !this.stopped && record.attempts < 3 && this.recovery?.canRetry(record, safe);
        const state = retry ? "queued" : safe.outcome === "not_executed" ? "failed" : "uncertain";
        const failed: InboxRecord = {
          ...record,
          state,
          error: safe,
          nextAttemptAt: retry
            ? Date.now() + (this.recovery?.retryDelayMs ?? 1000) * record.attempts
            : undefined,
          failureNotice: retry ? undefined : "pending",
        };
        this.store.set("inbox", id, failed);
        this.logger.error("消息处理未完成", {
          event: "inbox.failed",
          ...fields,
          state,
          code: safe.code,
          outcome: safe.outcome,
          durationMs: Math.round(performance.now() - startedAt),
        });
        if (retry) return;
        if (!this.stopped) await this.notifyFailure(failed);
      }
    }
  }

  private async notifyFailure(record: InboxRecord): Promise<void> {
    if (!this.recovery?.exhausted || record.failureNotice !== "pending") return;
    this.store.set("inbox", record.id, { ...record, failureNotice: "attempted" });
    try {
      await this.recovery.exhausted(record);
      const current = this.store.get<InboxRecord>("inbox", record.id);
      if (current) this.store.set("inbox", record.id, { ...current, failureNotice: "delivered" });
    } catch (error) {
      this.logger.warn("中断状态通知未送达", {
        event: "inbox.failure_notice_failed",
        code: safeError(error).code,
      });
    }
  }
}
