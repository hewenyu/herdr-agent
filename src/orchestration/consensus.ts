import { fail } from "../core/errors.js";
import type { Task } from "../core/types.js";
import { inspectArtifact, latestArtifacts } from "./board.js";
import type { StatusBlock } from "./status-block.js";
import type { WorkflowNode, WorkflowPlan, WorkflowState } from "./workflow.js";

/** Only enabled when selection/limited planning says the user requires all participants to agree. */
export function compileConsensus(plan: WorkflowPlan, participantIds: string[]): void {
  if (!plan.documentDelivery?.paths.length || !participantIds.length)
    fail("workflow_plan", "共同认可须绑定实际交付文档及参与者。");
  const report = plan.nodes.find((node) => node.phase === "reporting");
  if (!report) fail("workflow_plan", "共同认可缺少报告出口。");
  if (plan.nodes.some((node) => node.consensus || /^confirm-\d+$/.test(node.id)))
    fail("workflow_plan", "共同认可节点由程序生成，不能重复声明。");
  plan.consensus = { participantIds: [...new Set(participantIds)] };
  let before = [...report.dependsOn];
  const nodes = plan.consensus.participantIds.map((participantId, index): WorkflowNode => {
    const id = `confirm-${index + 1}`;
    const node: WorkflowNode = {
      id,
      phase: "discussing",
      role: "analyst",
      participantId,
      access: "read",
      consensus: true,
      purpose: "读取最终文档和前序实际意见，确认同版结论或明确保留分歧。",
      instruction:
        "逐项核对最终文件和对方实际材料。只有认可当前完整文档才在回执中明确批准；不认可时列出具体阻塞问题，请继续修订。不得代替其他参与者确认，不修改项目文件。",
      dependsOn: before,
    };
    before = [id];
    return node;
  });
  plan.nodes.splice(plan.nodes.indexOf(report), 0, ...nodes);
  report.dependsOn = before;
}

export function responseOutputs(state: WorkflowState, node: WorkflowNode): string[] {
  return node.dependsOn.flatMap((id) => state.nodes[id]?.outputId ?? []);
}

export function validateConsensusPlan(
  plan: WorkflowPlan,
  task: Task,
  ancestors: (id: string) => Set<string>,
): void {
  const confirmations = plan.nodes.filter((node) => node.consensus !== undefined);
  if (!plan.consensus) {
    if (confirmations.length) fail("workflow_plan", "确认节点缺少共同认可合同。");
    return;
  }
  const ids = plan.consensus.participantIds;
  if (
    task.promptVersion !== 3 ||
    !plan.documentDelivery?.paths.length ||
    !Array.isArray(ids) ||
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.length !== task.participantIds.length ||
    ids.some((id) => !task.participantIds.includes(id))
  )
    fail("workflow_plan", "共同认可必须覆盖当前全部参与者和实际文档。");
  const preceding = plan.nodes.filter(
    (node) => node.documentPaths?.length || node.role === "reviewer",
  );
  if (
    confirmations.length !== ids.length ||
    ids.some((id) => confirmations.filter((node) => node.participantId === id).length !== 1)
  )
    fail("workflow_plan", "每位参与者须有且仅有一个本人确认节点。");
  for (const node of confirmations) {
    if (
      node.consensus !== true ||
      node.phase !== "discussing" ||
      node.role !== "analyst" ||
      node.access !== "read" ||
      node.documentPaths ||
      !node.participantId ||
      !ids.includes(node.participantId) ||
      preceding.some((entry) => !ancestors(node.id).has(entry.id))
    )
      fail("workflow_plan", "共同认可须在全部文档写作和独立评审之后只读进行。");
  }
}

export async function consensusDocuments(task: Task, state: WorkflowState) {
  return Promise.all(
    (state.plan.documentDelivery?.paths ?? []).map(async (path) => {
      const artifact = await inspectArtifact(task, path);
      return { path, hash: artifact.hash };
    }),
  );
}

