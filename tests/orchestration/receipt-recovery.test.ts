import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { OrchestrationEvent, SettledTaskOutput } from "../../src/app/task-orchestrator.js";
import { stableId } from "../../src/core/ids.js";
import { boardDirectory } from "../../src/orchestration/board.js";
import { workflowCandidates } from "../../src/orchestration/candidates.js";
import { addDocumentDelivery } from "../../src/orchestration/document-delivery.js";
import { prepareDocumentSource } from "../../src/orchestration/document-source.js";
import { handoffDirectory, prepareHandoff } from "../../src/orchestration/handoff.js";
import { ReceiptError } from "../../src/orchestration/receipt-diagnostics.js";
import {
  WORKFLOW_RECOVERY,
  type WorkflowRecoveryMaterial,
} from "../../src/orchestration/receipt-recovery.js";
import type { WorkflowPorts } from "../../src/orchestration/runner.js";
import { receiptRepairRule } from "../../src/orchestration/selection-context.js";
import { backfillReceiptRecovery, settleWorkflow } from "../../src/orchestration/settlement.js";
import { workflowState } from "../../src/orchestration/state.js";
import { bindEvidenceReferences, parseStatusBlock } from "../../src/orchestration/status-block.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import type { InputDelivery } from "../../src/tasks/input-delivery.js";
import { logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function fixture(nodeId?: string, mode?: "development" | "document") {
  const h = setup();
  const repo = join(h.directory, "repo");
  await mkdir(repo);
  await writeFile(join(repo, "source.txt"), "unchanged source");
  await h.catalog.save({ name: "recovery", directories: [repo], agent: "codex" });
  const created = await h.service.create(actor, {
    ...discussion,
    project: "recovery",
    ...(mode
      ? {
          kind: mode === "development" ? ("development" as const) : ("discussion" as const),
          requirements: mode === "development" ? "实现 source.txt 修改" : "讨论后保存 DESIGN.md。",
        }
      : {}),
  });
  const task = {
    ...created,
    promptVersion: 3 as const,
    boardDirectory: boardDirectory(h.directory, created.id),
  };
  const state = workflowState(h.store, task, "base-revision");
  if (mode === "document") {
    state.plan.documentDelivery = { paths: ["DESIGN.md"], userRequest: task.requirements };
    addDocumentDelivery(state.plan);
    state.documentSource = await prepareDocumentSource(h.store, task, state);
  }
  const node = nodeId ? state.plan.nodes.find((entry) => entry.id === nodeId) : state.plan.nodes[0];
  assert.ok(node);
  const registered = h.service.records.participants(task)[0];
  assert.ok(registered);
  const participant = { ...registered, status: "idle" as const };
  const events: OrchestrationEvent[] = [];
  const outputs: SettledTaskOutput[] = [];
  const logged: Array<Record<string, unknown> | undefined> = [];
  const ports = {
    store: h.store,
    config: h.config,
    events: () => events,
    outputs: () => outputs,
    revision: () => "revision",
    logger: {
      ...logger,
      info: (_: string, fields?: Record<string, unknown>) => logged.push(fields),
      warn: (_: string, fields?: Record<string, unknown>) => logged.push(fields),
    },
  } as unknown as WorkflowPorts;
  const dispatch = async (
    operationId: string,
    patch: Record<string, unknown> = {},
    cite = true,
    receiptOnly = false,
  ) => {
    const identity = { nodeId: node.id, operationId, inputRevision: "revision" };
    const artifactRevision = await workspaceRevision(task.directories);
    const sourceRevision = node.documentPaths?.length
      ? await workspaceRevision(task.directories, node.documentPaths)
      : undefined;
    state.nodes[node.id] = {
      status: "dispatched",
      attempt: (state.nodes[node.id]?.attempt ?? 0) + 1,
      ...identity,
      participantId: participant.id,
      artifactRevision,
      sourceRevision,
      repair: state.nodes[node.id]?.repair,
    };
    await prepareHandoff(h.directory, task, state, node, identity, []);
    const directory = handoffDirectory(h.directory, task.id, operationId);
    const request = JSON.parse(await readFile(join(directory, "request.json"), "utf8"));
    await writeFile(
      join(directory, "notes.md"),
      "# 真实评审\n接受已有方向，提出分页与锚点的具体修改。\n",
    );
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify({ ...request, summary: "已逐项回应", ...patch }),
    );
    const outputId = `output-${outputs.length + 1}`;
    const entry: SettledTaskOutput = {
      taskId: task.id,
      participantId: participant.id,
      sequence: outputs.length + 1,
      observedAt: new Date().toISOString(),
      entry: {
        id: outputId,
        role: "assistant",
        final: true,
        text: cite
          ? `意见见 ${join(directory, "notes.md")}`
          : "意见已写到本轮 notes.md，请下一位回应。",
      },
    };
    const delivery: InputDelivery = {
      taskId: task.id,
      participantId: participant.id,
      operationId,
      fingerprint: operationId,
      execution: { cwd: repo, kind: participant.kind, paneId: "pane", workspaceId: "workspace" },
      prompt: "brief",
      receipt: "receipt",
      initial: false,
      discussionWasPaused: false,
      outputSequence: outputs.length,
    };
    h.store.set("input_deliveries", operationId, delivery);
    events.push({
      id: operationId,
      taskId: task.id,
      trigger: "ready",
      outputIds: [],
      userRevision: "revision",
      state: "done",
      attempts: 1,
      ...(receiptOnly
        ? {
            decision: {
              action: "continue" as const,
              source: "rule" as const,
              reason: "receipt_repair",
            },
          }
        : {}),
      dispatches: [
        {
          ...identity,
          artifactRevision,
          sourceRevision,
          participantId: participant.id,
          state: "sent",
        },
      ],
      workflow: {
        candidate: {
          id: "dispatch",
          kind: "dispatch",
          description: "current",
          assignments: [{ nodeId: node.id, participantId: participant.id }],
        },
        planVersion: state.plan.version,
        applied: true,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    outputs.push(entry);
    return { directory, outputId, identity, entry };
  };
  const settle = () => settleWorkflow(ports, task, state, [participant], []);
  return {
    ...h,
    repo,
    task,
    state,
    node,
    participant,
    ports,
    outputs,
    events,
    logged,
    dispatch,
    settle,
  };
}

for (const defect of ["missing_file", "missing_heading", "empty_section", "duplicate_heading"]) {
  test(`a reporting ${defect} is repaired by the same participant without weakening required sections`, async () => {
    const h = await fixture("report");
    try {
      const required = [...h.state.plan.deliveryRequirements];
      const title = required[0];
      assert.ok(title);
      const report = required.map((heading) => `## ${heading}\n已核对的实际结论。`).join("\n\n");
      const first = await h.dispatch("report-original");
      if (defect !== "missing_file") {
        const malformed =
          defect === "missing_heading"
            ? required
                .slice(1)
                .map((heading) => `## ${heading}\n已核对的实际结论。`)
                .join("\n\n")
            : defect === "empty_section"
              ? report.replace(`## ${title}\n已核对的实际结论。`, `## ${title}\n`)
              : `${report}\n\n## ${title}\n重复结论。`;
        await writeFile(join(first.directory, "report.md"), malformed);
      }
      await h.settle();
      const progress = h.state.nodes[h.node.id];
      assert.ok(progress);
      const repair = progress.repair;
      assert.ok(repair?.recoverable && repair.notes);
      assert.equal(progress.status, "blocked");
      assert.equal(repair.details[0]?.reason, defect);
      assert.equal(
        repair.details[0]?.field,
        defect === "missing_file" ? "report.md" : `report.md.sections[${JSON.stringify(title)}]`,
      );
      assert.equal(h.state.report, undefined);
      assert.equal(h.store.get("workflow_status_blocks", first.outputId), undefined);
      assert.equal(h.store.get("workflow_conversation_evidence", first.outputId), undefined);
      const available = {
        ...h.participant,
        started: true,
        execution: {
          cwd: h.repo,
          kind: h.participant.kind,
          paneId: "pane",
          workspaceId: "workspace",
        },
      };
      const candidates = workflowCandidates(h.task, h.state, [available], [], false);
      const rule = receiptRepairRule(
        h.state,
        candidates,
        "revision",
        await workspaceRevision(h.task.directories),
      );
      assert.ok(rule);
      assert.equal(rule.reason, "receipt_repair");
      assert.equal(rule.noProgress, false);
      assert.deepEqual(candidates.find((entry) => entry.id === rule.candidateId)?.assignments, [
        { nodeId: h.node.id, participantId: h.participant.id },
      ]);
      const next = await h.dispatch("report-repaired");
      const brief = await readFile(join(next.directory, "brief.md"), "utf8");
      assert.match(brief, /本次仅修复交接与回执/);
      assert.ok(brief.includes(defect));
      assert.equal(
        await readFile(join(next.directory, "prior-notes.md"), "utf8"),
        await readFile(join(first.directory, "notes.md"), "utf8"),
      );
      await writeFile(join(next.directory, "report.md"), report);
      await h.settle();
      assert.equal(h.state.nodes[h.node.id]?.status, "completed");
      assert.equal(h.state.nodes[h.node.id]?.repair, undefined);
      assert.equal(
        h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.report?.outputId,
        next.outputId,
      );
      assert.deepEqual(h.state.plan.deliveryRequirements, required);
      const block = h.store.get<{ block: { reportSections: Record<string, string> } }>(
        "workflow_status_blocks",
        next.outputId,
      );
      assert.deepEqual(Object.keys(block?.block.reportSections ?? {}), required);
    } finally {
      h.close();
    }
  });
}

for (const defect of ["symlink", "oversized_file"]) {
  test(`an unsafe ${defect} report is never eligible for receipt-only reuse`, async () => {
    const h = await fixture("report");
    try {
      const first = await h.dispatch("unsafe-report");
      const report = join(first.directory, "report.md");
      if (defect === "symlink") await symlink(join(h.repo, "source.txt"), report);
      else await writeFile(report, "x".repeat(1024 * 1024 + 1));
      await h.settle();
      const repair = h.state.nodes[h.node.id]?.repair;
      assert.equal(repair?.recoverable, false);
      assert.equal(repair?.notes, undefined);
      assert.equal(repair?.details[0]?.field, "report.md");
      assert.equal(h.state.report, undefined);
      assert.equal(h.store.get("workflow_status_blocks", first.outputId), undefined);
      assert.equal(
        receiptRepairRule(
          h.state,
          [
            {
              id: "repair-report",
              kind: "rework",
              description: "same participant",
              assignments: [{ nodeId: h.node.id, participantId: h.participant.id }],
            },
          ],
          "revision",
          await workspaceRevision(h.task.directories),
        ),
        undefined,
      );
    } finally {
      h.close();
    }
  });
}

function repairCandidates(h: Awaited<ReturnType<typeof fixture>>) {
  const participant = {
    ...h.participant,
    started: true,
    execution: {
      cwd: h.repo,
      kind: h.participant.kind,
      paneId: "pane",
      workspaceId: "workspace",
    },
  };
  return workflowCandidates(h.task, h.state, [participant], [], false);
}

for (const mode of ["development", "document"] as const) {
  test(`a legitimate ${mode} write binds receipt repair to its output revision and reuses the same author's notes`, async () => {
    const h = await fixture(mode === "development" ? "implement" : "document", mode);
    try {
      const first = await h.dispatch("write-with-bad-receipt", {
        evidence: [{ result: "not_run" }],
      });
      const before = h.state.nodes[h.node.id]?.artifactRevision;
      const path = join(h.repo, mode === "development" ? "source.txt" : "DESIGN.md");
      await writeFile(path, "legitimate completed work\n");
      const after = await workspaceRevision(h.task.directories);
      assert.notEqual(before, after);
      await h.settle();
      const progress = h.state.nodes[h.node.id];
      const repair = progress?.repair;
      assert.ok(repair?.recoverable && repair.notes);
      assert.equal(progress?.artifactRevision, before, "dispatch source attribution is retained");
      assert.equal(repair.artifactRevision, before);
      assert.equal(repair.observedArtifactRevision, after);
      assert.equal(h.store.get("workflow_status_blocks", first.outputId), undefined);
      const candidates = repairCandidates(h);
      const rule = receiptRepairRule(h.state, candidates, "revision", after);
      assert.ok(rule);
      assert.equal(rule.reason, "receipt_repair");
      assert.deepEqual(
        candidates.find((candidate) => candidate.id === rule.candidateId)?.assignments,
        [{ nodeId: h.node.id, participantId: h.participant.id }],
      );
      const next = await h.dispatch("only-fix-receipt", {}, true, true);
      assert.match(
        await readFile(join(next.directory, "brief.md"), "utf8"),
        /本次仅修复交接与回执/,
      );
      assert.equal(
        await readFile(join(next.directory, "prior-notes.md"), "utf8"),
        await readFile(join(first.directory, "notes.md"), "utf8"),
      );
      await h.settle();
      assert.equal(h.state.nodes[h.node.id]?.status, "completed");
      assert.equal(h.state.nodes[h.node.id]?.repair, undefined);
      assert.equal(h.state.nodes[h.node.id]?.artifactRevision, after);
      assert.equal(await readFile(path, "utf8"), "legitimate completed work\n");
      assert.ok(h.store.get("workflow_status_blocks", next.outputId));
    } finally {
      h.close();
    }
  });
}

test("the same failed receipt after a legitimate write counts consecutive errors using the output revision", async () => {
  const h = await fixture("implement", "development");
  try {
    const malformed = { evidence: [{ result: "not_run" }] };
    await h.dispatch("write-first", malformed);
    await writeFile(join(h.repo, "source.txt"), "implemented source\n");
    await h.settle();
    const initial = h.state.nodes[h.node.id]?.repair;
    assert.ok(initial?.recoverable);
    assert.equal(initial.repeated, 1);
    await h.dispatch("repair-second", malformed, true, true);
    await h.settle();
    const repeated = h.state.nodes[h.node.id]?.repair;
    assert.ok(repeated?.recoverable);
    assert.notEqual(repeated.artifactRevision, initial.artifactRevision);
    assert.equal(repeated.observedArtifactRevision, initial.observedArtifactRevision);
    assert.equal(repeated.repeated, 2);
    assert.equal(
      receiptRepairRule(
        h.state,
        repairCandidates(h),
        "revision",
        await workspaceRevision(h.task.directories),
      )?.noProgress,
      true,
    );
  } finally {
    h.close();
  }
});

test("a new source change after rejected write prevents both rule selection and prior-notes reuse", async () => {
  const h = await fixture("implement", "development");
  try {
    await h.dispatch("write-first", { evidence: [{ result: "not_run" }] });
    await writeFile(join(h.repo, "source.txt"), "implemented source\n");
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.repair?.recoverable, true);
    await writeFile(join(h.repo, "source.txt"), "subsequent unrelated modification\n");
    assert.equal(
      receiptRepairRule(
        h.state,
        repairCandidates(h),
        "revision",
        await workspaceRevision(h.task.directories),
      ),
      undefined,
    );
    const next = await h.dispatch("normal-rework-after-change");
    assert.doesNotMatch(
      await readFile(join(next.directory, "brief.md"), "utf8"),
      /本次仅修复交接与回执/,
    );
    await assert.rejects(readFile(join(next.directory, "prior-notes.md")), { code: "ENOENT" });
    assert.deepEqual(h.state.evidence, []);
    await writeFile(join(h.repo, "source.txt"), "legitimate new business rework\n");
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.status, "completed");
    assert.ok(h.store.get("workflow_status_blocks", next.outputId));
  } finally {
    h.close();
  }
});

test("a rule-selected receipt-only repair cannot accept a second source write", async () => {
  const h = await fixture("implement", "development");
  try {
    await h.dispatch("write-first", { evidence: [{ result: "not_run" }] });
    await writeFile(join(h.repo, "source.txt"), "initial implementation\n");
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.repair?.recoverable, true);
    const second = await h.dispatch("receipt-only-repair", {}, true, true);
    await writeFile(join(h.repo, "source.txt"), "unexpected write during receipt repair\n");
    await h.settle();
    const repair = h.state.nodes[h.node.id]?.repair;
    assert.equal(repair?.code, "workflow_artifact_changed");
    assert.equal(repair?.recoverable, false);
    assert.equal(repair?.observedArtifactRevision, undefined);
    assert.equal(repair?.notes, undefined);
    assert.equal(h.store.get("workflow_status_blocks", second.outputId), undefined);
    assert.equal(h.store.get("workflow_conversation_evidence", second.outputId), undefined);
  } finally {
    h.close();
  }
});

