import { fail, safeError } from "../core/errors.js";
import type { Participant, Task } from "../core/types.js";
import type { InputDelivery } from "../tasks/input-delivery.js";
import { rememberImplementer } from "./authorship.js";
import { inspectArtifact, publishBoard, publishNotes, publishOutput } from "./board.js";
import { captureConsensus, responseOutputs } from "./consensus.js";
import { validateDocumentPaths } from "./document-delivery.js";
import { assertDocumentSource } from "./document-source.js";
import { handoffDirectory, readHandoff } from "./handoff.js";
import { selectWorkflowOutput } from "./output-selection.js";
import { rejectReceipt } from "./receipt-diagnostics.js";
import { receiptRepairRevision, recordWorkflowRejection } from "./receipt-recovery.js";
import { publishReport } from "./report.js";
import type { WorkflowPorts } from "./runner.js";
import { countSettledBatch, mergeStatus } from "./state.js";
import { bindEvidenceReferences, parseStatusBlock, type StatusBlock } from "./status-block.js";
import { WORKFLOWS, type WorkflowNode, type WorkflowState } from "./workflow.js";
import { workspaceRevision } from "./workspace.js";

const documentScopeIssueId = "document-scope-violation";

function validateResponses(state: WorkflowState, node: WorkflowNode, block: StatusBlock): void {
  if (!state.plan.consensus) return;
  const expected = responseOutputs(state, node);
  const actual = (block.responses ?? []).map((entry) => entry.outputId);
  if (
    expected.some((id) => !actual.includes(id)) ||
    actual.some((id) => !expected.includes(id)) ||
    new Set(actual).size !== actual.length
  )
    rejectReceipt("workflow_response", "本轮 responses 未逐项对应实际前序材料。", [
      {
        field: "responses.outputId",
        reason: "predecessor_mismatch",
        expected: JSON.stringify(expected),
        actual: JSON.stringify(actual),
      },
    ]);
}

/** Older settlements could append the same issue repeatedly; preserve all observed evidence. */
function consolidateDocumentScopeIssue(state: WorkflowState): boolean {
  const entries = state.issues.filter((issue) => issue.id === documentScopeIssueId);
  const first = entries[0];
  if (!first || entries.length < 2) return false;
  first.status = entries.some((issue) => issue.status === "open")
    ? "open"
    : entries.some((issue) => issue.status === "deferred")
      ? "deferred"
      : "resolved";
  first.blocking = entries.some((issue) => issue.blocking);
  first.evidenceRefs = [...new Set(entries.flatMap((issue) => issue.evidenceRefs))];
  first.responses = [
    ...new Map(
      entries
        .flatMap((issue) => issue.responses)
        .map((response) => [JSON.stringify(response), response]),
    ).values(),
  ];
  state.issues = state.issues.filter(
    (issue) => issue.id !== documentScopeIssueId || issue === first,
  );
  return true;
}

