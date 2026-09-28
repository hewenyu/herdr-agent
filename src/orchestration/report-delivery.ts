import { createHash } from "node:crypto";
import type { Outbox } from "../app/outbox.js";
import type { OrchestrationEvent } from "../app/task-orchestrator.js";
import { OperationError, safeError } from "../core/errors.js";
import { canonical, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { PlatformPort } from "../core/ports.js";
import type { StoredMessage } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { ReportRevisionEvidence } from "./revision.js";

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

/** Two independently recoverable notification components, never a dispatch authority. */
export class ReportDeliveries {
  private readonly mutex = new KeyedMutex();
  private readonly sending = new Set<string>();
  constructor(
    private readonly store: Store,
    private readonly outbox: Outbox,
    private readonly platform: () => PlatformPort | undefined,
    private readonly staleReport?: (event: OrchestrationEvent, record: ReportDelivery) => boolean,
    private readonly captureRevision?: (
      event: OrchestrationEvent,
    ) => ReportRevisionEvidence | undefined,
  ) {}

  prepare(input: ReportEnvelope): ReportDelivery {
    if (createHash("sha256").update(input.text).digest("hex") !== input.reportHash)
      throw new OperationError("workflow_report", "报告正文与冻结版本不匹配。");
    const previous = this.store.get<ReportDelivery>(namespace, input.eventId);
    if (previous) {
      if (
        !valid(previous) ||
        previous.taskId !== input.taskId ||
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
      if (!["delivered", "sending", "uncertain"].includes(bodyState ?? "")) await beforeSend?.();
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
    await beforeSend?.();
    record.cardState = "sending";
    this.save(record);
    try {
      const id = await platform.sendCard(record.chatId, record.card, stableId(record.cardId));
      if (!id) throw new OperationError("delivery_uncertain", "摘要卡片缺少送达编号。", "unknown");
      record.cardMessageId = id;
      record.cardState = "delivered";
      record.error = undefined;
      this.save(record);
    } catch (error) {
      record.error = safeError(error);
      record.cardState = record.error.outcome === "not_executed" ? "retryable" : "uncertain";
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
        ? ["prepared", "uploaded", "retryable", "delivered"].includes(record.fileState ?? "")
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
      ? record.fileState === "delivered" && !!record.fileKey && !!record.fileMessageId
      : this.outbox.receipt(record.bodyId)?.state === "delivered";
  }

  private async sendAttachment(
    record: ReportDelivery,
    beforeSend?: () => Promise<void>,
  ): Promise<void> {
    if (record.fileState === "delivered") return;
    if (["uploading", "sending", "uncertain"].includes(record.fileState ?? ""))
      throw new OperationError(
        "delivery_uncertain",
        "报告附件传输结果未知，不能自动重复上传或发送。",
        "unknown",
      );
    const platform = this.platform();
    if (!platform?.uploadFile || !platform.sendFile)
      throw new OperationError("platform_unavailable", "当前平台未提供报告附件能力。");
    try {
      if (!record.fileKey) {
        await beforeSend?.();
        record.fileState = "uploading";
        this.save(record);
        const fileKey = await platform.uploadFile("report.md", record.text);
        if (!fileKey)
          throw new OperationError("delivery_uncertain", "报告上传缺少文件编号。", "unknown");
        record.fileKey = fileKey;
        record.fileState = "uploaded";
        this.save(record);
      }
      await beforeSend?.();
      record.fileState = "sending";
      this.save(record);
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
      record.fileState = record.error.outcome === "not_executed" ? "retryable" : "uncertain";
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
    return this.store
      .list<ReportDelivery>(namespace)
      .some(
        (record) =>
          record.chatId === chatId &&
          record.channel === "platform" &&
          (this.sending.has(record.eventId) ||
            !valid(record) ||
            (!this.retireObsolete(record) &&
              (record.cardState !== "delivered" || !this.bodyConfirmed(record)))),
      );
  }
}

export function reportSummaryText(card: Record<string, unknown>): string {
  const value = card as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<{ content?: string }> };
  };
  return [
    value.header?.title?.content ?? "报告摘要",
    ...(value.body?.elements ?? []).map((entry) => entry.content ?? ""),
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
function valid(record: ReportDelivery): boolean {
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
  record: ReportDelivery | undefined,
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