for (const mode of ["readonly", "document-scope", "document-node-scope"] as const) {
  test(`a malformed receipt cannot hide a ${mode} source violation`, async () => {
    const h = await fixture(
      mode === "readonly" ? undefined : "document",
      mode === "readonly" ? undefined : "document",
    );
    try {
      const first = await h.dispatch("source-violation", { evidence: [{ result: "not_run" }] });
      if (mode === "document-node-scope") {
        // Globally authorized documents can still be outside this node's narrower grant.
        assert.ok(h.state.plan.documentDelivery && h.state.documentSource);
        h.state.plan.documentDelivery.paths.push("OTHER.md");
        h.state.documentSource.paths.push("OTHER.md");
        await writeFile(join(h.repo, "OTHER.md"), "outside the current node's grant\n");
      } else await writeFile(join(h.repo, "source.txt"), "unauthorized change\n");
      await h.settle();
      const repair = h.state.nodes[h.node.id]?.repair;
      assert.equal(
        repair?.code,
        mode === "readonly" ? "workflow_artifact_changed" : "workflow_document_scope",
      );
      assert.equal(repair?.recoverable, false);
      assert.equal(repair?.observedArtifactRevision, undefined);
      assert.equal(repair?.notes, undefined);
      assert.equal(h.store.get("workflow_status_blocks", first.outputId), undefined);
      assert.deepEqual(h.state.evidence, []);
    } finally {
      h.close();
    }
  });
}