/** Validate the response against program-observed files, never against an agent's claimed version. */
export async function captureConsensus(
  task: Task,
  state: WorkflowState,
  node: WorkflowNode,
  block: StatusBlock,
  participantId: string,
  outputId: string,
  artifactRevision: string,
): Promise<void> {
  if (!state.plan.consensus) return;
  const expected = responseOutputs(state, node);
  const responses = block.responses ?? [];
  if (new Set(responses.map((entry) => entry.outputId)).size !== responses.length)
    fail("workflow_response", "同一份前序材料不能重复声明回应。");
  if (
    expected.some((id) => !responses.some((entry) => entry.outputId === id && entry.comment.trim()))
  )
    fail(
      "workflow_response",
      "本轮缺少对前序实际材料的明确回应，请引用输出编号并说明接受、修改或分歧。",
    );
  if (responses.some((entry) => !expected.includes(entry.outputId)))
    fail("workflow_response", "回应引用不属于本轮前序材料。");
  if (!node.consensus || block.status !== "completed") return;
  if (
    node.participantId !== participantId ||
    !state.plan.consensus.participantIds.includes(participantId)
  )
    fail("workflow_consensus", "认可记录必须来自当前指定参与者本人。");
  if (!block.consensus?.approved)
    fail("workflow_consensus", "参与者尚未明确认可最终文档，不能完成确认节点。");
  const documents = await consensusDocuments(task, state);
  const claimed = block.consensus.documents;
  if (
    claimed.length !== documents.length ||
    new Set(claimed.map((entry) => entry.path)).size !== documents.length ||
    documents.some(
      (doc) => !claimed.some((entry) => entry.path === doc.path && entry.hash === doc.hash),
    )
  )
    fail("workflow_consensus", "认可记录未对应当前全部文档的实际哈希，请重新读取文件后确认。");
  if (block.blockers.length || block.issues.some((issue) => issue.status === "open"))
    fail("workflow_consensus", "仍有阻塞分歧，不能同时声明认可完成。");
  state.consensusApprovals ??= [];
  state.consensusApprovals.push({ participantId, outputId, artifactRevision, documents });
}

export function consensusMissing(state: WorkflowState, artifactRevision: string): string[] {
  if (!state.plan.consensus) return [];
  const artifacts = latestArtifacts(state, artifactRevision);
  return state.plan.consensus.participantIds.flatMap((id) => {
    const node = state.plan.nodes.find((entry) => entry.consensus && entry.participantId === id);
    const progress = node && state.nodes[node.id];
    const approval = state.consensusApprovals?.find(
      (entry) =>
        entry.participantId === id &&
        entry.outputId === progress?.outputId &&
        entry.artifactRevision === artifactRevision,
    );
    const valid =
      progress?.status === "completed" &&
      approval &&
      state.plan.documentDelivery?.paths.every((path) => {
        const doc = approval.documents.find((entry) => entry.path === path);
        return (
          doc &&
          artifacts.some(
            (entry) =>
              entry.artifactRevision === artifactRevision &&
              (entry.reference === path || entry.path === path) &&
              entry.hash === doc.hash,
          )
        );
      });
    return valid ? [] : [`参与者 ${id} 尚未确认同版最终文档`];
  });
}

/** Read files again at delivery: ignored files may change without a workspace revision change. */
export async function assertConsensusDocuments(
  task: Task,
  state: WorkflowState,
  revision: string,
): Promise<Array<{ path: string; hash: string }>> {
  if (!state.plan.consensus) return [];
  const documents = await consensusDocuments(task, state);
  for (const id of state.plan.consensus.participantIds) {
    const node = state.plan.nodes.find((entry) => entry.consensus && entry.participantId === id);
    const approval = state.consensusApprovals?.find(
      (entry) =>
        entry.participantId === id &&
        entry.outputId === (node && state.nodes[node.id]?.outputId) &&
        entry.artifactRevision === revision,
    );
    if (
      !approval ||
      documents.some(
        (doc) =>
          !approval.documents.some((entry) => entry.path === doc.path && entry.hash === doc.hash),
      )
    )
      fail("workflow_consensus", "最终文档已变化或缺少本人认可，请对当前文件重新确认。");
  }
  return documents;
}
