import type { OrchestrationEvent } from "../app/task-orchestrator.js";
import { fail, safeError } from "../core/errors.js";
import type { Task } from "../core/types.js";
import type { Store } from "../storage/store.js";
import { validateDocumentPaths } from "./document-delivery.js";
import type { WorkflowState } from "./workflow.js";
import { normalizedDirectories, workspaceRevision } from "./workspace.js";

async function directories(task: Task): Promise<string[]> {
  // Preserve the primary directory: relative document paths belong to this root.
  return (await Promise.all(task.directories.map((path) => normalizedDirectories([path])))).flat();
}

function previouslyDispatched(store: Store, task: Task, state: WorkflowState): boolean {
  return (
    state.issues.some((issue) => issue.id === "document-scope-violation") ||
    Object.values(state.nodes).some((node) => node.operationId || node.sourceRevision) ||
    store
      .list<OrchestrationEvent>("task_orchestration_events")
      .some((event) => event.taskId === task.id && event.dispatches.length > 0)
  );
}

/** A user resume or a participant's resolution cannot authorize a changed source tree. */
export async function assertDocumentSource(
  _store: Store,
  task: Task,
  state: WorkflowState,
): Promise<void> {
  const baseline = state.documentSource;
  if (!baseline) {
    if (!state.plan.documentDelivery && (task.promptVersion !== 3 || task.kind !== "discussion"))
      return;
    fail("workflow_document_scope", "缺少首次讨论节点派发前的源码基线，不能确认任务交付范围。");
  }
  const authorized = new Set(state.plan.documentDelivery?.paths ?? []);
  if (baseline.paths.some((path) => !authorized.has(path)))
    fail(
      "workflow_document_scope",
      "文档范围不能移除本任务已冻结的路径；请恢复原计划的完整文档范围，或核对工作区后新建任务。",
    );
  if (JSON.stringify(baseline.directories) !== JSON.stringify(await directories(task)))
    fail("workflow_document_scope", "文档任务目录已变化，不能沿用或重置原源码基线。");
  try {
    await validateDocumentPaths(task, baseline.paths);
  } catch (error) {
    if (safeError(error).code !== "workflow_scope") throw error;
    fail(
      "workflow_document_scope",
      "原授权文档路径含符号链接或类型已变化，不能证明原源码范围未变。",
    );
  }
  if (baseline.revision !== (await workspaceRevision(task.directories, baseline.paths)))
    fail(
      "workflow_document_scope",
      "授权文档之外的项目变化尚未恢复；请先恢复首次讨论节点派发前的源码，恢复任务不会重置该基线。",
    );
}

/** Prepare without mutation; the accepted plan and baseline must be committed atomically. */
export async function prepareDocumentSource(
  store: Store,
  task: Task,
  state: WorkflowState,
): Promise<NonNullable<WorkflowState["documentSource"]>> {
  const paths = [...(state.plan.documentDelivery?.paths ?? [])].sort();
  const previous = state.documentSource;
  if (previous) {
    await assertDocumentSource(store, task, state);
    if (JSON.stringify(previous.paths) === JSON.stringify(paths)) return previous;
  } else if (previouslyDispatched(store, task, state)) {
    // Legacy receipts did not freeze the original directory list. The current tree is not
    // evidence of the old authorized tree, even when a later plan no longer contains it.
    fail(
      "workflow_document_scope",
      "旧文档任务缺少可信源码基线，不能从当前现场初始化；请核对恢复后新建任务。",
    );
  }
  await validateDocumentPaths(task, paths);
  const next = {
    directories: await directories(task),
    paths,
    revision: await workspaceRevision(task.directories, paths),
  };
  // A newly authorized exclusion must not hide changes that raced the first old-scope check.
  if (previous) await assertDocumentSource(store, task, state);
  return next;
}