test("historical writes without a frozen output revision cannot borrow the current source for receipt-only recovery", async () => {
  const h = await fixture("implement", "development");
  try {
    const first = await h.dispatch("historical-write", { evidence: [{ result: "not_run" }] });
    await writeFile(join(h.repo, "source.txt"), "historical source or later modification\n");
    const progress = h.state.nodes[h.node.id];
    assert.ok(progress);
    progress.status = "blocked";
    progress.outputId = first.outputId;
    progress.error = "旧版只记录回执错误";
    h.state.consumedOutputs.push(first.outputId);
    assert.equal(await backfillReceiptRecovery(h.ports, h.task, h.state), true);
    assert.equal(progress.repair?.code, "workflow_artifact_changed");
    assert.equal(progress.repair?.recoverable, false);
    assert.equal(progress.repair?.observedArtifactRevision, undefined);
    assert.equal(progress.repair?.notes, undefined);
    assert.equal(h.store.get("workflow_status_blocks", first.outputId), undefined);
  } finally {
    h.close();
  }
});

test("missing natural path preserves a bounded unverified snapshot and repairs only the handoff", async () => {
  const h = await fixture();
  try {
    const first = await h.dispatch("first", {}, false);
    await h.settle();
    const repair = h.state.nodes[h.node.id]?.repair;
    assert.ok(repair?.recoverable && repair.notes);
    assert.equal(repair.details[0]?.field, "output.notesPath");
    assert.equal(repair.repeated, 1);
    const material = h.store.get<WorkflowRecoveryMaterial>(WORKFLOW_RECOVERY, repair.snapshotId);
    assert.equal(material?.validation, "unverified");
    assert.match(material?.notes ?? "", /真实评审/);
    assert.deepEqual(h.state.issues, []);
    assert.deepEqual(h.state.evidence, []);
    assert.deepEqual(h.state.artifacts, []);
    assert.equal(h.store.get("workflow_conversation_evidence", first.outputId), undefined);
    const board = await readFile(join(h.task.boardDirectory, "board.md"), "utf8");
    assert.match(board, /未验证恢复材料/);
    assert.doesNotMatch(board, /outputs\/output-1\.notes\.md/);
    const next = await h.dispatch("second");
    assert.equal(await readFile(join(next.directory, "prior-notes.md"), "utf8"), material?.notes);
    const brief = await readFile(join(next.directory, "brief.md"), "utf8");
    assert.match(brief, /本次仅修复交接与回执/);
    assert.match(brief, /不重做整轮设计/);
    assert.match(brief, /output.notesPath/);
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.status, "completed");
    assert.equal(h.state.nodes[h.node.id]?.repair, undefined);
    assert.ok(h.store.get("workflow_conversation_evidence", next.outputId));
    assert.deepEqual(
      h.logged.map((entry) => entry?.event),
      ["workflow.receipt_rejected", "workflow.receipt_recovered"],
    );
    assert.doesNotMatch(JSON.stringify(h.logged), /真实评审|接受已有方向/);
  } finally {
    h.close();
  }
});

