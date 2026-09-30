import { OperationError } from "../core/errors.js";
import { canonical, now, stableId } from "../core/ids.js";
import type { Participant, Task } from "../core/types.js";
import { type ReportDelivery, reportFileInFlight } from "../orchestration/report-delivery.js";
import {
  type OperationReceipt,
  type OperationResolution,
  Operations,
} from "../storage/operations.js";
import type { Store } from "../storage/store.js";
import { nativeInputCandidates } from "../transcripts/input.js";
import { assertActive, type TaskContext } from "./context.js";
import type { InputDelivery } from "./input-delivery.js";
import { participantPromptCandidates } from "./prompts.js";

export type UncertainKind = "pane_close" | "input_delivery" | "report_file";
export interface UncertainEffect {
  id: string;
  kind: UncertainKind;
  taskId: string;
  participantId?: string;
  summary: string;
  evidence: string[];
  options: Array<{ choice: OperationResolution["choice"]; label: string; consequence: string }>;
}
const options: UncertainEffect["options"] = [
  { choice: "treat_done", label: "视为完成", consequence: "不重复执行；原未知回执保留。" },
  { choice: "retry", label: "重试一次", consequence: "可能重复执行；保存旧回执与决议。" },
  { choice: "abandon", label: "放弃", consequence: "不再执行；不声称目标状态已达成。" },
];
const reports = "workflow_report_deliveries";

export function listUncertainEffects(store: Store, task: Task): UncertainEffect[] {
  const effects: UncertainEffect[] = [];
  for (const [id, receipt] of store.entries<OperationReceipt>("operations")) {
    if (
      !["pending", "uncertain"].includes(receipt.state) ||
      (receipt.state === "pending" && new Operations(store).inFlight(id)) ||
      receipt.resolution ||
      receipt.retiredByRestart
    )
      continue;
    const participantId = task.participantIds.find((key) => id === `${key}:close`);
    const initialId = task.participantIds.find((key) => id === `${key}:initial`);
    const delivery = store.get<InputDelivery>("input_deliveries", id);
    const kind = participantId
      ? "pane_close"
      : delivery?.taskId === task.id ||
          initialId ||
          id.startsWith(`${task.id}:send:`) ||
          id.startsWith(`${task.id}:relay:`)
        ? "input_delivery"
        : undefined;
    if (!kind) continue;
    effects.push({
      id,
      kind,
      taskId: task.id,
      participantId: participantId ?? delivery?.participantId ?? initialId,
      summary: kind === "pane_close" ? "执行窗口关闭结果未知" : "输入投递结果未知",
      evidence: [`历史状态：${receipt.state}`, ...(receipt.error ? [receipt.error.message] : [])],
      options: structuredClone(
        options.filter(
          (option) =>
            option.choice !== "retry" ||
            !receipt.history?.some((attempt) => attempt.resolution?.choice === "retry"),
        ),
      ),
    });
  }
  for (const record of store.list<ReportDelivery>(reports)) {
    if (
      record.taskId !== task.id ||
      record.retired ||
      reportFileInFlight(store, record.eventId) ||
      record.fileResolution ||
      !["uploading", "sending", "uncertain"].includes(record.fileState ?? "")
    )
      continue;
    effects.push({
      id: `report-file:${record.eventId}`,
      kind: "report_file",
      taskId: task.id,
      summary: "报告附件传输结果未知",
      evidence: ["平台无只读查询接口", `历史状态：${record.fileState}`],
      options: structuredClone(
        options.filter(
          (option) =>
            option.choice !== "retry" ||
            !record.fileHistory?.some((attempt) => attempt.fileResolution?.choice === "retry"),
        ),
      ),
    });
  }
  return effects;
}

