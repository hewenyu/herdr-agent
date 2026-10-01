import type { AppConfig } from "../config/types.js";
import { OperationError, safeError } from "../core/errors.js";
import { newId, stableId } from "../core/ids.js";
import type { HerdrPort, Logger, PlatformHandlers, PlatformPort } from "../core/ports.js";
import type {
  ActorContext,
  AgentScreen,
  CardAction,
  IncomingMessage,
  Participant,
  StoredMessage,
  Task,
  TranscriptEntry,
} from "../core/types.js";
import { isLegacyReplay } from "../migration/index.js";
import { ingressRouteFor } from "../orchestration/ingress.js";
import { reportCard } from "../orchestration/report.js";
import { ReportDeliveries, reportSummaryText } from "../orchestration/report-delivery.js";
import { reportInputsChanged, revisionHash } from "../orchestration/revision.js";
import { visibleOutput } from "../orchestration/status-block.js";
import { WORKFLOWS, type WorkflowState } from "../orchestration/workflow.js";
import { workspaceRevision } from "../orchestration/workspace.js";
import { ProjectCatalog } from "../projects/catalog.js";
import { type ConversationEngine, PiEngine, SessionService } from "../runtime/index.js";
import { NOTIFICATION_PROMPT } from "../runtime/prompts.js";
import { transientTurnFailure } from "../runtime/recovery.js";
import { Operations } from "../storage/operations.js";
import type { Store } from "../storage/store.js";
import type { NoticeUnavailable } from "../tasks/context.js";
import { executorHeld } from "../tasks/pause.js";
import { reconcileReadiness, startupTrustStatus } from "../tasks/readiness.js";
import { TaskService } from "../tasks/service.js";
import type { WebReportReceipt } from "../web/contracts.js";
import { dispatch, snapshot } from "./actions.js";
import { approvalIngress } from "./approval-priority.js";
import { APPROVAL_OPTIONS_VERSION, Approvals } from "./approvals.js";
import { AutomaticApprovals } from "./automatic-approvals.js";
import type { ApplicationContext } from "./context.js";
import { DirectoryTrust } from "./directory-trust.js";
import { canDeleteTaskGroup } from "./group-delivery.js";
import { historySnapshot } from "./history.js";
import { Inbox, type InboxRecord } from "./inbox.js";
import { LegacyBridge } from "./legacy.js";
import { createLogger } from "./logger.js";
import { handleMessage, messageActor } from "./messages.js";
import { noticeDecision } from "./notice-decision.js";
import { notificationParticipants, notificationTask } from "./notifications.js";
import { Outbox } from "./outbox.js";
import { progressCooling, recordProgressNotice } from "./presentation.js";
import { type OrchestrationEvent, TaskOrchestrator } from "./task-orchestrator.js";
import { applicationTools } from "./tools.js";
import { UncertainResolver } from "./uncertain-resolver.js";
import { currentWorkflowNotice, quietWorkflow } from "./workflow-notifications.js";
import { compactReportCard } from "./workflow-report.js";

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
  private readonly reportDeliveries: ReportDeliveries;
  readonly logger: Logger;
  readonly inbox: Inbox;
  readonly legacy: LegacyBridge;
  private readonly taskOrchestrator: TaskOrchestrator;
  private readonly control = new AbortController();
  readonly signal = this.control.signal;
  private readonly engine: ConversationEngine;
  private readonly directoryTrust: DirectoryTrust;
  private readonly automaticApprovals: AutomaticApprovals;
  private readonly uncertainResolver: UncertainResolver;
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
    this.reportDeliveries = new ReportDeliveries(
      this.store,
      this.outbox,
      () => this.platform,
      (event, record) => {
        const task = this.store.get<Task>("tasks", event.taskId);
        const state = this.store.get<WorkflowState>(WORKFLOWS, event.taskId);
        return (
          task?.id === event.taskId &&
          task.orchestration?.mode === "workflow" &&
          state?.taskId === task.id &&
          (reportInputsChanged(
            record.revisionEvidence,
            event.userRevision,
            this.taskOrchestrator.notificationInputs(task),
          ) ||
            (!!state.report && state.report.id !== event.decision?.reportId))
        );
      },
      (event) => {
        const task = this.store.get<Task>("tasks", event.taskId);
        if (!task || task.orchestration?.mode !== "workflow") return;
        const inputs = this.taskOrchestrator.notificationInputs(task);
        if (revisionHash(inputs) !== event.userRevision) return;
        return { version: 1, revision: event.userRevision, inputs };
      },
    );
    this.approvals = new Approvals(this.store, this.herdr, () => this.platform, this.config.ui);
    this.directoryTrust = new DirectoryTrust(
      this.store,
      this.herdr,
      this.engine,
      this.logger,
      this.signal,
    );
    this.automaticApprovals = new AutomaticApprovals({
      store: this.store,
      herdr: this.herdr,
      approvals: this.approvals,
      engine: this.engine,
      logger: this.logger,
      signal: this.signal,
      config: () => this.automaticApprovalConfig(),
    });
    this.tasks = this.taskService();
    this.uncertainResolver = new UncertainResolver({
      store: this.store,
      engine: this.engine,
      logger: this.logger,
      platform: () => this.platform,
      actor: (task, messageId) => this.actor(task, messageId),
      context: () => ({
        config: this.config,
        store: this.store,
        herdr: this.herdr,
        platform: this.platform,
        catalog: this.projects,
        records: this.tasks.records,
        operations: new Operations(this.store),
        hooks: {},
        logger: this.logger,
        signal: AbortSignal.any([this.signal, this.tasks.signal]),
      }),
    });
    this.taskOrchestrator = new TaskOrchestrator({
      config: this.config,
      projects: this.projects,
      store: this.store,
      engine: this.engine,
      tasks: () => this.tasks,
      tools: (actor) => applicationTools(this, actor),
      signal: this.signal,
      logger: this.logger,
      onReply: (task, text, eventId) => this.orchestrationReply(task, text, eventId),
      replyConfirmed: async (task, eventId) => {
        const decision = this.store.get<OrchestrationEvent>(
          "task_orchestration_events",
          eventId,
        )?.decision;
        if (
          task.orchestration?.mode === "workflow" &&
          decision?.action === "deliver" &&
          decision.reportId
        )
          return (
            this.store.get<WorkflowState>(WORKFLOWS, task.id)?.report?.id === decision.reportId &&
            this.reportDeliveries.confirmed(task.id, eventId, decision.reportId)
          );
        return (
          decision?.action === "deliver" &&
          !!decision.participantId &&
          !!decision.outputId &&
          this.outbox.receipt(`output:${task.id}:${decision.participantId}:${decision.outputId}`)
            ?.state === "delivered"
        );
      },
      replyRetryable: async (task, eventId) => {
        const decision = this.store.get<OrchestrationEvent>(
          "task_orchestration_events",
          eventId,
        )?.decision;
        return task.orchestration?.mode === "workflow" &&
          decision?.action === "deliver" &&
          decision.reportId
          ? this.reportDeliveries.retryable(task.id, eventId, decision.reportId)
          : this.canResumeOutbox(this.orchestrationReplyId(task, eventId));
      },
    });
    this.legacy = new LegacyBridge(this);
    this.inbox = new Inbox(this.store, (record) => this.process(record), this.logger, 8, {
      canRetry: (record, error) => this.canRetryMessage(record, error),
      exhausted: (record) => this.interruptedMessage(record),
      exhaustedRetryable: (record) => this.canResumeOutbox(`${record.id}:interrupted`),
    });
  }

  attachPlatform(platform: PlatformPort): void {
    // A reconnect must retire the previous task scheduler before replacing its
    // platform. Otherwise its in-flight/queued work can continue against the
    // stopped connection while the new scheduler reconciles the same records.
    this.tasks.stop();
    this.platform = platform;
    this.tasks = this.taskService();
  }

  handlers(): PlatformHandlers {
    return {
      message: async (message) => {
        if (!this.allowed(message.ownerId)) return;
        if (isLegacyReplay(this.store, { ...message, kind: "message" })) return;
        // A dissolved task group remains bound to its historical task for
        // reads, but its late messages must never fall through to the main pi
        // session (which would make an old group look like a new private chat).
        const historical = this.tasks.records.historyByChat(message.chatId);
        if (historical?.groupDeleted) return;
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
        // Approval/task cards from a dissolved group are stale. Ignore the
        // callback before it can consume a nonce or reach another session.
        if (this.tasks.records.historyByChat(action.chatId)?.groupDeleted) return;
        const task = this.tasks.records.byChat(action.chatId);
        if (task && task.ownerId !== action.ownerId) return;
        this.inbox.enqueue("action", action.eventId, action);
      },
      taskChanged: async (id) => {
        this.inbox.enqueue("task", `${id}:${Date.now()}`, { id });
      },
      groupChanged: async (id) => {
        this.inbox.enqueue("group", id, { id });
      },
    };
  }

  snapshot(): Record<string, unknown> {
    return snapshot(this);
  }
  history(ownerId?: string) {
    return historySnapshot(this, ownerId);
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

  reportDownload(ownerId: string, messageId: string): { name: string; content: string } {
    const message = this.store.get<import("../core/types.js").StoredMessage>("messages", messageId);
    if (!message?.taskId || message.source !== "workflow_report_summary")
      throw new OperationError("report_missing", "报告消息不存在。");
    this.tasks.get(
      { source: "web", ownerId, chatId: `web:${ownerId}`, sessionId: message.sessionId, messageId },
      message.taskId,
    );
    this.sessions.get(ownerId, message.sessionId);
    return this.reportDeliveries.download(message.taskId, message.deliveryIds[0] ?? messageId);
  }

  acknowledgeReport(receipt: WebReportReceipt): void {
    const { ownerId, sessionId, taskId, messageId } = receipt;
    const task = this.tasks.get(
      { source: "web", ownerId, chatId: `web:${ownerId}`, taskId, sessionId, messageId },
      taskId,
    );
    const session = this.sessions.get(ownerId, sessionId);
    const message = this.store.get<StoredMessage>("messages", messageId);
    if (
      session.taskId !== task.id ||
      !message ||
      message.sessionId !== session.id ||
      message.taskId !== task.id ||
      message.role === "user" ||
      !this.reportDeliveries.acceptsWebAcknowledgement(task.id, message)
    )
      throw new OperationError("receipt_scope", "回执不属于当前身份、任务及会话的网页报告。");
    if (message.delivery === "delivered" && message.deliveryIds[0] === message.id) return;
    if (message.delivery !== "prepared" || message.deliveryIds.length)
      throw new OperationError("receipt_scope", "仅可确认尚未送达的网页报告消息。");
    this.store.transaction(() => {
      if (!this.sessions.beginDelivery(ownerId, messageId))
        throw new OperationError("receipt_scope", "网页报告消息已失效，请刷新后核对。");
      this.sessions.recordDelivery(ownerId, messageId, { complete: true, ids: [messageId] });
    });
    this.changed();
  }

  async tick(): Promise<void> {
    if (this.signal.aborted) return;
    // Keep independent task reconciliation running while a model-backed inbox
    // turn is pending. After the drain commits its records, run one more
    // scheduling pass so a task_create in this turn is provisioned immediately.
    // Each tick must run inbox admission even when an earlier tick is waiting
    // on a slow lane. Inbox.drain() deduplicates active lanes itself, while a
    // fresh call can admit messages that arrived after the previous snapshot.
    const orchestration =
      this.config.ai.enabled && this.config.tasks.enabled
        ? this.track(this.taskOrchestrator.tick())
        : Promise.resolve();
    const uncertain =
      this.config.ai.enabled && this.config.tasks.enabled
        ? this.track(this.uncertainResolver.tick(this.store.list<Task>("tasks")))
        : Promise.resolve();
    const inbox = this.track(this.inbox.drain());
    const scheduler = this.track(
      this.config.tasks.enabled ? this.tasks.tick() : this.legacy.tick(),
    );
    await inbox;
    await uncertain;
    if (this.config.tasks.enabled) {
      const followUp = this.track(this.tasks.tick());
      await Promise.allSettled([scheduler, followUp]);
    } else await scheduler;
    await orchestration;
    if (this.config.ai.enabled && this.config.tasks.enabled && !this.signal.aborted)
      await this.track(this.taskOrchestrator.tick());
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

  private canRetryMessage(record: InboxRecord, error?: ReturnType<typeof safeError>): boolean {
    if (record.type !== "message" || !record.actor) return false;
    const actor = record.actor;
    if (!this.allowed(actor.ownerId)) return false;
    try {
      if (this.sessions.get(actor.ownerId, actor.sessionId).generation !== record.generation)
        return false;
      const route = ingressRouteFor(this.store, actor);
      if (route && route.route !== "pi") {
        if (!this.sessions.canRecover(actor)) return false;
        if (route.replyId) return this.canResumeOutbox(route.replyId);
        return !error || transientTurnFailure(error.code);
      }
      const reply = this.sessions.recoveryReply(actor);
      if (reply) {
        const delivery = this.outbox.receipt(reply.id);
        return (
          (!delivery || ["prepared", "retryable", "delivered"].includes(delivery.state)) &&
          this.sessions.canRecover(actor)
        );
      }
      return (!error || transientTurnFailure(error.code)) && this.sessions.canRecover(actor);
    } catch {
      return false;
    }
  }

  private async interruptedMessage(record: InboxRecord): Promise<void> {
    if (record.type !== "message" || !this.config.ai.enabled || this.signal.aborted) return;
    if (["session_cleared", "invalid_scope", "cancelled"].includes(record.error?.code ?? ""))
      return;
    const message = record.payload as IncomingMessage;
    if (!this.allowed(message.ownerId)) return;
    if (
      record.actor &&
      this.sessions.get(record.actor.ownerId, record.actor.sessionId).generation !==
        record.generation
    )
      return;
    if (this.tasks.records.historyByChat(message.chatId)?.groupDeleted) return;
    await this.outbox.send(
      message.chatId,
      "本次请求的处理已中断，自动恢复未能完成。已经登记的任务和操作会保留；结果尚未确认的操作不会重复执行。请查询当前任务进度后继续。",
      `${record.id}:interrupted`,
      message.messageId,
    );
  }

  private canResumeOutbox(id: string): boolean {
    const receipt = this.outbox.receipt(id);
    // Only re-enter the original callback: Outbox.send validates the same
    // envelope, resumes unsent parts and never resends delivered parts.
    return !receipt || ["prepared", "retryable", "delivered"].includes(receipt.state);
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
      // A card can be accepted just before an external group-dissolved event
      // is processed. Recheck the durable binding at execution time as well as
      // ingress time so that race cannot consume a stale approval nonce.
      if (this.tasks.records.historyByChat(action.chatId)?.groupDeleted) return;
      if (action.value.action === "approval") {
        await this.approvals.answer(
          action.ownerId,
          action.chatId,
          String(action.value.nonce),
          String(action.value.key),
        );
      } else if (action.value.action === "uncertain") {
        await this.uncertainResolver.cards.answer(
          action.ownerId,
          action.chatId,
          String(action.value.nonce),
          String(action.value.choice),
        );
      } else if (action.value.action === "select" && !this.config.tasks.enabled) {
        await this.legacy.select(action.ownerId, action.chatId, String(action.value.paneId));
      } else throw new OperationError("unknown_action", "卡片操作已失效，请刷新现场。");
    } else {
      const remote = record.payload as { id: string };
      const task = this.store
        .list<Task>("tasks")
        .find((entry) =>
          record.type === "group" ? entry.chatId === remote.id : entry.remoteTaskId === remote.id,
        );
      if (task) await this.tasks.reconcile(task.id);
    }
    this.changed();
  }

  private automaticApprovalConfig() {
    return this.config.ai.enabled &&
      this.config.jev?.apiKey &&
      this.config.jev.approvalsEnabled !== false
      ? this.config.jev
      : undefined;
  }

  /** True only when a same-execution startup-trust effect is unresolved. */
  private startupTrustFrozen(participant: Participant): boolean {
    return startupTrustStatus(this.store, participant).frozen;
  }

  /**
   * A user control queued behind the model call, or an owner whose authorization
   * was revoked, must veto the in-flight native trust write. This is a veto of
   * the attempt, not a disable: a later authorized observation may still run the
   * restricted startup route.
   */
  private startupTrustVeto(task: Task): string | undefined {
    if (!this.config.feishu.allowedOpenIds.includes(task.ownerId))
      return "任务所有者授权已失效，未确认启动目录信任。";
    if (this.tasks.approvalsBlocked(task.id)) return "已有待处理的用户控制，未确认启动目录信任。";
    return undefined;
  }

  /**
   * Run the restricted startup directory-trust route independently of Jev and of
   * the business pause. Returns true only when the exact authorized folder gate
   * was confirmed (or already confirmed for this generation).
   */
  private async startupTrust(
    task: Task,
    participant: Participant,
    screen: AgentScreen,
    frozen: boolean,
  ): Promise<boolean> {
    if (frozen || executorHeld(this.store, participant.id)) return false;
    if (!this.config.ai.enabled) return false;
    const ref = participant.execution;
    if (!ref) return false;
    // The restricted route is handed every blocked observation, but its guarded
    // tool only writes after re-checking the exact native folder menu, the real
    // directory authorization, the execution identity and the generation.
    const confirmed = await this.directoryTrust.handle(
      task,
      participant,
      screen,
      this.actor(task, `startup:${participant.id}:${screen.agent.stateSeq}`),
      () => this.startupTrustVeto(task),
    );
    if (!confirmed) return false;
    await this.approvals.invalidate(ref, "pi 已确认目录信任，此旧卡片已失效。");
    this.changed();
    return true;
  }

  private taskService(): TaskService {
    const service = new TaskService({
      config: this.config,
      logger: this.logger,
      store: this.store,
      catalog: this.projects,
      herdr: this.herdr,
      platform: this.platform,
      hooks: {
        blockedVersion: APPROVAL_OPTIONS_VERSION,
        recheckBlocked: () => Boolean(this.automaticApprovalConfig()),
        changed: () => this.changed(),
        output: (task, participant, entry) => this.output(task, participant, entry),
        outputConfirmed: (task, participant, entry) =>
          this.outbox.receipt(`output:${task.id}:${participant.id}:${entry.id}`)?.state ===
          "delivered",
        outputRetryable: (task, participant, entry) =>
          this.canResumeOutbox(`output:${task.id}:${participant.id}:${entry.id}`),
        notice: (task, kind) => this.notice(task, kind),
        canDeleteGroup: (task) =>
          canDeleteTaskGroup(this.store, task) &&
          (!task.chatId || !this.reportDeliveries.pendingInChat(task.chatId)),
        blocked: async (task, participant) => {
          if (!participant.execution) return;
          // Same-execution startup-trust uncertainty freezes BOTH the restricted
          // route and the generic approval route; a definitely new generation
          // starts clean and is handled by startupTrust below.
          const frozen = this.startupTrustFrozen(participant);
          let screen = await this.herdr.screen(participant.execution);
          reconcileReadiness(
            this.store,
            service.records,
            task,
            participant,
            { kind: "snapshot", agent: screen.agent },
            { screenText: screen.text },
          );
          // Startup directory trust is lifecycle work, independent of Jev and
          // of a settled business pause. Recognize the exact authorized folder
          // gate first; only then may the generic approval route run. Startup
          // metadata can advance while pi reasons, so re-observe at most once
          // before concluding; a key whose effect is unknown is never replayed.
          for (let attempt = 0; !frozen && attempt < 2; attempt++) {
            const observedSeq = screen.agent.stateSeq;
            if (await this.startupTrust(task, participant, screen, frozen)) return;
            screen = await this.herdr.screen(participant.execution);
            if (screen.agent.status !== "blocked") return;
            if (screen.agent.stateSeq === observedSeq) break;
            if (attempt === 1) return;
          }
          if (screen.agent.status !== "blocked") return;
          if (frozen) return;
          if (this.automaticApprovalConfig()) {
            const result = await this.automaticApprovals.handle(
              task,
              participant,
              screen,
              this.actor(task, `approval:${participant.id}:${screen.agent.stateSeq}`),
              {
                signal: service.signal,
                allowed: () =>
                  !service.approvalsBlocked(task.id) &&
                  this.config.feishu.allowedOpenIds.includes(task.ownerId),
              },
            );
            if (result !== "manual") {
              this.changed();
              return;
            }
          }
          // Re-read after model evaluation: a user may have answered meanwhile.
          if (service.approvalsBlocked(task.id) || approvalIngress(this.store, task).pending)
            return;
          screen = await this.herdr.screen(participant.execution);
          if (screen.agent.status !== "blocked") return;
          if (task.chatId && !task.groupDeleted && participant.execution && this.platform) {
            await this.approvals.publish(task.ownerId, task.chatId, participant.execution, screen);
          }
          this.changed();
        },
      },
    });
    return service;
  }

  private actor(task: Task, messageId: string): ActorContext {
    const session = this.sessions.forTask(task.ownerId, task.id);
    const chatId = this.outputChat(task);
    return {
      source: chatId && !chatId.startsWith("web:") ? "system" : "web",
      ownerId: task.ownerId,
      chatId: chatId ?? `web:${task.ownerId}`,
      sessionId: session.id,
      taskId: task.id,
      messageId,
    };
  }

  private outputChat(task: Task): string | undefined {
    return task.groupDeleted ? task.entryChatId : (task.chatId ?? task.entryChatId);
  }

  private orchestrationReplyId(task: Task, eventId: string): string {
    const event = this.store.get<OrchestrationEvent>("task_orchestration_events", eventId);
    const final = event?.decision?.action === "deliver" ? event.decision : undefined;
    if (task.orchestration?.mode === "workflow" && final?.reportId)
      return `workflow-report:${task.id}:${eventId}:${final.reportId}:body`;
    // A selected final is the same native message, not a new send authorization.
    // Reuse its original envelope so a missing ACK cannot be bypassed by a new ID.
    return final?.participantId && final.outputId
      ? `output:${task.id}:${final.participantId}:${final.outputId}`
      : `orchestration:${task.id}:${eventId}`;
  }

  private async orchestrationReply(task: Task, text: string, eventId: string): Promise<void> {
    const chatId = this.outputChat(task);
    const event = this.store.get<OrchestrationEvent>("task_orchestration_events", eventId);
    const final = event?.decision?.action === "deliver" ? event.decision : undefined;
    const outputId = this.orchestrationReplyId(task, eventId);
    const delivered = !!chatId && !chatId.startsWith("web:");
    if (task.orchestration?.mode === "workflow" && final?.reportId) {
      const state = this.store.get<WorkflowState>(WORKFLOWS, task.id);
      if (!state?.report || state.report.id !== final.reportId)
        throw new OperationError("workflow_report", "交付报告引用已失效。");
      const envelope = {
        taskId: task.id,
        eventId,
        reportId: state.report.id,
        reportHash: state.report.hash,
        chatId: chatId ?? `web:${task.ownerId}`,
        text,
        card: quietWorkflow(task)
          ? compactReportCard(task, state, delivered)
          : reportCard(task, state),
        ...(quietWorkflow(task) ? { presentation: "attachment" as const } : {}),
        channel: delivered ? ("platform" as const) : ("web" as const),
      };
      const report = state.report;
      const beforeSend =
        task.promptVersion === 3
          ? async () => {
              const current = () => {
                const selected = this.store.get<OrchestrationEvent>(
                  "task_orchestration_events",
                  eventId,
                );
                const currentState = this.store.get<WorkflowState>(WORKFLOWS, task.id);
                if (
                  !selected ||
                  selected.state === "superseded" ||
                  selected.taskId !== task.id ||
                  selected.userRevision !== event?.userRevision ||
                  selected.decision?.action !== "deliver" ||
                  selected.decision.reportId !== report.id ||
                  currentState?.report?.id !== report.id ||
                  currentState.report.hash !== report.hash ||
                  currentState.report.deliveryRevision !== report.deliveryRevision
                )
                  throw new OperationError("workflow_report", "发送前报告引用已失效。");
                const currentTask = this.taskOrchestrator.assertNotificationCurrent(selected);
                if (
                  currentTask.ownerId !== task.ownerId ||
                  currentTask.kind !== task.kind ||
                  currentTask.promptVersion !== task.promptVersion ||
                  currentTask.orchestration?.mode !== "workflow" ||
                  currentTask.pending ||
                  currentTask.directoryMode !== task.directoryMode ||
                  currentTask.worktreeReady !== task.worktreeReady ||
                  JSON.stringify(currentTask.directories) !== JSON.stringify(task.directories) ||
                  (currentTask.directoryMode === "worktree" && !currentTask.worktreeReady) ||
                  (this.outputChat(currentTask) ?? `web:${currentTask.ownerId}`) !== envelope.chatId
                )
                  throw new OperationError("workflow_report", "发送前任务或工作目录已变化。");
                return { task: currentTask, state: currentState };
              };
              const snapshot = current();
              const assertArtifact = async () => {
                if (
                  (await workspaceRevision(snapshot.task.directories)) !== report.artifactRevision
                )
                  throw new OperationError("workflow_report", "发送前报告对应的文件版本已变化。");
              };
              await assertArtifact();
              current();
              await this.taskOrchestrator.assertNotificationDelivery(snapshot.task, snapshot.state);
              await assertArtifact();
              current();
            }
          : undefined;
      if (!delivered) await beforeSend?.();
      const receipt = delivered
        ? await this.reportDeliveries.send(envelope, beforeSend)
        : this.reportDeliveries.prepare(envelope);
      const actor = this.actor(task, receipt.bodyId);
      const body =
        receipt.presentation === "attachment"
          ? undefined
          : this.sessions.recordExternal(actor, {
              id: receipt.bodyId,
              text: receipt.text,
              source: "workflow_report",
              pendingDelivery: !delivered,
            });
      const summary = this.sessions.recordExternal(actor, {
        id: receipt.cardId,
        text: reportSummaryText(receipt.card),
        source: "workflow_report_summary",
        pendingDelivery: !delivered,
      });
      if (!delivered) this.reportDeliveries.bindWeb(receipt, body?.id, summary.id);
      this.changed();
      if (!(await this.reportDeliveries.confirmed(task.id, eventId, final.reportId)))
        throw new OperationError("report_delivery_pending", "报告及摘要已准备，等待页面确认展示。");
      return;
    }
    if (delivered) await this.outbox.send(chatId, text, outputId);
    if (final) {
      this.changed();
      return;
    }
    this.sessions.recordExternal(this.actor(task, outputId), {
      id: outputId,
      text,
      source: "orchestration",
      pendingDelivery: !delivered,
      deliveredAt: delivered ? new Date().toISOString() : undefined,
    });
    this.changed();
  }

  private async output(
    task: Task,
    participant: Participant,
    entry: TranscriptEntry,
  ): Promise<void> {
    if (quietWorkflow(task)) {
      this.store.set("workflow_outputs", `${task.id}:${participant.id}:${entry.id}`, {
        taskId: task.id,
        participantId: participant.id,
        sessionId: participant.execution?.sessionId,
        entry,
        recordedAt: new Date().toISOString(),
      });
      this.changed();
      return;
    }
    const content =
      task.orchestration?.mode === "workflow" ? visibleOutput(entry.text) : entry.text;
    const text = `${participant.name} (${participant.kind})：\n${content}`;
    const outputId = `output:${task.id}:${participant.id}:${entry.id}`;
    const actor = this.actor(task, outputId);
    const chatId = this.outputChat(task);
    const delivered = !!chatId && !chatId.startsWith("web:");
    const legacyDelivery = delivered
      ? this.outbox.legacyDeliveredToChat(chatId as string, text, outputId)
      : undefined;
    if (delivered && !legacyDelivery) await this.outbox.send(chatId as string, text, outputId);
    this.sessions.recordExternal(actor, {
      id: outputId,
      text,
      participantId: participant.id,
      source: "herdr",
      pendingDelivery: !delivered,
      deliveredAt: delivered ? (legacyDelivery?.updatedAt ?? new Date().toISOString()) : undefined,
    });
    this.changed();
  }

  private async notice(
    task: Task,
    kind: "welcome" | "group_ready" | "progress" | "before_close" | "before_group_delete",
  ): Promise<NoticeUnavailable | undefined> {
    const workflow = quietWorkflow(task)
      ? await currentWorkflowNotice(
          task,
          kind,
          this.tasks.records.projectParticipants(task),
          this.store,
        )
      : undefined;
    if (quietWorkflow(task) && !workflow) return;
    const signature =
      workflow?.evidenceFingerprint !== undefined
        ? stableId(task.id, kind, "evidence-wait", workflow.evidenceFingerprint)
        : stableId(
            task.id,
            kind,
            task.status,
            task.error ?? "",
            task.closeRequested ? "close" : "",
          );
    if (this.store.get("notices_done", signature)) return;
    if (
      kind === "progress" &&
      workflow?.evidenceFingerprint === undefined &&
      progressCooling(this.store, task.id, this.config.ui.notifyCooldownMs)
    )
      return;
    const chatId = kind === "group_ready" ? task.entryChatId : this.outputChat(task);
    const actor = this.actor(task, `notice:${signature}`);
    let decision = this.store.get<{ notify: boolean; text: string }>("notice_decisions", signature);
    if (!decision) {
      if (workflow) {
        decision = workflow;
      } else if (this.config.ai.enabled) {
        try {
          const participants = this.tasks.records.projectParticipants(task);
          const runId = newId("notice_run");
          decision = await noticeDecision(
            this.engine,
            {
              actor,
              sessionId: `notice:${signature}`,
              messages: [],
              systemPrompt: NOTIFICATION_PROMPT,
              prompt: JSON.stringify({
                event: kind,
                task: notificationTask(task),
                participants: notificationParticipants(participants),
              }),
              tools: applicationTools(this, actor).filter((tool) => tool.readOnly),
              signal: this.signal,
              // Lifecycle notices are generated from the authoritative task and
              // participant snapshot above. They may describe an already-created
              // resource without replaying a write tool; ordinary user turns keep
              // the default claim/evidence guard in SessionService/PiEngine.
              enforceClaims: false,
            },
            { task, participants },
            (rejection) => {
              this.store.set("notice_rejections", `${signature}:${runId}:${rejection.attempt}`, {
                signature,
                runId,
                taskId: task.id,
                event: kind,
                at: new Date().toISOString(),
                ...rejection,
                snapshot: {
                  task: notificationTask(task),
                  participants: notificationParticipants(participants),
                },
              });
            },
          );
          if (this.signal.aborted)
            throw new OperationError("stopping", "服务正在停止，通知未发送。");
        } catch (error) {
          if (this.signal.aborted) throw error;
          this.logger.warn("生命周期通知决策未完成", { code: safeError(error).code });
          // Only generation failed: no message send was attempted. An unavailable
          // optional notice must not veto cleanup the user already authorized.
          if (kind === "before_close" || kind === "before_group_delete")
            return {
              status: "unavailable",
              reason: "generation_failed",
              errorCode: safeError(error).code,
            };
          return;
        }
      } else decision = { notify: true, text: this.noticeText(task, kind) };
      this.store.set("notice_decisions", signature, decision);
    }
    if (decision.notify && decision.text) {
      const delivered = !!chatId && !chatId.startsWith("web:");
      const legacyDelivery = delivered
        ? this.outbox.legacyDeliveredToChat(chatId as string, decision.text, `notice:${signature}`)
        : undefined;
      if (delivered && !legacyDelivery)
        await this.outbox.send(chatId as string, decision.text, `notice:${signature}`);
      this.sessions.recordExternal(actor, {
        id: `notice-visible:${signature}`,
        text: decision.text,
        source: "lifecycle",
        pendingDelivery: !delivered,
        deliveredAt: delivered
          ? (legacyDelivery?.updatedAt ?? new Date().toISOString())
          : undefined,
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
    if (kind === "before_group_delete") return "任务已完成，即将解散本群；代码和任务历史保留。";
    return `${task.title}：${task.status}${task.error ? `\n${task.error}` : ""}`;
  }
}
