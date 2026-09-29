import type { OrchestrationEvent } from "../app/task-orchestrator.js";
import { fail } from "../core/errors.js";
import type { Task } from "../core/types.js";
import type { Store } from "../storage/store.js";
import { reportText } from "./report.js";
import { WORKFLOWS, type WorkflowState } from "./workflow.js";

/** Freeze the delivery only after async evidence reads still match the current workspace. */
export async function validatedReport(
  event: OrchestrationEvent,
  ports: {
    store: Store;
    current(): Task;
    assertDelivery(task: Task, state: WorkflowState): Promise<void>;
  },
): Promise<{ task: Task; text: string }> {
  const task = ports.current();
  if (task.directoryMode === "worktree" && !task.worktreeReady)
    fail("orchestration_deferred", "工作目录尚未就绪，等待报告重新核验。");
  const state = ports.store.get<WorkflowState>(WORKFLOWS, task.id);
  if (!state || !event.decision?.reportId || state.report?.id !== event.decision.reportId)
    fail("workflow_report", "交付报告引用已失效。");
  const text = await reportText(state);
  await ports.assertDelivery(task, state);
  const current = ports.current();
  if (
    task.directoryMode !== current.directoryMode ||
    task.worktreeReady !== current.worktreeReady ||
    JSON.stringify(task.directories) !== JSON.stringify(current.directories) ||
    (current.directoryMode === "worktree" && !current.worktreeReady)
  )
    fail("orchestration_deferred", "报告核验期间工作目录变化，等待当前目录重新核验。");
  if (ports.store.get<WorkflowState>(WORKFLOWS, task.id)?.report?.id !== event.decision.reportId)
    fail("workflow_report", "交付报告引用已失效。");
  return { task: current, text };
}