export function applyUncertainResolution(
  store: Store,
  effect: UncertainEffect,
  decision: Pick<OperationResolution, "choice" | "decidedBy" | "reason">,
): void {
  const task = store.get<Task>("tasks", effect.taskId);
  if (
    !task ||
    !listUncertainEffects(store, task).some(
      (entry) =>
        entry.id === effect.id &&
        entry.kind === effect.kind &&
        entry.participantId === effect.participantId,
    )
  )
    throw new OperationError("operation_resolution_invalid", "未知操作已变化，请重新读取。");
  if (!decision.reason.trim())
    throw new OperationError("operation_resolution_invalid", "决议必须记录依据。");
  if (
    effect.kind === "pane_close" &&
    decision.choice === "abandon" &&
    decision.decidedBy !== "user"
  )
    throw new OperationError("operation_resolution_invalid", "窗口关闭只能由用户明确放弃。");
  const resolution: OperationResolution = {
    ...decision,
    evidence: [...effect.evidence],
    at: now(),
  };
  if (effect.kind === "report_file") {
    const id = effect.id.slice("report-file:".length);
    const record = store.get<ReportDelivery>(reports, id);
    if (!record || record.fileResolution)
      throw new OperationError("operation_resolution_conflict", "报告决议不能覆盖。");
    if (
      decision.choice === "retry" &&
      record.fileHistory?.some((attempt) => attempt.fileResolution?.choice === "retry")
    )
      throw new OperationError("operation_retry_exhausted", "报告附件最多允许重试一次。");
    store.set(reports, id, { ...record, fileResolution: resolution });
  } else {
    if (effect.kind === "input_delivery" && decision.choice === "treat_done")
      resolution.result = {
        status: "delivered",
        acked: false,
        verified: decision.decidedBy === "evidence",
        attempts: 1,
        detail: decision.reason,
      };
    new Operations(store).resolve(effect.id, resolution);
  }
}

/** Queries only: never close panes, send input, upload files or rewrite historical outcomes. */
export async function reconcileUncertain(
  context: TaskContext,
  task: Task,
): Promise<{
  resolved: string[];
  remaining: UncertainEffect[];
}> {
  const resolved: string[] = [];
  const effects = listUncertainEffects(context.store, task);
  for (const effect of effects) {
    assertActive(context);
    let proven = false;
    try {
      const participant = effect.participantId
        ? context.store.get<Participant>("participants", effect.participantId)
        : undefined;
      if (effect.kind === "pane_close" && participant?.execution) {
        const receipt = context.store.get<OperationReceipt>("operations", effect.id);
        if (receipt?.fingerprint !== stableId(canonical(participant.execution))) continue;
        // agent.get absence alone does not prove pane absence: an exited agent leaves a shell.
        const exists = await context.herdr.paneExists(participant.execution.paneId, context.signal);
        proven = !exists;
        effect.evidence.push(
          exists
            ? "目标 pane 仍存在；未执行关闭。"
            : `pane.get 确认窗口不存在：${participant.execution.paneId}`,
        );
      } else if (effect.kind === "input_delivery" && participant?.execution) {
        const delivery = context.store.get<InputDelivery>("input_deliveries", effect.id);
        const receipt = context.store.get<OperationReceipt>("operations", effect.id);
        if (
          delivery &&
          receipt?.fingerprint === delivery.fingerprint &&
          canonical(participant.execution) === canonical(delivery.execution) &&
          participant.started
        ) {
          const input = await context.herdr.initialInput?.(delivery.execution, delivery.receipt);
          proven =
            input !== undefined &&
            nativeInputCandidates(delivery.execution.kind, input).includes(delivery.prompt);
          if (proven)
            effect.evidence.push("原生 transcript receipt 与完整 prompt 精确匹配；未重新投递。");
        } else if (
          !delivery &&
          effect.id === `${participant.id}:initial` &&
          receipt?.fingerprint === stableId(canonical({ receipt: participant.initialReceipt }))
        ) {
          const input = await context.herdr.initialInput?.(
            participant.execution,
            participant.initialReceipt,
          );
          const prefixes = participantPromptCandidates(task, participant);
          proven =
            input !== undefined &&
            nativeInputCandidates(participant.execution.kind, input).some((candidate) =>
              prefixes.includes(candidate),
            );
          if (proven)
            effect.evidence.push("旧格式原生初始输入与完整 prompt 精确匹配；未重新投递。");
        }
      }
      assertActive(context);
      if (proven) {
        applyUncertainResolution(context.store, effect, {
          choice: "treat_done",
          decidedBy: "evidence",
          reason: effect.evidence.at(-1) ?? "只读补证",
        });
        resolved.push(effect.id);
      }
    } catch (error) {
      assertActive(context);
      effect.evidence.push(
        error instanceof Error ? `只读查询未确认：${error.message}` : "只读查询失败",
      );
    }
  }
  return { resolved, remaining: effects.filter((effect) => !resolved.includes(effect.id)) };
}