test("the live E-2 alias is mapped to this output's stable evidence id without trusting external refs", async () => {
  const h = await fixture();
  try {
    const first = await h.dispatch("alias", {
      issues: [
        {
          id: "D-005",
          description: "最终文档由后续节点落盘",
          status: "deferred",
          blocking: false,
          evidenceRefs: ["E-2"],
        },
      ],
      evidence: [{ id: "E-2", description: "项目文档尚未创建；本轮仅讨论", result: "not_run" }],
    });
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.status, "completed");
    assert.deepEqual(h.state.issues[0]?.evidenceRefs, [stableId(first.outputId, "0")]);
    assert.equal(h.state.evidence[0]?.id, stableId(first.outputId, "0"));
    assert.match(
      await readFile(join(h.task.boardDirectory, "board.md"), "utf8"),
      new RegExp(stableId(first.outputId, "0")),
    );
    const invalid = await h.dispatch("foreign", {
      issues: [
        {
          id: "D-005",
          description: "foreign",
          status: "open",
          blocking: false,
          evidenceRefs: ["other-task-output"],
        },
      ],
    });
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.repair?.code, "workflow_evidence");
    assert.equal(h.state.nodes[h.node.id]?.repair?.details[0]?.actual, "other-task-output");
    assert.equal(h.state.issues[0]?.status, "deferred");
    assert.equal(h.store.get("workflow_status_blocks", invalid.outputId), undefined);
  } finally {
    h.close();
  }
});

