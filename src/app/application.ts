import type { AppConfig } from "../config/types.js";
import { OperationError, safeError } from "../core/errors.js";
import { stableId } from "../core/ids.js";
import type { HerdrPort, Logger, PlatformHandlers, PlatformPort } from "../core/ports.js";
import type {
  ActorContext,
  CardAction,
  IncomingMessage,
  Participant,
  Task,
  TranscriptEntry,
} from "../core/types.js";
import { isLegacyReplay } from "../migration/index.js";
import { ProjectCatalog } from "../projects/catalog.js";
import { type ConversationEngine, PiEngine, SessionService } from "../runtime/index.js";
import { NOTIFICATION_PROMPT } from "../runtime/prompts.js";
import type { Store } from "../storage/store.js";
import { TaskService } from "../tasks/service.js";
import { dispatch, snapshot } from "./actions.js";
import { Approvals } from "./approvals.js";
import type { ApplicationContext } from "./context.js";
import { DirectoryTrust } from "./directory-trust.js";
import { Inbox, type InboxRecord } from "./inbox.js";
import { LegacyBridge } from "./legacy.js";
import { createLogger } from "./logger.js";
import { handleMessage, messageActor } from "./messages.js";
import { Outbox } from "./outbox.js";
import { progressCooling, recordProgressNotice } from "./presentation.js";
import { applicationTools } from "./tools.js";

interface ApplicationOptions {
  config: AppConfig;
  store: Store;
  herdr: HerdrPort;
  platform?: PlatformPort;
  engine?: ConversationEngine;
  logger?: Logger;
}

export class Application implements ApplicationContext {
  readonly config: AppConfig;
  readonly store: Store;
  readonly herdr: HerdrPort;
  platform?: PlatformPort;
  readonly projects: ProjectCatalog;
  readonly sessions: SessionService;
  tasks: TaskService;
  readonly approvals: Approvals;
  readonly outbox: Outbox;
  readonly logger: Logger;
  readonly inbox: Inbox;
  readonly legacy: LegacyBridge;
  private readonly control = new AbortController();
  readonly signal = this.control.signal;
  private readonly engine: ConversationEngine;
  private readonly directoryTrust: DirectoryTrust;
  private readonly active = new Set<Promise<unknown>>();
  authorization = {
    status: "checking",
    message: "正在检查飞书授权。",
  } as ApplicationContext["authorization"];
  runtime = { status: "starting", message: "正在启动。" };
  private readonly listeners = new Set<() => void>();

  constructor(options: ApplicationOptions) {
    this.config = options.config;
    this.store = options.store;
    this.herdr = options.herdr;
    this.platform = options.platform;
    this.logger = options.logger ?? createLogger();
    this.projects = new ProjectCatalog(this.store, this.config.catalog);
    this.engine =
      options.engine ??
      (this.config.ai.enabled
        ? new PiEngine(this.config.ai, { logger: this.logger })
        : {
            contextTokens: this.config.ai.contextTokens,
            async run() {
              throw new OperationError("ai_disabled", "pi 尚未启用。");
            },
            async summarize() {
              throw new OperationError("ai_disabled", "pi 尚未启用。");
            },
          });
    this.sessions = new SessionService(this.store, this.engine, {
      memory: this.config.memory,
      tools: (actor) => applicationTools(this, actor),
    });
    this.outbox = new Outbox(this.store, () => this.platform);
    this.approvals = new Approvals(this.store, this.herdr, () => this.platform, this.config.ui);
    this.directoryTrust = new DirectoryTrust(
      this.store,
      this.herdr,
      this.engine,
      this.logger,
      this.signal,
    );
    this.tasks = this.taskService();
    this.legacy = new LegacyBridge(this);
    this.inbox = new Inbox(this.store, (record) => this.process(record), this.logger);
  }

  attachPlatform(platform: PlatformPort): void {
    this.platform = platform;
    this.tasks = this.taskService();
  }

