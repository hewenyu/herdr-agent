import { fail, safeError } from "../core/errors.js";
import type { Task } from "../core/types.js";
import type { Store } from "../storage/store.js";
import { assertDocumentSource } from "./document-source.js";
import type { ProgramUserDecision, UserDecisionQuestion } from "./user-decision.js";
import type { WorkflowState } from "./workflow.js";
import { workspaceRevision } from "./workspace.js";

const abbreviated = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

function pathSummary(paths: string[], limit: number): string {
  const complete = paths.join("、");
  if (complete.length <= limit) return complete;
  const remaining = paths.length > 1 ? `（另有 ${paths.length - 1} 项）` : "";
  return `${abbreviated(paths[0] ?? "", limit - remaining.length)}${remaining}`;
}

/**
 * Re-observe a rejected document-scope result against the immutable source boundary.
 * The old output proves attribution, not accepted evidence or the current source hash.
 * Returns a read-only question contract; callers retain revision guards and persistence.
 */
export async function observedDocumentScopeDecision(input: {
  store: Store;
  task: Task;
  state: WorkflowState;
  revision: string;
  artifactRevision: string;
}): Promise<ProgramUserDecision | undefined> {
  const { store, task, state, revision, artifactRevision } = input;
  if (task.promptVersion !== 3 || state.taskId !== task.id) return undefined;
  const issue = state.issues.find(
    (entry) => entry.id === "document-scope-violation" && entry.status === "open" && entry.blocking,
  );
  const outputId = issue?.responses.at(-1)?.outputId;
  if (!issue || !outputId || !issue.evidenceRefs.includes(outputId)) return undefined;
  const match = state.plan.nodes.find((node) => {
    const progress = state.nodes[node.id];
    const repair = progress?.repair;
    return (
      progress?.status === "blocked" &&
      progress.outputId === outputId &&
      !!progress.participantId &&
      !!progress.operationId &&
      progress.inputRevision === revision &&
      repair?.code === "workflow_document_scope" &&
      repair.planVersion === state.plan.version &&
      repair.outputId === outputId &&
      repair.inputRevision === revision &&
      repair.operationId === progress.operationId &&
      repair.artifactRevision === progress.artifactRevision &&
      state.consumedOutputs.includes(outputId)
    );
  });
  if (!match) return undefined;

  const current = async () => {
    if ((await workspaceRevision(task.directories)) !== artifactRevision)
      fail("workflow_artifact_changed", "文档范围待决问题对应的项目版本已变化，请重新核验。");
  };
  await current();
  let reason: string;
  try {
    await assertDocumentSource(store, task, state);
    return undefined;
  } catch (error) {
    const safe = safeError(error);
    if (safe.code !== "workflow_document_scope") throw error;
    reason = safe.message;
  }
  await current();

  const directories = task.directories.join("、");
  const paths = state.documentSource?.paths ?? state.plan.documentDelivery?.paths ?? [];
  const documents = paths.length ? paths.join("、") : "无（项目目录只读）";
  const id = `document_scope:${match.id}`;
  const hasBaseline = !!state.documentSource;
  const question: UserDecisionQuestion = {
    kind: "choice",
    question: "文档任务检测到范围边界问题，你准备先核对恢复，还是保留现状暂停核查？",
    why: `任务目录：${pathSummary(task.directories, 140)}。原授权文档（相对主目录）：${paths.length ? pathSummary(paths, 80) : documents}。程序重新核验：${abbreviated(reason, 120)}`,
    blockedScope: `节点 ${match.id} 及后续讨论、文档复核和最终交付；当前结果不能视为已接受。`,
    sourceRefs: [id],
    replyExample: hasBaseline
      ? "我已在本地核对并恢复授权外变更，保留原文档范围，请重新核验并继续。或：保留现状，暂停任务，等我核查。"
      : "我先在本地核对工作区，确认范围后新建任务；此任务保留现状暂停核查。",
    options: [
      {
        label: "先本地核对并恢复授权外变更",
        impact: hasBaseline
          ? "由你先核对并恢复原授权范围和源码，再明确要求继续。程序再次通过原基线核验后才推进；不会自动回滚或接受扩大范围。"
          : "当前任务缺少可信旧基线，先在本地核对工作区后新建任务；现有任务不能以当前状态重置基线继续。",
      },
      {
        label: "保留现状，暂停核查",
        impact: "保留当前文件和已记录材料，暂停任务等待你核查；不接受本轮结果，不继续交付。",
      },
    ],
  };
  return {
    id,
    kind: "document_scope",
    text: `程序重新核验文档范围未通过：${reason}\n任务目录：${directories}\n原授权文档（相对主目录）：${documents}\n当前节点：${match.id}。当前回复不会授权回滚、重置基线或扩大写入范围。`,
    facts: {
      nodeId: match.id,
      participantId: state.nodes[match.id]?.participantId,
      outputId,
      artifactRevision,
      directories: [...task.directories],
      authorizedDocuments: [...paths],
      sourceBoundary: structuredClone(state.documentSource),
    },
    question,
  };
}