test("field diagnostics identify the live malformed schema and reject duplicate/local alias collisions", async () => {
  const h = await fixture();
  try {
    const dispatched = await h.dispatch("bad-shape", {
      issues: [{ id: "D-001", status: "open", summary: "not description" }],
      evidence: [{ kind: "self_report", status: "passed", summary: "not description/result" }],
    });
    await h.settle();
    const fields = h.state.nodes[h.node.id]?.repair?.details.map((entry) => entry.field);
    assert.deepEqual(fields, [
      "issues[0].description",
      "issues[0].blocking",
      "issues[0].evidenceRefs",
      "evidence[0].description",
      "evidence[0].result",
    ]);
    const base = {
      protocolVersion: 1,
      ...dispatched.identity,
      status: "completed",
      summary: "done",
      issues: [],
      artifactRefs: [],
      evidence: [],
      blockers: [],
    };
    const parse = (evidence: unknown) =>
      parseStatusBlock(
        `\`\`\`myrix-status\n${JSON.stringify({ ...base, evidence })}\n\`\`\``,
        dispatched.identity,
        { localEvidenceAliases: true },
      );
    const evidence = { id: "E-1", description: "local only", result: "not_run" };
    assert.throws(() => parse([evidence, evidence]), ReceiptError);
    assert.throws(() => parse([{ ...evidence, id: "foreign-output" }]), ReceiptError);
    assert.throws(() => parse([{ ...evidence, id: stableId("other-task") }]), ReceiptError);
    const block = parse([evidence]);
    h.state.artifacts.push({ path: "E-1", hash: "hash", outputId: "old", artifactRevision: "old" });
    assert.throws(
      () => bindEvidenceReferences(h.state, block, "new", { localEvidenceAliases: true }),
      /别名重复或.*冲突/,
    );
  } finally {
    h.close();
  }
});

