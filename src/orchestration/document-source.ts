import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrchestrationEvent } from "../app/task-orchestrator.js";
import { fail, safeError } from "../core/errors.js";
import { canonical } from "../core/ids.js";
import type { Task } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { ContractChangeDecision } from "./contract-change.js";
import { validateDocumentPaths } from "./document-delivery.js";
import { WORKFLOWS, type WorkflowState } from "./workflow.js";
import { normalizedDirectories, workspaceRevision } from "./workspace.js";

type DocumentSource = NonNullable<WorkflowState["documentSource"]>;
type ReadonlyDocument = NonNullable<DocumentSource["readonlyDocuments"]>[number];

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
  await assertBaseline(task, baseline);
}

async function assertBaseline(task: Task, baseline: DocumentSource): Promise<void> {
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
  await assertReadonlyDocuments(task, baseline.readonlyDocuments ?? []);
  if (baseline.revision !== (await workspaceRevision(task.directories, baseline.paths)))
    fail(
      "workflow_document_scope",
      "授权文档之外的项目变化尚未恢复；请先恢复首次讨论节点派发前的源码，恢复任务不会重置该基线。",
    );
}

async function documentSnapshot(task: Task, path: string): Promise<ReadonlyDocument> {
  try {
    await validateDocumentPaths(task, [path]);
    let hash: string | null;
    try {
      hash = createHash("sha256")
        .update(await readFile(join(task.directories[0] ?? "", path)))
        .digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash = null;
    }
    await validateDocumentPaths(task, [path]);
    return { path, hash };
  } catch {
    fail("workflow_document_scope", "已撤销授权的文档路径类型变化或无法读取，不能重置只读快照。");
  }
}

async function assertReadonlyDocuments(task: Task, documents: ReadonlyDocument[]): Promise<void> {
  for (const document of documents)
    if ((await documentSnapshot(task, document.path)).hash !== document.hash)
      fail("workflow_document_scope", "已撤销授权的文档发生变化，请先恢复撤销时的文件状态。");
}

/** Read legacy Jev evidence without changing its stored audit record. */
function withdrawalChoiceAuthorized(decision: ContractChangeDecision): boolean {
  const choice =
    decision.policyVersion === "workflow-contract-authorization-v2"
      ? decision.pi
      : (decision as { jev?: { status: string; candidateId?: string } }).jev;
  return choice?.status === "success" && choice.candidateId === "authorized";
}

/** A draft's authorization marker alone cannot relax the accepted source boundary. */
function authorizedWithdrawal(store: Store, task: Task, state: WorkflowState): boolean {
  const change = state.plan.contractChange;
  if (
    task.promptVersion !== 3 ||
    task.kind !== "discussion" ||
    state.taskId !== task.id ||
    state.plan.documentDelivery ||
    state.plan.consensus ||
    state.plan.nodes.some((node) => node.access === "write" || node.documentPaths?.length) ||
    change?.removeDocumentDelivery !== true ||
    !change.authorizationId
  )
    return false;
  const current = store.get<WorkflowState>(WORKFLOWS, task.id);
  const decision = store.get<ContractChangeDecision>(
    "workflow_contract_decisions",
    change.authorizationId,
  );
  return (
    current?.taskId === task.id &&
    current.plan.version === state.plan.version &&
    !!current.plan.documentDelivery &&
    canonical(current.documentSource) === canonical(state.documentSource) &&
    (!current.plan.consensus || change.removeConsensus === true) &&
    decision?.taskId === task.id &&
    decision.planVersion === state.plan.version &&
    decision.decision === "authorized" &&
    withdrawalChoiceAuthorized(decision) &&
    decision.change.sourceMessageId === change.sourceMessageId &&
    decision.change.removeDocumentDelivery === true &&
    decision.change.removeConsensus === change.removeConsensus
  );
}

/** Prepare without mutation; the accepted plan and baseline must be committed atomically. */
export async function prepareDocumentSource(
  store: Store,
  task: Task,
  state: WorkflowState,
): Promise<DocumentSource> {
  const paths = [...(state.plan.documentDelivery?.paths ?? [])].sort();
  const previous = state.documentSource;
  const checkPrevious = async () => {
    if (
      previous?.paths.some((path) => !paths.includes(path)) &&
      authorizedWithdrawal(store, task, state)
    )
      await assertBaseline(task, previous);
    else await assertDocumentSource(store, task, state);
  };
  if (previous) {
    await checkPrevious();
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
    ...(previous?.readonlyDocuments?.length || previous?.paths.some((path) => !paths.includes(path))
      ? {
          readonlyDocuments: [
            ...(previous?.readonlyDocuments ?? []).filter((entry) => !paths.includes(entry.path)),
            ...(await Promise.all(
              (previous?.paths ?? [])
                .filter((path) => !paths.includes(path))
                .map((path) => documentSnapshot(task, path)),
            )),
          ],
        }
      : {}),
  };
  // Recheck the old scope before atomically accepting either additions or withdrawal.
  if (previous) await checkPrevious();
  await assertReadonlyDocuments(task, next.readonlyDocuments ?? []);
  return next;
}
