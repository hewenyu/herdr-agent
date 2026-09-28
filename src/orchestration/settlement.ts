import { fail, safeError } from "../core/errors.js";
import type { Participant, Task } from "../core/types.js";
import type { InputDelivery } from "../tasks/input-delivery.js";
import { rememberImplementer } from "./authorship.js";
import { inspectArtifact, publishBoard, publishNotes, publishOutput } from "./board.js";
import { validateDocumentPaths } from "./document-delivery.js";
import { readHandoff } from "./handoff.js";
import { selectWorkflowOutput } from "./output-selection.js";
import { publishReport } from "./report.js";
import type { WorkflowPorts } from "./runner.js";
import { countSettledBatch, mergeStatus } from "./state.js";
import { parseStatusBlock } from "./status-block.js";
import { WORKFLOWS, type WorkflowState } from "./workflow.js";
import { workspaceRevision } from "./workspace.js";

export async function settleWorkflow(
  ports: WorkflowPorts,
  task: Task,
  state: WorkflowState,
  participants: Participant[],
  commands: string[],
): Promise<void> {
  const save = () => ports.store.set(WORKFLOWS, state.taskId, state);
  let changed = false;
  for (const node of state.plan.nodes) {
    const progress = state.nodes[node.id];
    if (progress?.status !== "dispatched" || !progress.operationId || !progress.inputRevision)
      continue;
    const participant = participants.find((entry) => entry.id === progress.participantId);
    if (
      !participant ||
      !["idle", "done"].includes(participant.status) ||
      participant.error ||
      ports.store.get("participant_awaiting_output", participant.id)
    )
      continue;
    const delivery = ports.store.get<InputDelivery>("input_deliveries", progress.operationId);
    if (!delivery) continue;
    const eligibleOutputs = ports
      .outputs(task.id)
      .filter(
        (entry) =>
          entry.participantId === participant.id &&
          !state.consumedOutputs.includes(entry.entry.id) &&
          (entry.sequence ?? 0) > delivery.outputSequence,
      );
    const output = selectWorkflowOutput(
      eligibleOutputs,
      delivery,
      ports.events(task.id).flatMap((event) => event.dispatches),
      ports.store,
      task.promptVersion === 3
        ? { stateDir: ports.config?.stateDir ?? "", taskId: task.id }
        : undefined,
    );
    if (!output) continue;
    await publishOutput(ports.config?.stateDir ?? "", task.id, output.entry.id, output.entry.text);
    try {
      const artifactRevision = await workspaceRevision(task.directories);
      if (progress.artifactRevision !== artifactRevision) {
        // Attribute observed writes conservatively, even if the status block is invalid.
        rememberImplementer(state, participant.id);
        save();
      }
      const identity = {
        nodeId: node.id,
        operationId: progress.operationId,
        inputRevision: progress.inputRevision,
      };
      const block =
        task.promptVersion === 3
          ? await readHandoff(
              ports.config?.stateDir ?? "",
              task,
              state,
              node,
              identity,
              output.entry.text,
            )
          : parseStatusBlock(output.entry.text, identity);
      if (node.documentPaths?.length) await validateDocumentPaths(task, node.documentPaths);
      if (
        node.documentPaths?.length &&
        (!progress.sourceRevision ||
          progress.sourceRevision !==
            (await workspaceRevision(task.directories, node.documentPaths)))
      )
        fail(
          "workflow_document_scope",
          "文档节点期间检测到授权文档之外的项目变化，需核对后才能继续。",
        );
      if (
        (node.access === "read" || node.role === "reviewer") &&
        progress.artifactRevision !== artifactRevision
      )
        fail(
          "workflow_artifact_changed",
          "执行期间代码版本变化，原评审/读取结果不能证明新版本，需重新核对。",
        );
      const validReferences = new Set([
        ...state.consumedOutputs,
        output.entry.id,
        ...state.evidence.map((entry) => entry.id),
        ...state.artifacts.map((entry) => entry.path),
        ...block.artifactRefs,
      ]);
      if (block.issues.some((issue) => issue.evidenceRefs.some((ref) => !validReferences.has(ref))))
        fail("workflow_evidence", "问题引用了不存在或不属于本任务的证据。");
      for (const path of block.artifactRefs) {
        const artifact = await inspectArtifact(task, path);
        state.artifacts.push({
          ...artifact,
          reference: path,
          outputId: output.entry.id,
          artifactRevision,
        });
      }
      mergeStatus(state, node, block, output.entry.id, artifactRevision);
      if (
        node.phase === "validating" &&
        state.plan.validation?.mode !== "not_run" &&
        !commands.length &&
        !state.evidence.some(
          (entry) =>
            entry.outputId === output.entry.id &&
            entry.source === "agent_review" &&
            entry.result === "passed",
        )
      ) {
        progress.status = "blocked";
        progress.error =
          "未取得独立 agent 实际重跑的证据，请补充检查结果或说明需用户处理的环境阻塞。";
      }
      if (node.phase === "reporting" && state.nodes[node.id]?.status === "completed")
        await publishReport(
          ports.config?.stateDir ?? "",
          task,
          state,
          block,
          output.entry.id,
          artifactRevision,
        );
      ports.store.set("workflow_status_blocks", output.entry.id, { taskId: task.id, block });
      if ("capturedNotes" in block) {
        const captured = block.capturedNotes as { text: string; hash: string };
        await publishNotes(ports.config?.stateDir ?? "", task.id, output.entry.id, captured.text);
        ports.store.set("workflow_conversation_evidence", output.entry.id, {
          taskId: task.id,
          participantId: participant.id,
          outputId: output.entry.id,
          text: output.entry.text.slice(0, 4000),
          notes: captured.text,
          hash: captured.hash,
        });
      }
    } catch (error) {
      progress.status = "blocked";
      progress.outputId = output.entry.id;
      progress.error = safeError(error).message;
      if (safeError(error).code === "workflow_document_scope") {
        state.stall.awaitingUser = true;
        state.issues.push({
          id: "document-scope-violation",
          description: progress.error,
          status: "open",
          blocking: true,
          evidenceRefs: [],
          raisedBy: participant.id,
          responses: [],
        });
      }
      if (!state.consumedOutputs.includes(output.entry.id))
        state.consumedOutputs.push(output.entry.id);
    }
    changed = true;
  }
  if (changed) {
    for (const batch of ports.events(task.id)) {
      if (!batch.workflow?.applied || !batch.dispatches.length || state.batches.includes(batch.id))
        continue;
      if (
        batch.dispatches.every((dispatch) => {
          const progress = dispatch.nodeId ? state.nodes[dispatch.nodeId] : undefined;
          return (
            progress?.operationId === dispatch.operationId &&
            progress.outputId &&
            ports.store.get("workflow_status_blocks", progress.outputId)
          );
        })
      )
        countSettledBatch(state, batch.id, ports.config?.jev?.stallRounds ?? 3);
    }
    save();
    await publishBoard(ports.config?.stateDir ?? "", task, state);
  }
}