test("consecutive unchanged protocol failures are counted across dispatches and rejected evidence remains isolated", async () => {
  const h = await fixture();
  try {
    await h.dispatch("first", {}, false);
    await h.settle();
    const first = h.state.nodes[h.node.id]?.repair;
    await h.dispatch("second", {}, false);
    await h.settle();
    const second = h.state.nodes[h.node.id]?.repair;
    assert.equal(second?.fingerprint, first?.fingerprint);
    assert.equal(second?.repeated, 2);
    await h.dispatch("third", { evidence: [{ description: "new defect", result: "unknown" }] });
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.repair?.repeated, 1);
    assert.equal(h.store.list(WORKFLOW_RECOVERY).length, 3);
    assert.deepEqual(h.state.artifacts, []);
  } finally {
    h.close();
  }
});

test("a successful repair resets the same defect counter before a later business rework", async () => {
  const h = await fixture();
  try {
    await h.dispatch("first-defect", {}, false);
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.repair?.repeated, 1);
    await h.dispatch("accepted-repair");
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.status, "completed");
    assert.equal(h.state.nodes[h.node.id]?.repair, undefined);
    await h.dispatch("later-business-round", {}, false);
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.repair?.repeated, 1);
    assert.equal(h.store.list(WORKFLOW_RECOVERY).length, 2);
  } finally {
    h.close();
  }
});