export async function settleWorkflow(
  ports: WorkflowPorts,
  task: Task,
  state: WorkflowState,
  participants: Participant[],
  commands: string[],
): Promise<void> {
  const save = () => ports.store.set(WORKFLOWS, state.taskId, state);
  let changed = consolidateDocumentScopeIssue(state);
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
    let observedArtifactRevision: string | undefined;
    let continuingReceiptRepair = false;
    try {
      const artifactRevision = await workspaceRevision(task.directories);
      if (progress.artifactRevision !== artifactRevision) {
        // Attribute observed writes conservatively, even if the status block is invalid.
        rememberImplementer(state, participant.id);
        save();
      }
      if (state.documentSource || node.documentPaths?.length)
        await assertDocumentSource(ports.store, task, state);
      const receiptOnly = ports
        .events(task.id)
        .some(
          (event) =>
            event.decision?.source === "rule" &&
            event.decision.reason === "receipt_repair" &&
            event.dispatches.some(
              (dispatch) =>
                dispatch.operationId === progress.operationId &&
                dispatch.nodeId === node.id &&
                dispatch.participantId === participant.id &&
                dispatch.state === "sent",
            ),
        );
      continuingReceiptRepair = receiptOnly;
      if (
        receiptOnly &&
        (!progress.repair ||
          receiptRepairRevision(progress.repair) !== progress.artifactRevision ||
          receiptRepairRevision(progress.repair) !== artifactRevision)
      )
        fail(
          "workflow_artifact_changed",
          "仅修复交接回执期间项目文件再次变化，不能复用原材料，需按新版本重新核对。",
        );
      // Validate original permissions before parsing: malformed receipts cannot hide writes.
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
      observedArtifactRevision = artifactRevision;
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
      bindEvidenceReferences(state, block, output.entry.id, {
        localEvidenceAliases: task.promptVersion === 3,
      });
      validateResponses(state, node, block);
      // Rejected receipts must not leak partially collected artifacts, issues or approvals.
      const accepted = structuredClone(state);
      for (const [index, path] of block.artifactRefs.entries()) {
        const artifact = await inspectArtifact(task, path).catch((error) => {
          if (safeError(error).code !== "workflow_artifact") throw error;
          const localNotes =
            task.promptVersion === 3 &&
            ["notes.md", "./notes.md"].includes(path) &&
            !safeError(error).message.includes("超出");
          rejectReceipt(
            "workflow_artifact",
            "回执产物路径无法对应当前任务的实际文件。",
            [
              {
                field: `artifactRefs[${index}]`,
                reason: localNotes ? "relative_notes_path" : "unavailable_artifact",
                actual: path,
                ...(localNotes
                  ? {
                      expected: `${handoffDirectory(ports.config?.stateDir ?? "", task.id, identity.operationId)}/notes.md`,
                    }
                  : {}),
              },
            ],
            localNotes,
          );
        });
        accepted.artifacts.push({
          ...artifact,
          reference: path,
          outputId: output.entry.id,
          artifactRevision,
        });
      }
      await captureConsensus(
        task,
        accepted,
        node,
        block,
        participant.id,
        output.entry.id,
        artifactRevision,
      );
      mergeStatus(accepted, node, block, output.entry.id, artifactRevision);
      const acceptedProgress = accepted.nodes[node.id];
      if (!acceptedProgress) fail("workflow_status", "节点已失效。");
      if (
        node.phase === "validating" &&
        accepted.plan.validation?.mode !== "not_run" &&
        !commands.length &&
        !accepted.evidence.some(
          (entry) =>
            entry.outputId === output.entry.id &&
            entry.source === "agent_review" &&
            entry.result === "passed",
        )
      ) {
        acceptedProgress.status = "blocked";
        acceptedProgress.error =
          "未取得独立 agent 实际重跑的证据，请补充检查结果或说明需用户处理的环境阻塞。";
      }
      if (node.phase === "reporting" && acceptedProgress.status === "completed")
        await publishReport(
          ports.config?.stateDir ?? "",
          task,
          accepted,
          block,
          output.entry.id,
          artifactRevision,
        );
      let conversation:
        | {
            taskId: string;
            participantId: string;
            outputId: string;
            text: string;
            notes: string;
            hash: string;
          }
        | undefined;
      if ("capturedNotes" in block) {
        const captured = block.capturedNotes as { text: string; hash: string };
        await publishNotes(ports.config?.stateDir ?? "", task.id, output.entry.id, captured.text);
        conversation = {
          taskId: task.id,
          participantId: participant.id,
          outputId: output.entry.id,
          text: output.entry.text.slice(0, 4000),
          notes: captured.text,
          hash: captured.hash,
        };
      }
      ports.store.transaction(() => {
        if (conversation)
          ports.store.set("workflow_conversation_evidence", output.entry.id, conversation);
        ports.store.set("workflow_status_blocks", output.entry.id, { taskId: task.id, block });
        ports.store.set(WORKFLOWS, accepted.taskId, accepted);
      });
      Object.assign(state, accepted);
      if (progress.repair)
        ports.logger.info("工作流交接回执已恢复", {
          event: "workflow.receipt_recovered",
          taskId: task.id,
          nodeId: node.id,
          outputId: output.entry.id,
          previousOutputId: progress.repair.outputId,
        });
    } catch (error) {
      progress.status = "blocked";
      progress.outputId = output.entry.id;
      progress.error = safeError(error).message;
      progress.repair = await recordWorkflowRejection({
        store: ports.store,
        stateDir: ports.config?.stateDir ?? "",
        task,
        state,
        node,
        progress,
        participantId: participant.id,
        output: output.entry,
        error,
        observedArtifactRevision,
        continuingReceiptRepair,
      });
      ports.logger.warn("工作流交接回执未通过校验", {
        event: "workflow.receipt_rejected",
        taskId: task.id,
        nodeId: node.id,
        outputId: output.entry.id,
        code: progress.repair.code,
        fields: progress.repair.details.map((detail) => detail.field),
        recoverable: progress.repair.recoverable,
        repeated: progress.repair.repeated,
      });
      if (safeError(error).code === "workflow_document_scope") {
        state.stall.awaitingUser = true;
        let issue = state.issues.find((entry) => entry.id === documentScopeIssueId);
        if (!issue) {
          issue = {
            id: documentScopeIssueId,
            description: progress.error,
            status: "open",
            blocking: true,
            evidenceRefs: [],
            raisedBy: participant.id,
            responses: [],
          };
          state.issues.push(issue);
        }
        issue.description = progress.error;
        issue.status = "open";
        issue.blocking = true;
        issue.evidenceRefs = [...new Set([...issue.evidenceRefs, output.entry.id])];
        issue.responses.push({ outputId: output.entry.id, summary: progress.error });
      }
      if (!state.consumedOutputs.includes(output.entry.id))
        state.consumedOutputs.push(output.entry.id);
    }
    changed = true;
  }
  changed = (await backfillReceiptRecovery(ports, task, state)) || changed;
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

