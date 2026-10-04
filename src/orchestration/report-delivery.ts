import { createHash } from "node:crypto";
import { OperationError, safeError } from "../core/errors.js";
import { canonical, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { PlatformPort } from "../core/ports.js";
import type { StoredMessage, Task } from "../core/types.js";
import { isDurableResolution, type OperationResolution } from "../storage/operations.js";
import type { Store } from "../storage/store.js";
import type { OrchestrationEvent } from "./contracts.js";
import type { ReportRevisionEvidence } from "./revision.js";
import { WORKFLOWS, type WorkflowState } from "./workflow.js";

/** The outbox receipt state this module reasons about. */
type ReportOutboxState = "prepared" | "sending" | "delivered" | "uncertain" | "retryable";

/**
 * The minimal consumer-owned view of the outbox this module needs: it only reads
 * an existing receipt and resumes or starts the frozen body send. The concrete
 * app/Outbox satisfies this structurally, so orchestration never imports app.
 */
export interface ReportOutbox {
  receipt(id: string): { state: ReportOutboxState; ids: string[] } | undefined;
  send(chatId: string, text: string, id: string, replyTo?: string): Promise<string[]>;
}

export interface ReportEnvelope {
  taskId: string;
  eventId: string;
  reportId: string;
  reportHash: string;
  chatId: string;
  text: string;
  card: Record<string, unknown>;
  channel: "platform" | "web";
  presentation?: "attachment";
}

export interface ReportDelivery extends ReportEnvelope {
  version: 1 | 2;
  fileState?:
    | "prepared"
    | "uploading"
    | "uploaded"
    | "sending"
    | "delivered"
    | "uncertain"
    | "retryable";
  fileResolution?: OperationResolution;
  fileHistory?: Array<
    Pick<
      ReportDelivery,
      "fileState" | "fileKey" | "fileMessageId" | "error" | "fileResolution" | "updatedAt"
    >
  >;
  fileKey?: string;
  fileMessageId?: string;
  fingerprint: string;
  bodyId: string;
  cardId: string;
  cardState: "prepared" | "sending" | "delivered" | "uncertain" | "retryable";
  cardMessageId?: string;
  webBodyId?: string;
  webCardId?: string;
  error?: ReturnType<typeof safeError>;
  retired?: { reason: "superseded" | "stale_report"; at: string };
  revisionEvidence?: ReportRevisionEvidence;
  updatedAt: string;
}

const namespace = "workflow_report_deliveries";
const deliveryStates = ["prepared", "sending", "delivered", "uncertain", "retryable"] as const;
const fileTransferStates = [
  "prepared",
  "uploading",
  "uploaded",
  "sending",
  "delivered",
  "uncertain",
  "retryable",
] as const;
const fileTransfers = new WeakMap<Store, Set<string>>();

/** True only while this process is inside an attachment upload/send for the event. */
export function reportFileInFlight(store: Store, eventId: string): boolean {
  return fileTransfers.get(store)?.has(eventId) ?? false;
}

/** Two independently recoverable notification components, never a dispatch authority. */
export class ReportDeliveries {
  private readonly mutex = new KeyedMutex();
  private readonly sending = new Set<string>();
  constructor(
    private readonly store: Store,
    private readonly outbox: ReportOutbox,
    private readonly platform: () => PlatformPort | undefined,
    private readonly staleReport?: (event: OrchestrationEvent, record: ReportDelivery) => boolean,
    private readonly captureRevision?: (
      event: OrchestrationEvent,
    ) => ReportRevisionEvidence | undefined,
  ) {}

  prepare(input: ReportEnvelope): ReportDelivery {
    // The frozen body is hashed below; a non-string text or hash would become a
    // raw crypto TypeError. Refuse the uninterpretable envelope instead, without
    // touching an existing durable record.
    if (
      input === null ||
      typeof input !== "object" ||
      typeof input.text !== "string" ||
      typeof input.reportHash !== "string" ||
      input.card === null ||
      typeof input.card !== "object" ||
      Array.isArray(input.card)
    )
      throw new OperationError("report_invalid", "报告正文或摘要无法解读，已拒绝投递。");
    if (createHash("sha256").update(input.text).digest("hex") !== input.reportHash)
      throw new OperationError("workflow_report", "报告正文与冻结版本不匹配。");
    const previous = this.store.get<unknown>(namespace, input.eventId);
    if (previous !== undefined) {
      // A present but uninterpretable row is not absence: it could still own a
      // live or unknown send. Refuse it typed instead of overwriting it with a
      // fresh delivery for a possibly-executed effect.
      if (
        !readableRecord(previous) ||
        !valid(previous) ||
        previous.taskId !== input.taskId ||
        previous.eventId !== input.eventId ||
        previous.reportId !== input.reportId ||
        previous.reportHash !== input.reportHash ||
        previous.text !== input.text ||
        previous.chatId !== input.chatId ||
        previous.channel !== input.channel ||
        previous.presentation !== input.presentation
      )
        throw new OperationError("report_delivery_conflict", "报告送达回执与原报告不匹配。");
      if (this.retireObsolete(previous))
        throw new OperationError("report_delivery_retired", "旧报告已终止发送，保留原传输记录。");
      return previous;
    }
    const prefix = `workflow-report:${input.taskId}:${input.eventId}:${input.reportId}`;
    const event = this.store.get<OrchestrationEvent>("task_orchestration_events", input.eventId);
    const revisionEvidence =
      event?.id === input.eventId &&
      event.taskId === input.taskId &&
      event.decision?.action === "deliver" &&
      event.decision?.reportId === input.reportId
        ? this.captureRevision?.(event)
        : undefined;
    const record: ReportDelivery = {
      ...structuredClone(input),
      version: input.presentation === "attachment" ? 2 : 1,
      ...(input.presentation === "attachment" ? { fileState: "prepared" as const } : {}),
      fingerprint: fingerprint(input),
      bodyId: `${prefix}:body`,
      cardId: `${prefix}:card`,
      cardState: "prepared",
      ...(revisionEvidence ? { revisionEvidence } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.save(record);
    return record;
  }

  async send(input: ReportEnvelope, beforeSend?: () => Promise<void>): Promise<ReportDelivery> {
    return this.mutex.run(input.eventId, async () => {
      const record = this.prepare(input);
      this.sending.add(record.eventId);
      try {
        return await this.sendPrepared(record, beforeSend);
      } finally {
        this.sending.delete(record.eventId);
      }
    });
  }

  private async sendPrepared(
    record: ReportDelivery,
    beforeSend?: () => Promise<void>,
  ): Promise<ReportDelivery> {
    if (record.channel !== "platform")
      throw new OperationError("report_channel", "网页报告需页面确认展示。");
    // Outbox freezes text and resumes only confirmed-unsent parts.
    if (record.presentation === "attachment") await this.sendAttachment(record, beforeSend);
    else {
      const bodyState = this.outbox.receipt(record.bodyId)?.state;
      if (!["delivered", "sending", "uncertain"].includes(bodyState ?? ""))
        await this.checkBeforeSend(record, beforeSend);
      await this.outbox.send(record.chatId, record.text, record.bodyId);
    }
    if (record.cardState === "delivered") return record;
    if (["sending", "uncertain"].includes(record.cardState))
      throw new OperationError(
        "delivery_uncertain",
        "报告摘要卡片送达未知，不能自动重发。",
        "unknown",
      );
    const platform = this.platform();
    if (!platform) throw new OperationError("platform_unavailable", "飞书尚未连接。");
    await this.checkBeforeSend(record, beforeSend);
    record.cardState = "sending";
    this.save(record);
    try {
      const id = await platform.sendCard(record.chatId, record.card, stableId(record.cardId));
      if (!id) throw new OperationError("delivery_uncertain", "摘要卡片缺少送达编号。", "unknown");
      record.cardMessageId = id;
      record.cardState = "delivered";
      // An inferred file target state does not erase its historical transport error.
      if (!record.fileResolution) record.error = undefined;
      this.save(record);
    } catch (error) {
      const cardError = safeError(error);
      if (!record.fileResolution) record.error = cardError;
      record.cardState = cardError.outcome === "not_executed" ? "retryable" : "uncertain";
      this.save(record);
      throw error;
    }
    return record;
  }

  bindWeb(record: ReportDelivery, bodyId: string | undefined, cardId: string): void {
    if (
      record.channel !== "web" ||
      !valid(record) ||
      (record.webBodyId && record.webBodyId !== bodyId) ||
      (record.webCardId && record.webCardId !== cardId)
    )
      throw new OperationError("report_delivery_conflict", "网页报告消息归属不匹配。");
    this.save({ ...record, webBodyId: bodyId, webCardId: cardId });
  }

  /** Only exact messages bound to a valid frozen Web envelope can acknowledge rendering. */
  acceptsWebAcknowledgement(taskId: string, message: StoredMessage): boolean {
    return this.store
      .list<ReportDelivery>(namespace)
      .some(
        (record) =>
          record.channel === "web" &&
          record.taskId === taskId &&
          message.taskId === taskId &&
          valid(record) &&
          ((record.webCardId === message.id &&
            message.source === "workflow_report_summary" &&
            message.text === reportSummaryText(record.card)) ||
            (record.presentation !== "attachment" &&
              record.webBodyId === message.id &&
              message.source === "workflow_report" &&
              message.text === record.text)),
      );
  }

  async confirmed(taskId: string, eventId: string, reportId: string): Promise<boolean> {
    const record = this.store.get<ReportDelivery>(namespace, eventId);
    if (!matches(record, taskId, eventId, reportId) || this.retireObsolete(record)) return false;
    if (record.channel === "web") {
      const body = record.webBodyId
        ? this.store.get<StoredMessage>("messages", record.webBodyId)
        : undefined;
      const card = record.webCardId
        ? this.store.get<StoredMessage>("messages", record.webCardId)
        : undefined;
      return (
        (record.presentation === "attachment" ||
          (body?.taskId === taskId &&
            body.delivery === "delivered" &&
            body.text === record.text)) &&
        card?.taskId === taskId &&
        card.delivery === "delivered" &&
        card.text === reportSummaryText(record.card)
      );
    }
    if (!this.bodyConfirmed(record) || record.cardState !== "delivered" || !record.cardMessageId)
      return false;
    try {
      // This delivered-only call validates the complete existing envelope without sending.
      if (record.presentation !== "attachment")
        await this.outbox.send(record.chatId, record.text, record.bodyId);
      return true;
    } catch {
      return false;
    }
  }

  retryable(taskId: string, eventId: string, reportId: string): boolean {
    const record = this.store.get<ReportDelivery>(namespace, eventId);
    if (!record) return true;
    if (!matches(record, taskId, eventId, reportId) || this.retireObsolete(record)) return false;
    if (record.channel === "web") return true;
    const body = this.outbox.receipt(record.bodyId);
    return (
      (record.presentation === "attachment"
        ? record.fileResolution?.choice !== "abandon" &&
          (!!record.fileResolution ||
            ["prepared", "uploaded", "retryable", "delivered"].includes(record.fileState ?? ""))
        : !body || ["prepared", "retryable", "delivered"].includes(body.state)) &&
      ["prepared", "retryable", "delivered"].includes(record.cardState)
    );
  }

  /** Frozen content only: no caller-supplied filesystem path is ever opened. */
  download(taskId: string, messageId: string): { name: string; content: string } {
    const record = this.store
      .list<ReportDelivery>(namespace)
      .find(
        (entry) =>
          entry.taskId === taskId && (entry.cardId === messageId || entry.webCardId === messageId),
      );
    if (!record || !valid(record))
      throw new OperationError("report_missing", "报告不存在或版本校验失败。");
    return { name: "report.md", content: record.text };
  }

  private bodyConfirmed(record: ReportDelivery): boolean {
    return record.presentation === "attachment"
      ? record.fileResolution?.choice === "treat_done" ||
          (record.fileState === "delivered" && !!record.fileKey && !!record.fileMessageId)
      : this.outbox.receipt(record.bodyId)?.state === "delivered";
  }

  private async sendAttachment(
    record: ReportDelivery,
    beforeSend?: () => Promise<void>,
  ): Promise<void> {
    if (record.fileResolution?.choice === "treat_done") return;
    if (record.fileResolution?.choice === "abandon")
      throw new OperationError("operation_abandoned", "报告附件已放弃，未发送。", "not_executed");
    if (record.fileResolution?.choice === "retry") {
      record.fileHistory = [
        ...(record.fileHistory ?? []),
        {
          fileState: record.fileState,
          fileKey: record.fileKey,
          fileMessageId: record.fileMessageId,
          error: record.error,
          fileResolution: record.fileResolution,
          updatedAt: record.updatedAt,
        },
      ];
      record.fileResolution = undefined;
      record.fileState = record.fileKey ? "uploaded" : "prepared";
      this.save(record); // Consume authorization before any await or platform call.
    }
    if (record.fileState === "delivered") return;
    if (["uploading", "sending", "uncertain"].includes(record.fileState ?? ""))
      throw new OperationError(
        "delivery_uncertain",
        "报告附件传输结果未知，不能自动重复上传或发送。",
        "unknown",
      );
    let settledState = record.fileState;
    let platformCalled = false;
    const transfers = fileTransfers.get(this.store) ?? new Set<string>();
    fileTransfers.set(this.store, transfers);
    transfers.add(record.eventId);
    try {
      const platform = this.platform();
      if (!platform?.uploadFile || !platform.sendFile)
        throw new OperationError("platform_unavailable", "当前平台未提供报告附件能力。");
      if (!record.fileKey) {
        await beforeSend?.();
        record.fileState = "uploading";
        this.save(record);
        platformCalled = true;
        const fileKey = await platform.uploadFile("report.md", record.text);
        if (!fileKey)
          throw new OperationError("delivery_uncertain", "报告上传缺少文件编号。", "unknown");
        record.fileKey = fileKey;
        record.fileState = "uploaded";
        settledState = "uploaded";
        platformCalled = false;
        this.save(record);
      }
      await beforeSend?.();
      record.fileState = "sending";
      this.save(record);
      platformCalled = true;
      const messageId = await platform.sendFile(
        record.chatId,
        record.fileKey,
        stableId(record.bodyId),
      );
      if (!messageId)
        throw new OperationError("delivery_uncertain", "附件发送缺少消息编号。", "unknown");
      record.fileMessageId = messageId;
      record.fileState = "delivered";
      record.error = undefined;
      this.save(record);
    } catch (error) {
      record.error = safeError(error);
      record.fileState = platformCalled
        ? record.error.outcome === "not_executed"
          ? "retryable"
          : "uncertain"
        : settledState;
      this.save(record);
      throw error;
    } finally {
      transfers.delete(record.eventId);
    }
  }

  /** Guard failures are diagnostics, not evidence of a platform side effect. */
  private async checkBeforeSend(
    record: ReportDelivery,
    beforeSend?: () => Promise<void>,
  ): Promise<void> {
    try {
      await beforeSend?.();
    } catch (error) {
      record.error = safeError(error);
      this.save(record);
      throw error;
    }
  }

  private save(record: ReportDelivery): void {
    this.store.set(namespace, record.eventId, { ...record, updatedAt: new Date().toISOString() });
  }

  /** End obsolete, known-settled sends without rewriting any transport receipt. */
  private retireObsolete(record: ReportDelivery): boolean {
    if (record.retired) return true;
    if (
      this.sending.has(record.eventId) ||
      record.channel !== "platform" ||
      !valid(record) ||
      !["prepared", "retryable", "delivered"].includes(record.cardState) ||
      (record.cardState === "delivered" && !record.cardMessageId) ||
      (this.bodyConfirmed(record) && record.cardState === "delivered")
    )
      return false;
    if (record.presentation === "attachment") {
      if (
        !["prepared", "uploaded", "retryable", "delivered"].includes(record.fileState ?? "") ||
        (record.fileState === "uploaded" && !record.fileKey) ||
        (record.fileState === "delivered" && !this.bodyConfirmed(record))
      )
        return false;
    } else {
      // A partial legacy text has its own outbox barrier and recovery authority.
      const body = this.outbox.receipt(record.bodyId);
      if (body && body.state !== "delivered") return false;
    }
    const event = this.store.get<OrchestrationEvent>("task_orchestration_events", record.eventId);
    if (
      event?.id !== record.eventId ||
      event.taskId !== record.taskId ||
      event.decision?.action !== "deliver" ||
      event.decision.reportId !== record.reportId
    )
      return false;
    const superseded = event.state === "superseded";
    if (
      !superseded &&
      !(
        event.state === "done" &&
        !event.notified &&
        ["retryable", "sending", "uncertain"].includes(event.notificationState ?? "") &&
        !event.dispatches.some((dispatch) => ["pending", "uncertain"].includes(dispatch.state)) &&
        this.staleReport?.(event, record) === true
      )
    )
      return false;
    record.retired = {
      reason: superseded ? "superseded" : "stale_report",
      at: new Date().toISOString(),
    };
    this.save(record);
    return true;
  }

  pendingInChat(chatId: string): boolean {
    return (
      this.store
        .list<ReportDelivery>(namespace)
        .some(
          (record) =>
            record.chatId === chatId &&
            record.channel === "platform" &&
            (this.sending.has(record.eventId) ||
              !valid(record) ||
              (!this.fileAbandoned(record) &&
                !this.retireObsolete(record) &&
                (record.cardState !== "delivered" || !this.bodyConfirmed(record)))),
        ) || this.pendingWithoutReceipt(chatId)
    );
  }

  /**
   * An owner-abandoned attachment stays undelivered (Web download unchanged) but
   * no longer holds the chat; a summary card whose send is unknown still does.
   */
  private fileAbandoned(record: ReportDelivery): boolean {
    return (
      record.presentation === "attachment" &&
      record.fileResolution?.choice === "abandon" &&
      !["sending", "uncertain"].includes(record.cardState)
    );
  }

  /** The persisted deliver intent also guards the crash window before prepare(). */
  private pendingWithoutReceipt(chatId: string): boolean {
    const tasks = new Map(
      this.store
        .list<Task>("tasks")
        .filter(
          (task) =>
            task.chatId === chatId &&
            task.promptVersion === 3 &&
            task.orchestration?.mode === "workflow",
        )
        .map((task) => [task.id, task]),
    );
    return this.store.list<OrchestrationEvent>("task_orchestration_events").some((event) => {
      const task = tasks.get(event.taskId);
      const reportId = event.decision?.action === "deliver" ? event.decision.reportId : undefined;
      if (!task || !reportId || !["done", "attention"].includes(event.state) || event.notified)
        return false;
      const record = this.store.get<ReportDelivery>(namespace, event.id);
      if (record)
        return (
          !matches(record, task.id, event.id, reportId) ||
          record.channel !== "platform" ||
          record.chatId !== chatId
        );
      const state = this.store.get<WorkflowState>(WORKFLOWS, task.id);
      // No frozen revision evidence exists yet. Only an actual replacement proves staleness.
      return !(state?.taskId === task.id && state.report?.id && state.report.id !== reportId);
    });
  }
}

export function reportSummaryText(card: Record<string, unknown>): string {
  const value = card as {
    header?: { title?: { content?: unknown } };
    body?: { elements?: Array<{ content?: unknown }> };
  };
  // A persisted card is untrusted: only real strings may reach the join, so a
  // corrupt `{ toString: null }` field cannot become a raw TypeError here.
  const text = (entry: unknown, fallback: string): string =>
    typeof entry === "string" ? entry : fallback;
  return [
    text(value.header?.title?.content, "报告摘要"),
    ...(Array.isArray(value.body?.elements)
      ? value.body.elements.map((entry) => text(entry?.content, ""))
      : []),
  ].join("\n\n");
}

function fingerprint(input: ReportEnvelope): string {
  return stableId(
    canonical({
      taskId: input.taskId,
      eventId: input.eventId,
      reportId: input.reportId,
      reportHash: input.reportHash,
      chatId: input.chatId,
      text: input.text,
      card: input.card,
      channel: input.channel,
      ...(input.presentation ? { presentation: input.presentation } : {}),
    }),
  );
}

/**
 * A historical entry is authority: it records an already-consumed one-shot
 * retry. Every present entry must therefore be a record carrying a valid
 * recorded resolution; a damaged history must never re-open the retry budget.
 * The remaining transport fields stay optional for legacy/minimal rows, so an
 * entry like `{ fileResolution }` stays readable. Only retry consumption appends
 * history; another choice cannot stand in for the consumed retry and reopen its
 * budget.
 */
function readableFileHistory(history: unknown): boolean {
  return (
    Array.isArray(history) &&
    history.every((entry: unknown) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
      const resolution = (entry as { fileResolution?: OperationResolution }).fileResolution;
      return isDurableResolution(resolution) && resolution?.choice === "retry";
    })
  );
}

/** A retry declared while an historical retry already exists is a spent grant. */
function spentFileRetry(value: Partial<ReportDelivery>): boolean {
  return (
    value.fileResolution?.choice === "retry" &&
    Array.isArray(value.fileHistory) &&
    value.fileHistory.some((entry) => entry?.fileResolution?.choice === "retry")
  );
}

/**
 * Narrow structural check for a persisted delivery. It only proves the fields
 * `valid` hashes and compares are interpretable; it never rewrites, repairs or
 * deletes the row. Only after this passes may `createHash().update()` see
 * `record.text`, so a corrupt value cannot raise a raw crypto TypeError.
 *
 * `cardState` is mandatory and must be a legal state, and a present `fileState`
 * must be a legal state as well: a falsey or unknown value is a damaged receipt
 * that cannot stand in for an absent one. A version 2 attachment must carry its
 * `fileState` (its transport stage is authority-relevant); only a legacy
 * non-attachment envelope may omit it.
 *
 * A present `fileResolution` must be a complete durable resolution (the same
 * shape `Operations.resolve` accepts), and every present `fileHistory` entry
 * must carry a valid recorded resolution: history is authority, because its
 * consumed retry removes the next one-shot grant. A retry already spent in
 * history therefore cannot authorize another. Absence and the legacy
 * non-attachment shape stay compatible.
 */
function readableRecord(record: unknown): record is ReportDelivery {
  if (record === null || typeof record !== "object") return false;
  const value = record as Partial<ReportDelivery>;
  const legalFileState =
    value.fileState !== undefined &&
    typeof value.fileState === "string" &&
    fileTransferStates.includes(value.fileState as NonNullable<ReportDelivery["fileState"]>);
  return (
    typeof value.taskId === "string" &&
    typeof value.eventId === "string" &&
    typeof value.reportId === "string" &&
    typeof value.text === "string" &&
    typeof value.reportHash === "string" &&
    typeof value.bodyId === "string" &&
    typeof value.cardId === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.chatId === "string" &&
    typeof value.cardState === "string" &&
    deliveryStates.includes(value.cardState as ReportDelivery["cardState"]) &&
    (value.presentation === "attachment"
      ? legalFileState
      : value.fileState === undefined || legalFileState) &&
    (value.fileResolution === undefined || isDurableResolution(value.fileResolution)) &&
    (value.fileHistory === undefined || readableFileHistory(value.fileHistory)) &&
    !spentFileRetry(value) &&
    (value.version === 1 || value.version === 2) &&
    (value.presentation === undefined || value.presentation === "attachment") &&
    value.card !== null &&
    typeof value.card === "object" &&
    !Array.isArray(value.card)
  );
}

/** Fail closed: an unreadable record is never a deliverable envelope. */
function valid(record: unknown): record is ReportDelivery {
  if (!readableRecord(record)) return false;
  const prefix = `workflow-report:${record.taskId}:${record.eventId}:${record.reportId}`;
  return (
    ((record.version === 1 && !record.presentation) ||
      (record.version === 2 && record.presentation === "attachment")) &&
    record.bodyId === `${prefix}:body` &&
    record.cardId === `${prefix}:card` &&
    record.fingerprint === fingerprint(record) &&
    createHash("sha256").update(record.text).digest("hex") === record.reportHash
  );
}
function matches(
  record: unknown,
  taskId: string,
  eventId: string,
  reportId: string,
): record is ReportDelivery {
  return (
    !!record &&
    valid(record) &&
    record.taskId === taskId &&
    record.eventId === eventId &&
    record.reportId === reportId
  );
}
