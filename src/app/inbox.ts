import { safeError } from "../core/errors.js";
import { now } from "../core/ids.js";
import type { Logger } from "../core/ports.js";
import type { ActorContext, CardAction, IncomingMessage } from "../core/types.js";
import type { Store } from "../storage/store.js";

export interface InboxRecord {
  id: string;
  type: "message" | "action" | "task";
  payload: IncomingMessage | CardAction | { id: string };
  actor?: ActorContext;
  generation?: number;
  lane: string;
  state: "queued" | "processing" | "done" | "uncertain" | "failed";
  error?: ReturnType<typeof safeError>;
  createdAt: string;
  sequence: number;
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
  ) {
    for (const [id, record] of store.entries<InboxRecord>("inbox")) {
      if (record.state === "processing") store.set("inbox", id, { ...record, state: "uncertain" });
    }
  }

  enqueue(
    type: InboxRecord["type"],
    id: string,
    payload: InboxRecord["payload"],
    binding?: { actor: ActorContext; generation: number },
  ): boolean {
    if (this.stopped) return false;
    const key = `${type}:${id}`;
    if (this.store.get("inbox", key)) return false;
    const lane =
      "chatId" in payload ? `${payload.ownerId}:${payload.chatId}` : `task:${payload.id}`;
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
    return true;
  }

  async drain(): Promise<void> {
    if (this.stopped) return;
    const rows = this.queued();
    for (const [, record] of rows) {
      if (this.active.size >= this.concurrency) break;
      if (this.active.has(record.lane)) continue;
      const running = this.runLane(record.lane).finally(() => this.active.delete(record.lane));
      this.active.set(record.lane, running);
    }
    await Promise.allSettled([...this.active.values()]);
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
      this.store.set("inbox", id, { ...record, state: "processing" });
      try {
        await this.process(record);
        this.store.set("inbox", id, { ...record, state: "done" });
      } catch (error) {
        const safe = safeError(error);
        this.store.set("inbox", id, {
          ...record,
          state: safe.outcome === "not_executed" ? "failed" : "uncertain",
          error: safe,
        });
        this.logger.error("消息处理未完成", { code: safe.code, outcome: safe.outcome });
      }
    }
  }
}