/** Upgrade a rejected v3 output into repair context, never into an accepted completion. */
export async function backfillReceiptRecovery(
  ports: WorkflowPorts,
  task: Task,
  state: WorkflowState,
): Promise<boolean> {
  if (task.promptVersion !== 3) return false;
  let changed = false;
  for (const node of state.plan.nodes) {
    const progress = state.nodes[node.id];
    if (
      progress?.status !== "blocked" ||
      progress.repair ||
      !progress.operationId ||
      !progress.inputRevision ||
      !progress.outputId ||
      !progress.participantId ||
      ports.store.get("workflow_status_blocks", progress.outputId)
    )
      continue;
    const delivery = ports.store.get<InputDelivery>("input_deliveries", progress.operationId);
    const output = ports.outputs(task.id).find((entry) => entry.entry.id === progress.outputId);
    if (
      !delivery ||
      delivery.taskId !== task.id ||
      delivery.participantId !== progress.participantId ||
      !output ||
      output.participantId !== progress.participantId ||
      (output.sequence ?? 0) <= delivery.outputSequence
    )
      continue;
    let failure: unknown;
    let observedArtifactRevision: string | undefined;
    try {
      const events = ports.events(task.id);
      const event = events.find((entry) =>
        entry.dispatches.some(
          (dispatch) =>
            dispatch.operationId === progress.operationId &&
            dispatch.nodeId === node.id &&
            dispatch.participantId === progress.participantId &&
            dispatch.state === "sent" &&
            dispatch.inputRevision === progress.inputRevision,
        ),
      );
      if (
        !event ||
        event.workflow?.planVersion !== state.plan.version ||
        progress.inputRevision !== ports.revision(task) ||
        !state.consumedOutputs.includes(output.entry.id)
      )
        fail("workflow_superseded", "历史拒收输出不匹配当前计划或用户修订，不能自动补回执。");
      if (
        !selectWorkflowOutput(
          [output],
          delivery,
          events.flatMap((entry) => entry.dispatches),
          ports.store,
          { stateDir: ports.config?.stateDir ?? "", taskId: task.id },
        )
      )
        fail("workflow_superseded", "历史输出属于其他委派，不能用于当前恢复。");
      const artifactRevision = await workspaceRevision(task.directories);
      if (artifactRevision !== progress.artifactRevision)
        fail("workflow_artifact_changed", "历史回执对应的源码版本已变化，不能只修回执。");
      if (state.documentSource || node.documentPaths?.length)
        await assertDocumentSource(ports.store, task, state);
      if (
        node.documentPaths?.length &&
        (!progress.sourceRevision ||
          progress.sourceRevision !==
            (await workspaceRevision(task.directories, node.documentPaths)))
      )
        fail("workflow_document_scope", "历史文档回执的源码边界已变化。");
      observedArtifactRevision = artifactRevision;
      const block = await readHandoff(
        ports.config?.stateDir ?? "",
        task,
        state,
        node,
        {
          nodeId: node.id,
          operationId: progress.operationId,
          inputRevision: progress.inputRevision,
        },
        output.entry.text,
      );
      bindEvidenceReferences(state, block, output.entry.id, { localEvidenceAliases: true });
      validateResponses(state, node, block);
      for (const path of block.artifactRefs) await inspectArtifact(task, path);
      await captureConsensus(
        task,
        structuredClone(state),
        node,
        block,
        progress.participantId,
        output.entry.id,
        progress.artifactRevision ?? "",
      );
      rejectReceipt(
        "workflow_status",
        "历史回执尚未被接纳，请用新委派的归属字段重新提交已有材料。",
        [{ field: "$", reason: "historical_unaccepted" }],
      );
    } catch (error) {
      failure = error;
    }
    progress.repair = await recordWorkflowRejection({
      store: ports.store,
      stateDir: ports.config?.stateDir ?? "",
      task,
      state,
      node,
      progress,
      participantId: progress.participantId,
      output: output.entry,
      error: failure,
      observedArtifactRevision,
    });
    ports.logger.info("历史拒收回执已建立恢复记录", {
      event: "workflow.receipt_recovery_backfilled",
      taskId: task.id,
      nodeId: node.id,
      outputId: output.entry.id,
      code: progress.repair.code,
      recoverable: progress.repair.recoverable,
      repeated: progress.repair.repeated,
    });
    changed = true;
  }
  return changed;
}
