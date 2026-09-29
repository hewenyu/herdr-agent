import type { OrchestrationEvent, TaskOrchestratorOptions } from "../app/task-orchestrator.js";
import { safeError } from "../core/errors.js";
import type { Task } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { ReportDelivery } from "./report-delivery.js";
import { WORKFLOWS, type WorkflowState } from "./workflow.js";

function completing(task: Task): boolean {
  return (
    task.promptVersion === 3 &&
    task.orchestration?.mode === "workflow" &&
    !!task.completedAt &&
    task.completedAt !== "0" &&
    ["completed", "destroying", "destroyed"].includes(task.status) &&
    !task.completionRequest &&
    !task.groupDeleted
  );
}

/** Completion permits only a previously authorized report notification, never new work. */
export function currentOrchestrationTask(
  options: TaskOrchestratorOptions,
  taskId: string,
  reportDelivery = false,
): Task | undefined {
  const task = options.store.get<Task>("tasks", taskId);
  if (
    !task ||
    !["model", "workflow"].includes(task.orchestration?.mode ?? "") ||
    task.completionRequest ||
    task.groupDeleted ||
    (!(reportDelivery && completing(task)) &&
      (task.discussion.paused ||
        task.closeRequested ||
        ["completed", "destroying", "destroyed", "paused"].includes(task.status)))
  )
    return;
  try {
    options.tasks().records.authorize(task.ownerId);
  } catch {
    return;
  }
  return task;
}

/** Re-enter the one existing notification/reconciliation chain before deleting its chat. */
export async function finishReportNotifications(
  task: Task,
  events: OrchestrationEvent[],
  ports: {
    store: Store;
    revision(task: Task): string;
    recover(task: Task, event: OrchestrationEvent): Promise<void>;
    notify(task: Task, event: OrchestrationEvent): Promise<void>;
  },
): Promise<void> {
  if (!completing(task)) return;
  for (const event of events) {
    const reportId = event.decision?.action === "deliver" ? event.decision.reportId : undefined;
    const record = ports.store.get<ReportDelivery>("workflow_report_deliveries", event.id);
    const chatId = task.chatId ?? task.entryChatId;
    if (
      event.taskId !== task.id ||
      event.state !== "done" ||
      event.notified ||
      !reportId ||
      (record
        ? record.retired ||
          record.taskId !== task.id ||
          record.eventId !== event.id ||
          record.reportId !== reportId ||
          record.channel !== "platform"
        : !chatId || chatId.startsWith("web:")) ||
      event.userRevision !== ports.revision(task) ||
      ports.store.get<WorkflowState>(WORKFLOWS, task.id)?.report?.id !== reportId ||
      event.dispatches.some((entry) => ["pending", "uncertain"].includes(entry.state))
    )
      continue;
    try {
      // A persisted deliver decision precedes prepare(); no receipt proves no platform send.
      await ports.recover(task, event);
      if (
        event.state === "done" &&
        !event.notified &&
        (!event.notificationState || event.notificationState === "retryable")
      )
        await ports.notify(task, event);
    } catch (error) {
      const safe = safeError(error);
      if (
        ![
          "workflow_report",
          "workflow_artifact",
          "workflow_document_scope",
          "workflow_consensus",
        ].includes(safe.code)
      )
        throw error;
      event.state = "attention";
      event.error = safe;
      event.updatedAt = new Date().toISOString();
      ports.store.set("task_orchestration_events", event.id, event);
    }
  }
}
