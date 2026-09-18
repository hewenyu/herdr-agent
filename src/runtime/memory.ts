import { createHash } from "node:crypto";
import type { MemoryConfig } from "../config/types.js";
import { OperationError } from "../core/errors.js";
import type { ActorContext } from "../core/types.js";
import type { Store } from "../storage/store.js";

export interface MemoryEntry {
  summary: string;
  revision: string;
}
export interface MemoryProvider {
  recall(actor: ActorContext, signal?: AbortSignal): Promise<MemoryEntry>;
  store(actor: ActorContext, entry: MemoryEntry, signal?: AbortSignal): Promise<void>;
}
export function memoryEntry(summary: string): MemoryEntry {
  return { summary, revision: summary ? createHash("sha256").update(summary).digest("hex") : "" };
}
export class MemoryService implements MemoryProvider {
  constructor(
    private readonly database: Store,
    private readonly config?: MemoryConfig,
    private readonly request: typeof fetch = globalThis.fetch,
  ) {}

  async recall(actor: ActorContext, signal?: AbortSignal): Promise<MemoryEntry> {
    const config = this.config?.users[actor.ownerId] ?? this.config;
    if (!config || config.provider === "file")
      return this.database.get<MemoryEntry>("memory", actor.sessionId) ?? memoryEntry("");
    const response = await this.call(config, "/recall", { scope: scope(actor) }, signal);
    if ([204, 404].includes(response.status)) return memoryEntry("");
    if (response.status !== 200) throw memoryFailure();
    const value = await readLimited(response);
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.summary !== "string" ||
      (value.revision !== undefined && typeof value.revision !== "string")
    )
      throw memoryFailure();
    return { summary: value.summary, revision: value.revision ?? "" };
  }

  async store(actor: ActorContext, entry: MemoryEntry, signal?: AbortSignal): Promise<void> {
    const config = this.config?.users[actor.ownerId] ?? this.config;
    if (!config || config.provider === "file") {
      this.database.set("memory", actor.sessionId, entry);
      return;
    }
    const response = await this.call(config, "/store", { scope: scope(actor), entry }, signal);
    await response.body?.cancel();
    if (![200, 201, 204].includes(response.status)) throw memoryFailure();
  }

  private async call(
    config: Omit<MemoryConfig, "users">,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      const url = new URL(config.baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw memoryFailure();
      const signals = [AbortSignal.timeout(config.timeoutMs)];
      if (signal) signals.push(signal);
      return await this.request(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any(signals),
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw memoryFailure();
    }
  }
}

function scope(actor: ActorContext): Record<string, string> {
  // Keep the legacy protocol's complete owner/chat/task keys. An independent pi
  // session is its own logical chat, so old providers cannot conflate two sessions.
  return {
    owner_id: actor.ownerId,
    chat_id: `pi:${actor.sessionId}`,
    ...(actor.taskId ? { task_id: actor.taskId } : {}),
  };
}
function memoryFailure(): OperationError {
  return new OperationError(
    "memory_unavailable",
    "对话记忆存储不可用；历史保留，本轮未执行新操作。",
  );
}
async function readLimited(response: Response): Promise<{ summary?: unknown; revision?: unknown }> {
  try {
    const reader = response.body?.getReader();
    if (!reader) throw memoryFailure();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw memoryFailure();
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw memoryFailure();
  }
}
