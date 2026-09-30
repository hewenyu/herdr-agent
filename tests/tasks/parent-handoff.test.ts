import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Participant } from "../../src/core/types.js";
import { handoffDirectory, prepareHandoff } from "../../src/orchestration/handoff.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS } from "../../src/orchestration/workflow.js";
import { parentHandoff } from "../../src/tasks/parent-handoff.js";
import { participantPrompt } from "../../src/tasks/prompts.js";
import { actor, discussion, setup } from "./helpers.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture() {
  const h = setup();
  const parent = await h.service.create(actor, { ...discussion, project: "project" });
  const state = workflowState(h.store, parent, "user");
  const reportText = "# 双方确认结论\n按最终方案实现。\n";
  const documentText = "# 最终方案\n保留已有工作，分阶段实现。\n";
  const reportPath = join(h.directory, "frozen-report.md");
  const documentPath = join(h.directory, "docs", "DESIGN.md");
  await mkdir(join(h.directory, "docs"));
  await writeFile(reportPath, reportText);
  await writeFile(documentPath, documentText);
  state.report = {
    id: "report-id",
    path: reportPath,
    hash: hash(reportText),
    outputId: "report-output",
    artifactRevision: "revision",
  };
  state.plan.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: "保存方案" };
  state.plan.consensus = { participantIds: parent.participantIds };
  state.artifacts = [
    {
      path: documentPath,
      reference: "docs/DESIGN.md",
      hash: hash(documentText),
      outputId: "doc-output",
      artifactRevision: "revision",
    },
  ];
  state.consensusApprovals = parent.participantIds.map((participantId, index) => {
    const id = `confirm-${index}`;
    state.plan.nodes.push({
      id,
      phase: "discussing",
      role: "analyst",
      participantId,
      consensus: true,
      purpose: "确认",
      instruction: "确认",
      dependsOn: [],
      access: "read",
    });
    state.nodes[id] = { status: "completed", attempt: 1, outputId: id };
    return {
      participantId,
      outputId: id,
      artifactRevision: "revision",
      documents: [{ path: "docs/DESIGN.md", hash: hash(documentText) }],
    };
  });
  h.store.set(WORKFLOWS, parent.id, state);
  const childActor = { ...actor, messageId: "child" };
  const childInput = {
    kind: "development" as const,
    title: "实现方案",
    requirements: "按讨论实现",
    parentTaskId: parent.id,
    participants: [{ kind: "codex" as const }],
  };
  const create = () => h.service.create(childActor, childInput);
  return {
    ...h,
    parent,
    state,
    reportPath,
    documentPath,
    reportText,
    documentText,
    create,
    childActor,
    childInput,
  };
}

test("children freeze verified reports and consensus documents, and prompts reference hashes", async () => {
  const h = await fixture();
  try {
    const child = await h.create();
    const context = child.parentContext;
    assert.ok(context?.report?.snapshotPath);
    assert.equal(context.report.reportId, "report-id");
    assert.equal(context.report.sha256, hash(h.reportText));
    assert.equal(context.report.originalPath, h.reportPath);
    assert.equal(context.report.verification, "verified");
    assert.equal(await readFile(context.report.snapshotPath, "utf8"), h.reportText);
    const doc = context.documents?.[0];
    assert.ok(doc?.snapshotPath);
    assert.equal(doc.consensusConfirmed, true);
    assert.equal(doc.sha256, hash(h.documentText));
    assert.equal(await readFile(doc.snapshotPath, "utf8"), h.documentText);
    assert.ok(
      doc.snapshotPath.startsWith(join(h.config.stateDir, "tasks", child.id, "parent-handoff")),
    );
    assert.equal((await stat(doc.snapshotPath)).mode & 0o222, 0);
    const participant = h.store.get<Participant>("participants", child.participantIds[0] ?? "");
    assert.ok(participant);
    const prompt = participantPrompt(child, participant);
    assert.ok(prompt.includes(doc.snapshotPath));
    assert.ok(prompt.includes(doc.sha256));
    assert.match(prompt, /开始前核对 hash/);
    assert.ok(!prompt.includes(h.documentText));
    const workflowChild = { ...child, promptVersion: 3 as const };
    const state = workflowState(h.store, workflowChild, "child-user");
    const node = state.plan.nodes[0];
    assert.ok(node);
    const identity = {
      nodeId: node.id,
      operationId: "child-dispatch",
      inputRevision: "child-revision",
    };
    await prepareHandoff(h.config.stateDir, workflowChild, state, node, identity, []);
    const brief = await readFile(
      join(handoffDirectory(h.config.stateDir, child.id, identity.operationId), "brief.md"),
      "utf8",
    );
    assert.ok(brief.includes(doc.snapshotPath));
    assert.ok(brief.includes(doc.sha256));
    assert.match(brief, /父讨论双方确认的方案/);
    assert.ok(!brief.includes(h.documentText));
    await writeFile(h.reportPath, "父报告后来变化");
    await writeFile(h.documentPath, "父文档后来变化");
    const retry = await h.create();
    assert.equal(retry.id, child.id);
    assert.deepEqual(retry.parentContext, context);
    assert.equal(await readFile(doc.snapshotPath, "utf8"), h.documentText);
    assert.equal((await readdir(join(h.directory, "tasks", child.id, "parent-handoff"))).length, 2);
    assert.deepEqual(await parentHandoff(h.store, h.directory, child.id, h.parent), {
      report: context.report,
      documents: context.documents,
    });
  } finally {
    h.close();
  }
});

