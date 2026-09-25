import { EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { OperationError } from "../core/errors.js";
import type { Logger, PlatformHandlers, PlatformPort, RemoteTask } from "../core/ports.js";
import { FeishuAPI, object, type Requester, sdkLogger, string } from "./api.js";
import { FetchHttpClient } from "./http.js";
import { normalizeAction, normalizeMessage } from "./normalize.js";
import { FeishuResources } from "./resources.js";

interface Connection {
  start(input: { eventDispatcher: EventDispatcher }): Promise<void>;
  close(input?: { force?: boolean }): void;
}
export interface PlatformDependencies {
  request?: Requester;
  connection?: (callbacks: {
    onReady(): void;
    onError(error: Error): void;
    onReconnecting(): void;
    onReconnected(): void;
  }) => Connection;
  connectTimeoutMs?: number;
}

export class FeishuPlatform implements PlatformPort {
  private readonly api: FeishuAPI;
  private readonly resources: FeishuResources;
  private connection?: Connection;
  private abort?: () => void;
  private started = false;
  private generation = 0;
  private cancelConnect?: () => void;
  private startup?: AbortController;
  private botOpenId = "";

  constructor(
    private readonly options: { appId: string; appSecret: string; logger?: Logger },
    private readonly dependencies: PlatformDependencies = {},
  ) {
    if (!options.appId || !options.appSecret)
      throw new OperationError("feishu_credentials", "飞书凭据尚未配置。");
    this.api = new FeishuAPI(options, dependencies.request);
    this.resources = new FeishuResources(this.api, options.appId);
  }

  /** Resolves when connected. Handlers must only validate and persist an inbox item. */
  async start(
    handlers: PlatformHandlers,
    signal: AbortSignal,
    onFailure?: (error: Error) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.started) throw new OperationError("feishu_already_started", "飞书连接已经启动。");
    this.started = true;
    const generation = ++this.generation;
    const startup = new AbortController();
    this.startup = startup;
    try {
      const identity = await this.api.call(
        { method: "GET", url: "/open-apis/bot/v3/info" },
        AbortSignal.any([signal, startup.signal]),
      );
      signal.throwIfAborted();
      if (!this.started || generation !== this.generation)
        throw new OperationError("feishu_stopped", "飞书连接已停止。");
      this.botOpenId = string(object(identity.bot).open_id);
      if (!this.botOpenId)
        throw new OperationError("feishu_bot_identity", "无法确认飞书机器人的身份。");
      const dispatcher = this.dispatcher(handlers, signal, generation);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.connection?.close({ force: true });
          this.options.logger?.error("等待飞书连接超时。", {
            event: "feishu.connection_failed",
            code: "feishu_connect_timeout",
          });
          reject(new OperationError("feishu_connect_timeout", "等待飞书连接超时。"));
        }, this.dependencies.connectTimeoutMs ?? 30_000);
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (generation === this.generation) this.cancelConnect = undefined;
          clearTimeout(timer);
          error ? reject(error) : resolve();
        };
        this.cancelConnect = () => finish(new OperationError("feishu_stopped", "飞书连接已停止。"));
        const onReady = () => {
          if (generation !== this.generation || signal.aborted || settled) return;
          this.options.logger?.info("飞书长连接已就绪。", { event: "feishu.connection_ready" });
          finish();
        };
        let failureNotified = false;
        const onError = (_error: Error) => {
          if (generation !== this.generation || signal.aborted) return;
          this.options.logger?.error("飞书连接失败，请检查凭据与网络。", {
            event: "feishu.connection_failed",
            code: "feishu_connect_failed",
          });
          const failure = new OperationError(
            "feishu_connect_failed",
            "飞书连接失败，请检查凭据与网络。",
          );
          if (!settled) finish(failure);
          else if (!failureNotified) {
            failureNotified = true;
            onFailure?.(failure);
          }
        };
        const onReconnecting = () => {
          if (generation !== this.generation || signal.aborted) return;
          this.options.logger?.warn("飞书正在重连。", { event: "feishu.reconnecting" });
        };
        const onReconnected = () => {
          if (generation !== this.generation || signal.aborted) return;
          this.options.logger?.info("飞书已恢复连接。", { event: "feishu.reconnected" });
        };
        this.connection =
          this.dependencies.connection?.({ onReady, onError, onReconnecting, onReconnected }) ??
          new WSClient({
            ...this.options,
            logger: sdkLogger(this.options.logger),
            loggerLevel: LoggerLevel.warn,
            httpInstance: new FetchHttpClient(),
            source: "herdr-agent",
            autoReconnect: true,
            handshakeTimeoutMs: 15_000,
            wsConfig: { pingTimeout: 15 },
            onReady,
            onError,
            onReconnecting,
            onReconnected,
          });
        const abort = () => {
          this.connection?.close({ force: true });
          finish(signal.reason ?? new Error("aborted"));
        };
        signal.addEventListener("abort", abort, { once: true });
        this.abort = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
        else void this.connection.start({ eventDispatcher: dispatcher }).catch(onError);
      });
    } catch (error) {
      const stopped = startup.signal.aborted;
      if (generation === this.generation) await this.stop();
      if (stopped) throw new OperationError("feishu_stopped", "飞书连接已停止。");
      throw error;
    } finally {
      if (this.startup === startup) this.startup = undefined;
    }
  }

  private dispatcher(
    handlers: PlatformHandlers,
    signal: AbortSignal,
    generation: number,
  ): EventDispatcher {
    const accepted = (raw: unknown) => {
      const data = object(raw);
      return (
        this.started &&
        generation === this.generation &&
        !signal.aborted &&
        (!data.app_id || data.app_id === this.options.appId)
      );
    };
    return new EventDispatcher({
      logger: sdkLogger(this.options.logger),
      loggerLevel: LoggerLevel.warn,
    }).register({
      "im.message.receive_v1": async (raw) => {
        if (!accepted(raw)) return;
        const message = normalizeMessage(raw, this.botOpenId);
        if (message) {
          this.options.logger?.info("收到飞书消息事件。", {
            event: "feishu.message_received",
            eventId: message.eventId,
            messageId: message.messageId,
            chatId: message.chatId,
            chatType: message.chatType,
          });
          await handlers.message(message);
        }
      },
      "card.action.trigger": async (raw: unknown) => {
        if (!accepted(raw)) return;
        const action = normalizeAction(raw);
        if (action) {
          this.options.logger?.info("收到飞书卡片事件。", {
            event: "feishu.action_received",
            eventId: action.eventId,
            messageId: action.messageId,
            chatId: action.chatId,
          });
          await handlers.action(action);
        }
        return {};
      },
      "task.task.update_user_access_v2": async (raw) => {
        if (accepted(raw) && raw.task_guid) await handlers.taskChanged(raw.task_guid);
      },
      "im.chat.disbanded_v1": async (raw) => {
        const chatId = string(raw.chat_id);
        if (accepted(raw) && raw.app_id === this.options.appId && chatId.trim())
          await handlers.groupChanged?.(chatId);
      },
      "im.chat.member.bot.deleted_v1": async () => {},
    });
  }

  async stop(): Promise<void> {
    this.startup?.abort();
    this.startup = undefined;
    this.cancelConnect?.();
    this.cancelConnect = undefined;
    this.generation++;
    this.abort?.();
    this.abort = undefined;
    this.connection?.close({ force: true });
    this.connection = undefined;
    this.started = false;
  }
  async sendText(chatId: string, text: string, key: string, replyTo?: string): Promise<string> {
    return this.send(chatId, "text", JSON.stringify({ text }), key, replyTo);
  }
  async sendCard(chatId: string, card: Record<string, unknown>, key: string): Promise<string> {
    return this.send(chatId, "interactive", JSON.stringify(card), key);
  }
  private async send(
    chatId: string,
    type: string,
    content: string,
    key: string,
    replyTo?: string,
  ): Promise<string> {
    if (!chatId || !key)
      throw new OperationError("feishu_invalid_message", "发送消息缺少目标或幂等标识。");
    const body = await this.api.call({
      method: "POST",
      url: replyTo
        ? `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`
        : "/open-apis/im/v1/messages",
      params: replyTo
        ? undefined
        : { receive_id_type: chatId.startsWith("ou_") ? "open_id" : "chat_id" },
      data: { ...(replyTo ? {} : { receive_id: chatId }), msg_type: type, content, uuid: key },
    });
    const id = string(object(body.data).message_id);
    if (!id)
      throw new OperationError(
        "feishu_invalid_message",
        "消息可能已发送，但飞书未返回消息标识。",
        "unknown",
      );
    return id;
  }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.api.call({
      method: "PATCH",
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      data: { content: JSON.stringify(card) },
    });
  }
  createTask(input: {
    title: string;
    description: string;
    ownerId: string;
    key: string;
  }): Promise<RemoteTask> {
    return this.resources.createTask(input);
  }
  getTask(id: string): Promise<RemoteTask> {
    return this.resources.getTask(id);
  }
  updateTask(id: string, description: string, completedAt?: string): Promise<void> {
    return this.resources.updateTask(id, description, completedAt);
  }
  createGroup(name: string, ownerId: string, key: string): Promise<string> {
    return this.resources.createGroup(name, ownerId, key);
  }
  deleteGroup(chatId: string): Promise<void> {
    return this.resources.deleteGroup(chatId);
  }
  getGroupStatus(chatId: string): Promise<"normal" | "dissolved"> {
    return this.resources.getGroupStatus(chatId);
  }
  subscribeTasks(): Promise<void> {
    return this.resources.subscribeTasks();
  }
}