for (const mode of ["symlink", "oversized", "identity"] as const)
  test(`unsafe or foreign ${mode} receipt cannot authorize automatic notes reuse`, async () => {
    const h = await fixture();
    try {
      const entry = await h.dispatch("unsafe");
      if (mode === "symlink") {
        const outside = join(h.directory, "outside.txt");
        await writeFile(outside, "private outside content");
        await rm(join(entry.directory, "notes.md"));
        await symlink(outside, join(entry.directory, "notes.md"));
      } else if (mode === "oversized") {
        await writeFile(join(entry.directory, "notes.md"), "x".repeat(1024 * 1024 + 1));
      } else {
        const result = JSON.parse(await readFile(join(entry.directory, "result.json"), "utf8"));
        await writeFile(
          join(entry.directory, "result.json"),
          JSON.stringify({ ...result, operationId: "foreign-operation" }),
        );
      }
      await h.settle();
      const repair = h.state.nodes[h.node.id]?.repair;
      assert.equal(repair?.recoverable, false);
      assert.equal(repair?.notes, undefined);
      assert.ok(repair);
      const captured = h.store.get<WorkflowRecoveryMaterial>(WORKFLOW_RECOVERY, repair.snapshotId);
      assert.doesNotMatch(captured?.notes ?? "", /private outside content/);
      assert.deepEqual(h.state.artifacts, []);
    } finally {
      h.close();
    }
  });

test("late validation rejects a receipt without partially accepting its artifacts", async () => {
  const h = await fixture();
  try {
    h.state.plan.consensus = { participantIds: h.task.participantIds };
    const entry = await h.dispatch("foreign-response", {
      responses: [{ outputId: "outside-task", comment: "pretend response" }],
    });
    const receipt = JSON.parse(await readFile(join(entry.directory, "result.json"), "utf8"));
    receipt.artifactRefs = [join(entry.directory, "notes.md")];
    await writeFile(join(entry.directory, "result.json"), JSON.stringify(receipt));
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.repair?.code, "workflow_response");
    assert.deepEqual(h.state.artifacts, []);
    assert.deepEqual(h.state.evidence, []);
    assert.equal(h.state.consensusApprovals, undefined);
    assert.equal(h.store.get("workflow_status_blocks", entry.outputId), undefined);
  } finally {
    h.close();
  }
});

test("a refused consensus after artifact collection does not persist any accepted artifact", async () => {
  const h = await fixture();
  try {
    h.state.plan.consensus = { participantIds: h.task.participantIds };
    h.node.consensus = true;
    h.node.participantId = h.participant.id;
    const entry = await h.dispatch("refused-consensus");
    const receipt = JSON.parse(await readFile(join(entry.directory, "result.json"), "utf8"));
    receipt.artifactRefs = [join(entry.directory, "notes.md")];
    await writeFile(join(entry.directory, "result.json"), JSON.stringify(receipt));
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.repair?.code, "workflow_consensus");
    assert.equal(h.state.nodes[h.node.id]?.repair?.recoverable, false);
    assert.deepEqual(h.state.artifacts, []);
    assert.equal(h.state.consensusApprovals, undefined);
    assert.equal(h.store.get("workflow_status_blocks", entry.outputId), undefined);
  } finally {
    h.close();
  }
});

test("relative notes paths receive a precise repair while missing delivery artifacts stay unaccepted", async () => {
  const h = await fixture();
  try {
    const entry = await h.dispatch("relative-notes", { artifactRefs: ["notes.md"] });
    await h.settle();
    const repair = h.state.nodes[h.node.id]?.repair;
    assert.equal(repair?.recoverable, true);
    assert.equal(repair?.details[0]?.field, "artifactRefs[0]");
    assert.equal(repair?.details[0]?.expected, join(entry.directory, "notes.md"));
    await h.dispatch("missing-doc", { artifactRefs: ["docs/UNWRITTEN.md"] });
    await h.settle();
    assert.equal(h.state.nodes[h.node.id]?.repair?.recoverable, false);
    assert.deepEqual(h.state.artifacts, []);
  } finally {
    h.close();
  }
});