test("missing files and mismatched hashes are unverified without blocking creation", async () => {
  const h = await fixture();
  try {
    await writeFile(h.documentPath, "被改动的文档");
    assert.ok(h.state.report);
    h.state.report.path = join(h.directory, "missing.md");
    h.store.set(WORKFLOWS, h.parent.id, h.state);
    const child = await h.create();
    assert.equal(child.parentContext?.report?.verification, "unverified");
    assert.equal(child.parentContext?.report?.reason, "ENOENT");
    assert.equal(child.parentContext?.report?.snapshotPath, undefined);
    const doc = child.parentContext?.documents?.[0];
    assert.equal(doc?.verification, "unverified");
    assert.equal(doc?.reason, "source_hash_mismatch");
    assert.equal(doc?.snapshotPath, undefined);
    assert.equal(
      doc?.consensusConfirmed,
      true,
      "recorded agreement does not imply file verification",
    );
  } finally {
    h.close();
  }
});

test("confirmation from an old revision is not passed off as mutual consensus", async () => {
  const h = await fixture();
  try {
    const approval = h.state.consensusApprovals?.[1];
    assert.ok(approval);
    approval.artifactRevision = "old";
    h.store.set(WORKFLOWS, h.parent.id, h.state);
    const child = await h.create();
    assert.equal(child.parentContext?.documents?.[0]?.verification, "verified");
    assert.equal(child.parentContext?.documents?.[0]?.consensusConfirmed, false);
  } finally {
    h.close();
  }
});

test("old parents preserve historical context and cross-owner parents are rejected", async () => {
  const h = setup();
  try {
    const parent = await h.service.create(actor, discussion);
    const input = { ...discussion, parentTaskId: parent.id };
    const child = await h.service.create({ ...actor, messageId: "old-child" }, input);
    assert.deepEqual(child.parentContext, {
      taskId: parent.id,
      title: parent.title,
      requirements: parent.requirements,
      result: parent.result,
      participants: [
        { name: "Claude", kind: "claude", lastOutput: "" },
        { name: "Codex", kind: "codex", lastOutput: "" },
      ],
    });
    const participant = h.store.get<Participant>("participants", child.participantIds[0] ?? "");
    assert.ok(participant);
    assert.ok(participantPrompt(child, participant).includes(JSON.stringify(child.parentContext)));
    await assert.rejects(
      h.service.create({ ...actor, ownerId: "other", messageId: "foreign" }, input),
      { code: "task_missing" },
    );
    assert.equal(h.store.list("task_parent_handoffs").length, 0);
  } finally {
    h.close();
  }
});

test("confirmed documents can be handed off before the final report is frozen", async () => {
  const h = await fixture();
  try {
    h.state.report = undefined;
    h.store.set(WORKFLOWS, h.parent.id, h.state);
    const child = await h.create();
    assert.equal(child.parentContext?.report, undefined);
    assert.equal(child.parentContext?.documents?.[0]?.verification, "verified");
    assert.equal(child.parentContext?.documents?.[0]?.consensusConfirmed, true);
  } finally {
    h.close();
  }
});

test("interrupted creation reuses frozen source metadata and never makes a newer copy", async () => {
  const h = await fixture();
  try {
    const references = await parentHandoff(h.store, h.directory, "interrupted-child", h.parent);
    // Model interruption after files/source intent persisted but before final references saved.
    h.store.delete("task_parent_handoffs", "interrupted-child");
    assert.ok(h.state.report);
    h.state.report.id = "new-report";
    h.state.report.hash = hash("new version");
    await writeFile(h.reportPath, "new version");
    await writeFile(h.documentPath, "new document");
    h.store.set(WORKFLOWS, h.parent.id, h.state);
    const retry = await parentHandoff(h.store, h.directory, "interrupted-child", h.parent);
    assert.deepEqual(retry, references);
    assert.equal(
      (await readdir(join(h.directory, "tasks", "interrupted-child", "parent-handoff"))).length,
      2,
    );
  } finally {
    h.close();
  }
});

test("a changed frozen report hash is unverified, not replaced with the current content", async () => {
  const h = await fixture();
  try {
    await writeFile(h.reportPath, "changed report");
    const child = await h.create();
    assert.equal(child.parentContext?.report?.verification, "unverified");
    assert.equal(child.parentContext?.report?.reason, "source_hash_mismatch");
    assert.equal(child.parentContext?.report?.sha256, hash(h.reportText));
    assert.equal(child.parentContext?.report?.snapshotPath, undefined);
  } finally {
    h.close();
  }
});

test("snapshot directories cannot escape stateDir through symlinks", async () => {
  const h = await fixture();
  try {
    const references = await parentHandoff(h.store, h.directory, "symlink-child", h.parent);
    assert.equal(references.report?.verification, "verified");
    await mkdir(join(h.directory, "tasks", "unsafe-child"));
    await symlink(
      join(h.directory, "docs"),
      join(h.directory, "tasks", "unsafe-child", "parent-handoff"),
    );
    const unsafe = await parentHandoff(h.store, h.directory, "unsafe-child", h.parent);
    assert.equal(unsafe.report?.verification, "unverified");
    assert.equal(unsafe.report?.reason, "unsafe_snapshot_directory");
    assert.deepEqual(await readdir(join(h.directory, "docs")), ["DESIGN.md"]);
  } finally {
    h.close();
  }
});
