import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inspectArtifact } from "../../src/orchestration/board.js";
import {
  assertConsensusDocuments,
  captureConsensus,
  compileConsensus,
  consensusMissing,
} from "../../src/orchestration/consensus.js";
import { addDocumentDelivery } from "../../src/orchestration/document-delivery.js";
import { reportContract } from "../../src/orchestration/report.js";
import { mergeStatus, workflowState } from "../../src/orchestration/state.js";
import { parseStatusBlock, type StatusBlock } from "../../src/orchestration/status-block.js";
import { validatePlan } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

async function fixture() {
  const h = setup();
  h.config.ai.enabled = true;
  const task = await h.service.create(actor, {
    ...discussion,
    requirements: "讨论后把设计写入 docs/DESIGN.md，双方满意后交付",
    orchestration: { mode: "workflow" },
  });
  task.promptVersion = 3;
  const state = workflowState(h.store, task, "source");
  state.plan.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: task.requirements };
  addDocumentDelivery(state.plan);
  compileConsensus(state.plan, task.participantIds);
  state.nodes = Object.fromEntries(
    state.plan.nodes.map((node) => [node.id, { status: "pending", attempt: 0 }]),
  );
  const directory = required(task.directories[0]);
  mkdirSync(join(directory, "docs"), { recursive: true });
  writeFileSync(join(directory, "docs/DESIGN.md"), "# 当前设计\n");
  return { ...h, task, state, directory };
}

test("consensus plan requires each participant's read-only approval after all writing and review", async () => {
  const h = await fixture();
  try {
    validatePlan(h.state.plan, h.task);
    for (const mutate of [
      (plan: typeof h.state.plan) => {
        required(plan.consensus).participantIds.pop();
      },
      (plan: typeof h.state.plan) => {
        required(plan.nodes.find((node) => node.consensus)).dependsOn = ["opening-1"];
      },
      (plan: typeof h.state.plan) => {
        required(plan.nodes.find((node) => node.consensus)).access = "write";
      },
      (plan: typeof h.state.plan) => {
        plan.consensus = undefined;
      },
      (plan: typeof h.state.plan) => {
        required(plan.nodes.find((node) => node.id === "confirm-2")).participantId =
          h.task.participantIds[0];
      },
    ]) {
      const plan = structuredClone(h.state.plan);
      mutate(plan);
      assert.throws(() => validatePlan(plan, h.task));
    }
  } finally {
    h.close();
  }
});

test("approval binds the author, actual document hash and predecessor response; objections remain blocked", async () => {
  const h = await fixture();
  try {
    const node = required(h.state.plan.nodes.find((entry) => entry.id === "confirm-1"));
    h.state.nodes["cross-review"] = { status: "completed", attempt: 1, outputId: "review-output" };
    const doc = await inspectArtifact(h.task, "docs/DESIGN.md");
    const block: StatusBlock = {
      protocolVersion: 1,
      nodeId: node.id,
      operationId: "op",
      inputRevision: "input",
      status: "completed",
      summary: "核对完成",
      issues: [],
      artifactRefs: ["docs/DESIGN.md"],
      evidence: [],
      blockers: [],
      responses: [
        { outputId: "review-output", comment: "接受对方关于离线缓存的修订，目录与文档一致。" },
      ],
      consensus: { approved: true, documents: [{ path: "docs/DESIGN.md", hash: doc.hash }] },
    };
    const capture = (value: StatusBlock, who = required(node.participantId)) =>
      captureConsensus(h.task, h.state, node, value, who, "approval-output", "revision");
    await assert.rejects(capture({ ...block, responses: [] }), { code: "workflow_response" });
    await assert.rejects(
      capture({ ...block, responses: [{ outputId: "foreign-output", comment: "同意" }] }),
      { code: "workflow_response" },
    );
    await assert.rejects(capture(block, h.task.participantIds[1]), { code: "workflow_consensus" });
    await assert.rejects(
      capture({
        ...block,
        consensus: { approved: false, documents: required(block.consensus).documents },
      }),
      { code: "workflow_consensus" },
    );
    await assert.rejects(
      capture({
        ...block,
        consensus: {
          approved: true,
          documents: [{ path: "docs/DESIGN.md", hash: "0".repeat(64) }],
        },
      }),
      { code: "workflow_consensus" },
    );
    const objection: StatusBlock = {
      ...block,
      status: "needs_work",
      consensus: { ...required(block.consensus), approved: false },
      issues: [
        {
          id: "offline",
          description: "离线冲突尚未解决",
          status: "open",
          blocking: false,
          evidenceRefs: [],
        },
      ],
    };
    await capture(objection);
    mergeStatus(h.state, node, objection, "objection", "revision");
    assert.equal(h.state.nodes[node.id]?.status, "blocked");
    assert.match(reportContract(h.state, "revision", []).join("；"), /未处理分歧/);
    assert.deepEqual(h.state.consensusApprovals ?? [], []);
    await capture(block);
    assert.equal(h.state.consensusApprovals?.[0]?.participantId, node.participantId);
    const invalid = { ...block, responses: [{ outputId: "review-output", comment: "" }] };
    assert.throws(
      () => parseStatusBlock(`\`\`\`myrix-status\n${JSON.stringify(invalid)}\n\`\`\``, block),
      { code: "workflow_response" },
    );
  } finally {
    h.close();
  }
});

test("ignored document changes invalidate unanimous approval even without a workspace revision change", async () => {
  const h = await fixture();
  try {
    execFileSync("git", ["init", "-q"], { cwd: h.directory });
    writeFileSync(join(h.directory, ".gitignore"), "docs/\n");
    const revision = await workspaceRevision(h.task.directories);
    const original = await inspectArtifact(h.task, "docs/DESIGN.md");
    h.state.artifacts.push({
      ...original,
      reference: "docs/DESIGN.md",
      outputId: "document",
      artifactRevision: revision,
    });
    h.state.consensusApprovals = [];
    for (const node of h.state.plan.nodes.filter((entry) => entry.consensus)) {
      h.state.nodes[node.id] = {
        status: "completed",
        attempt: 1,
        participantId: node.participantId,
        outputId: node.id,
      };
      h.state.consensusApprovals.push({
        participantId: required(node.participantId),
        outputId: node.id,
        artifactRevision: revision,
        documents: [{ path: "docs/DESIGN.md", hash: original.hash }],
      });
    }
    assert.deepEqual(consensusMissing(h.state, revision), []);
    await assertConsensusDocuments(h.task, h.state, revision);
    writeFileSync(join(h.directory, "docs/DESIGN.md"), "# 未经对方认可的新方案\n");
    assert.equal(await workspaceRevision(h.task.directories), revision);
    await assert.rejects(assertConsensusDocuments(h.task, h.state, revision), {
      code: "workflow_consensus",
    });
    h.state.artifacts.push({
      ...(await inspectArtifact(h.task, "docs/DESIGN.md")),
      reference: "docs/DESIGN.md",
      outputId: "report",
      artifactRevision: revision,
    });
    assert.equal(
      consensusMissing(h.state, revision).length,
      2,
      "old matching artifact is not current evidence",
    );
    assert.equal(consensusMissing(h.state, "new-revision").length, 2);
    h.state.nodes["confirm-1"] = { status: "pending", attempt: 1 };
    assert.equal(
      consensusMissing(h.state, revision).length,
      2,
      "restart/replan cannot reuse old node approvals",
    );
  } finally {
    h.close();
  }
});