  handlers(): PlatformHandlers {
    return {
      message: async (message) => {
        if (!this.allowed(message.ownerId)) return;
        if (isLegacyReplay(this.store, { ...message, kind: "message" })) return;
        const task = this.tasks.records.byChat(message.chatId);
        if (
          (task && task.ownerId !== message.ownerId) ||
          (!task && message.chatType === "group" && !message.mentionedBot)
        )
          return;
        const actor = messageActor(this, message);
        this.inbox.enqueue("message", message.messageId || message.eventId, message, {
          actor,
          generation: this.sessions.get(actor.ownerId, actor.sessionId).generation,
        });
        this.changed();
      },
      action: async (action) => {
        if (!this.allowed(action.ownerId)) return;
        if (
          isLegacyReplay(this.store, {
            ...action,
            kind: "action",
            nonce: String(action.value.nonce ?? ""),
          })
        )
          return;
        const task = this.tasks.records.byChat(action.chatId);
        if (task && task.ownerId !== action.ownerId) return;
        this.inbox.enqueue("action", action.eventId, action);
      },
      taskChanged: async (id) => {
        this.inbox.enqueue("task", `${id}:${Date.now()}`, { id });
      },
    };
  }

  snapshot(): Record<string, unknown> {
    return snapshot(this);
  }
  dispatch(action: string, input: Record<string, unknown>): Promise<unknown> {
    if (this.signal.aborted)
      return Promise.reject(new OperationError("stopping", "服务正在停止。"));
    return this.track(dispatch(this, action, input));
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  changed(): void {
    for (const listener of this.listeners) listener();
  }

  async tick(): Promise<void> {
    if (this.signal.aborted) return;
    await this.track(
      Promise.allSettled([
        this.inbox.drain(),
        this.config.tasks.enabled ? this.tasks.tick() : this.legacy.tick(),
      ]),
    );
  }

  async shutdown(): Promise<void> {
    this.control.abort();
    this.tasks.stop();
    const draining = this.inbox.shutdown();
    await this.sessions.cancelAll();
    await draining;
    await Promise.allSettled([...this.active]);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.active.add(promise);
    void promise.finally(() => this.active.delete(promise)).catch(() => {});
    return promise;
  }

  private allowed(owner: string): boolean {
    return this.config.feishu.allowedOpenIds.includes(owner);
  }

  private async process(record: InboxRecord): Promise<void> {
    if (record.type === "message") {
      const message = record.payload as IncomingMessage;
      try {
        if (
          record.actor &&
          record.generation !==
            this.sessions.get(record.actor.ownerId, record.actor.sessionId).generation
        ) {
          throw new OperationError(
            "session_cleared",
            "排队消息所属的 pi 上下文已重置，未执行旧请求。",
          );
        }
        await handleMessage(this, this.legacy, message, record.actor);
      } catch (error) {
        // Deterministic controls need explicit feedback. Model failures remain status/errors,
        // and never become substitute business responses or terminal input.
        if (!this.config.ai.enabled) {
          await this.outbox.send(
            message.chatId,
            safeError(error).message,
            `${record.id}:error`,
            message.messageId,
          );
        }
        throw error;
      }
    } else if (record.type === "action") {
      const action = record.payload as CardAction;
      if (action.value.action === "approval") {
        await this.approvals.answer(
          action.ownerId,
          action.chatId,
          String(action.value.nonce),
          String(action.value.key),
        );
      } else if (action.value.action === "select" && !this.config.tasks.enabled) {
        await this.legacy.select(action.ownerId, action.chatId, String(action.value.paneId));
      } else throw new OperationError("unknown_action", "卡片操作已失效，请刷新现场。");
    } else {
      const remote = record.payload as { id: string };
      const task = this.store.list<Task>("tasks").find((entry) => entry.remoteTaskId === remote.id);
      if (task) await this.tasks.reconcile(task.id);
    }
    this.changed();
  }

  private taskService(): TaskService {
    return new TaskService({
      config: this.config,
      store: this.store,
      catalog: this.projects,
      herdr: this.herdr,
      platform: this.platform,
      hooks: {
        changed: () => this.changed(),
        output: (task, participant, entry) => this.output(task, participant, entry),
        notice: (task, kind) => this.notice(task, kind),
        blocked: async (task, participant) => {
          if (!participant.execution) return;
          let screen = await this.herdr.screen(participant.execution);
          if (
            this.config.ai.enabled &&
            (await this.directoryTrust.handle(
              task,
              participant,
              screen,
              this.actor(task, `startup:${participant.id}:${screen.agent.stateSeq}`),
            ))
          ) {
            this.changed();
            return;
          }
          // Re-read after model evaluation: a user may have answered meanwhile.
          screen = await this.herdr.screen(participant.execution);
          if (screen.agent.status !== "blocked") return;
          if (task.chatId && !task.groupDeleted && participant.execution && this.platform) {
            await this.approvals.publish(task.ownerId, task.chatId, participant.execution, screen);
          }
          this.changed();
        },
      },
    });
  }

  private actor(task: Task, messageId: string): ActorContext {
    const session = this.sessions.forTask(task.ownerId, task.id);
    return {
      source: task.chatId ? "system" : "web",
      ownerId: task.ownerId,
      chatId: task.chatId ?? `web:${task.ownerId}`,
      sessionId: session.id,
      taskId: task.id,
      messageId,
    };
  }

  private async output(
    task: Task,
    participant: Participant,
    entry: TranscriptEntry,
  ): Promise<void> {
    const text = `${participant.name} (${participant.kind})：\n${entry.text}`;
    const outputId = `output:${task.id}:${participant.id}:${entry.id}`;
    const actor = this.actor(task, outputId);
    const delivered = !!task.chatId && !task.groupDeleted;
    if (delivered) await this.outbox.send(task.chatId as string, text, outputId);
    this.sessions.recordExternal(actor, {
      id: outputId,
      text,
      participantId: participant.id,
      source: "herdr",
      pendingDelivery: !delivered,
      deliveredAt: delivered ? new Date().toISOString() : undefined,
    });
    this.changed();
  }

  private async notice(
    task: Task,
    kind: "welcome" | "group_ready" | "progress" | "before_close",
  ): Promise<void> {
    const signature = stableId(
      task.id,
      kind,
      task.status,
      task.error ?? "",
      task.closeRequested ? "close" : "",
    );
    if (this.store.get("notices_done", signature)) return;
    if (
      kind === "progress" &&
      progressCooling(this.store, task.id, this.config.ui.notifyCooldownMs)
    )
      return;
    const chatId = kind === "group_ready" ? task.entryChatId : task.chatId;
    const actor = this.actor(task, `notice:${signature}`);
    let decision = this.store.get<{ notify: boolean; text: string }>("notice_decisions", signature);
    if (!decision) {
      if (this.config.ai.enabled) {
        try {
          const answer = await this.engine.run({
            actor,
            sessionId: `notice:${signature}`,
            messages: [],
            systemPrompt: NOTIFICATION_PROMPT,
            prompt: JSON.stringify({
              event: kind,
              task,
              participants: this.tasks.records.participants(task),
            }),
            tools: applicationTools(this, actor).filter((tool) => tool.readOnly),
            signal: this.signal,
          });
          const parsed = JSON.parse(answer.text) as { notify?: unknown; text?: unknown };
          if (typeof parsed.notify !== "boolean" || typeof parsed.text !== "string")
            throw new Error("invalid decision");
          decision = { notify: parsed.notify, text: parsed.text };
        } catch (error) {
          this.logger.warn("生命周期通知决策未完成", { code: safeError(error).code });
          if (kind === "before_close") throw error;
          return;
        }
      } else decision = { notify: true, text: this.noticeText(task, kind) };
      this.store.set("notice_decisions", signature, decision);
    }
    if (decision.notify && decision.text) {
      const delivered = !!chatId && !chatId.startsWith("web:") && !task.groupDeleted;
      if (delivered) await this.outbox.send(chatId as string, decision.text, `notice:${signature}`);
      this.sessions.recordExternal(actor, {
        id: `notice-visible:${signature}`,
        text: decision.text,
        source: "lifecycle",
        pendingDelivery: !delivered,
        deliveredAt: delivered ? new Date().toISOString() : undefined,
      });
      if (kind === "progress") recordProgressNotice(this.store, task.id);
    }
    this.store.set("notices_done", signature, { notified: decision.notify });
    this.changed();
  }

  private noticeText(task: Task, kind: string): string {
    const link = task.chatId
      ? `\nhttps://applink.feishu.cn/client/chat/open?openChatId=${task.chatId}`
      : "";
    if (kind === "group_ready") return `${task.title} 的任务群已就绪。${link}`;
    if (kind === "welcome") return `任务：${task.title}\n可以在本群继续讨论、查询进展和处理审批。`;
    if (kind === "before_close")
      return `正在关闭执行资源。${task.keepGroup ? "本群和讨论历史保留。" : "本群将解散，代码和任务结果保留。"}`;
    return `${task.title}：${task.status}${task.error ? `\n${task.error}` : ""}`;
  }
}