test("upgrading a consumed 0.3.22 rejection backfills repair but never marks its old output accepted", async () => {
  const h = await fixture();
  try {
    const entry = await h.dispatch("old-E2", {
      issues: [
        {
          id: "D-005",
          description: "document deferred",
          status: "deferred",
          blocking: false,
          evidenceRefs: ["E-2"],
        },
      ],
      evidence: [{ id: "E-2", description: "document absent", result: "not_run" }],
    });
    const progress = h.state.nodes[h.node.id];
    assert.ok(progress);
    Object.assign(progress, {
      status: "blocked",
      outputId: entry.outputId,
      error: "问题引用了不存在或不属于本任务的证据。",
    });
    h.state.consumedOutputs.push(entry.outputId);
    h.state.assistanceWait = {
      eventId: "wait",
      fingerprint: "unchanged",
      reason: "low_confidence",
    };
    assert.equal(await backfillReceiptRecovery(h.ports, h.task, h.state), true);
    assert.equal(h.state.nodes[h.node.id]?.repair?.details[0]?.reason, "historical_unaccepted");
    assert.equal(h.state.nodes[h.node.id]?.repair?.recoverable, true);
    assert.equal(h.state.nodes[h.node.id]?.status, "blocked");
    assert.deepEqual(h.state.evidence, []);
    assert.equal(h.store.get("workflow_status_blocks", entry.outputId), undefined);
    assert.equal(await backfillReceiptRecovery(h.ports, h.task, h.state), false);
    assert.equal(h.store.list(WORKFLOW_RECOVERY).length, 1);
  } finally {
    h.close();
  }
});

test("missing output path cannot mask foreign receipt identity during recovery", async () => {
  const h = await fixture();
  try {
    await h.dispatch("current", { operationId: "foreign-operation" }, false);
    await h.settle();
    const repair = h.state.nodes[h.node.id]?.repair;
    assert.ok(repair);
    assert.equal(repair.recoverable, false);
    assert.equal(repair.notes, undefined);
    const material = h.store.get<WorkflowRecoveryMaterial>(WORKFLOW_RECOVERY, repair.snapshotId);
    assert.equal(material?.receiptIdentityMatched, false);
    assert.equal(material?.validation, "unverified");
    assert.deepEqual(h.state.evidence, []);
  } finally {
    h.close();
  }
});

test("v2 retains unused extra evidence IDs without granting alias reference authority", async () => {
  const h = await fixture();
  try {
    const expected = { nodeId: h.node.id, operationId: "legacy", inputRevision: "revision" };
    for (const id of ["evidence-1", "E-1", 42, null]) {
      const value = {
        protocolVersion: 1,
        ...expected,
        status: "completed",
        summary: "legacy review",
        issues: [],
        artifactRefs: [],
        evidence: [{ id, description: "read source", result: "passed" }],
        blockers: [],
      };
      const block = parseStatusBlock(
        `\`\`\`myrix-status\n${JSON.stringify(value)}\n\`\`\``,
        expected,
      );
      assert.doesNotThrow(() => bindEvidenceReferences(h.state, block, "legacy-output"));
      block.issues.push({
        id: "D-1",
        description: "unregistered reference",
        status: "open",
        blocking: false,
        evidenceRefs: [String(id)],
      });
      assert.throws(() => bindEvidenceReferences(h.state, block, "legacy-output"), {
        code: "workflow_evidence",
      });
    }
  } finally {
    h.close();
  }
});

test("historical repair refuses changed user revisions, plans and source snapshots", async () => {
  for (const changed of ["input", "plan", "source"] as const) {
    const h = await fixture();
    try {
      const entry = await h.dispatch("old", {}, false);
      const progress = h.state.nodes[h.node.id];
      assert.ok(progress);
      Object.assign(progress, { status: "blocked", outputId: entry.outputId });
      h.state.consumedOutputs.push(entry.outputId);
      if (changed === "input") h.ports.revision = () => "changed";
      if (changed === "plan") h.state.plan.version++;
      if (changed === "source") await writeFile(join(h.repo, "source.txt"), "changed");
      await backfillReceiptRecovery(h.ports, h.task, h.state);
      assert.equal(h.state.nodes[h.node.id]?.repair?.recoverable, false, changed);
      assert.equal(h.state.nodes[h.node.id]?.repair?.notes, undefined, changed);
    } finally {
      h.close();
    }
  }
});
