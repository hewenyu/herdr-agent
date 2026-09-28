import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  assertDocumentSource,
  prepareDocumentSource,
} from "../../src/orchestration/document-source.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function harness() {
  const h = setup();
  h.config.ai.enabled = true;
  const root = join(h.directory, "repo");
  mkdirSync(root);
  writeFileSync(join(root, "app.ts"), "original source\n");
  await h.catalog.save({ name: "document-source", directories: [root], agent: "codex" });
  const task = await h.service.create(actor, {
    ...discussion,
    project: "document-source",
    orchestration: { mode: "workflow" },
  });
  const state = workflowState(h.store, task, "user-revision");
  state.plan.documentDelivery = { paths: ["A.md", "B.md"], userRequest: task.requirements };
  const prepare = () => prepareDocumentSource(h.store, task, state);
  const check = () => assertDocumentSource(h.store, task, state);
  return { ...h, task, state, root, prepare, check };
}

test("document source baseline permits all authorized documents but rejects source changes across plans", async () => {
  const h = await harness();
  try {
    await h.prepare();
    const original = structuredClone(h.state.documentSource);
    assert.ok(original);
    writeFileSync(join(h.root, "A.md"), "first writer\n");
    writeFileSync(join(h.root, "B.md"), "second writer\n");
    await h.check();
    h.state.plan.version++;
    h.state.nodes = {};
    writeFileSync(join(h.root, "app.ts"), "unauthorized source\n");
    await assert.rejects(h.prepare(), { code: "workflow_document_scope" });
    await assert.rejects(h.check(), { code: "workflow_document_scope" });
    assert.deepEqual(h.state.documentSource, original);
    assert.deepEqual(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.documentSource, original);
    h.state.plan.documentDelivery = undefined;
    await assert.rejects(h.check(), { code: "workflow_document_scope" });
    writeFileSync(join(h.root, "app.ts"), "original source\n");
    await h.check();
  } finally {
    h.close();
  }
});

test("new document authorization cannot hide preexisting changes and directory changes fail closed", async () => {
  const h = await harness();
  try {
    await h.prepare();
    const original = structuredClone(h.state.documentSource);
    writeFileSync(join(h.root, "A.md"), "approved document\n");
    h.state.plan.documentDelivery = { paths: ["A.md", "C.md"], userRequest: h.task.requirements };
    writeFileSync(join(h.root, "C.md"), "previously unauthorized\n");
    await assert.rejects(h.prepare(), { code: "workflow_document_scope" });
    assert.deepEqual(h.state.documentSource, original);
    unlinkSync(join(h.root, "C.md"));
    await h.prepare();
    assert.deepEqual(h.state.documentSource?.paths, ["A.md", "C.md"]);
    writeFileSync(join(h.root, "C.md"), "now authorized\n");
    await h.check();
    writeFileSync(join(h.root, "B.md"), "authorization removed\n");
    await assert.rejects(h.check(), { code: "workflow_document_scope" });
    unlinkSync(join(h.root, "B.md"));
    const other = join(h.directory, "other");
    mkdirSync(other);
    writeFileSync(join(other, "app.ts"), "original source\n");
    h.task.directories = [other];
    await assert.rejects(h.prepare(), { code: "workflow_document_scope", message: /目录已变化/ });
    await assert.rejects(h.check(), { code: "workflow_document_scope", message: /目录已变化/ });
  } finally {
    h.close();
  }
});

test("tasks without document capability do not require missing historical document evidence", async () => {
  const h = await harness();
  try {
    h.state.plan.documentDelivery = undefined;
    h.store.set("task_orchestration_events", "missing-archive", {
      taskId: h.task.id,
      workflow: { planVersion: 1 },
      dispatches: [{ nodeId: "old-node" }],
    });
    h.task.promptVersion = 2;
    await h.check();
    h.task.promptVersion = 3;
    h.task.kind = "development";
    await h.check();
    h.task.kind = "discussion";
    await assert.rejects(h.check(), { code: "workflow_document_scope" });
  } finally {
    h.close();
  }
});

for (const legacy of ["issue", "dispatch"] as const)
  test(`legacy ${legacy} cannot initialize a baseline from a potentially contaminated tree`, async () => {
    const h = await harness();
    try {
      if (legacy === "issue")
        h.state.issues.push({
          id: "document-scope-violation",
          description: "old violation",
          status: "resolved",
          blocking: true,
          evidenceRefs: [],
          raisedBy: "myrix",
          responses: [],
        });
      else
        h.store.set("task_orchestration_events", "old-event", {
          taskId: h.task.id,
          dispatches: [{ sourceRevision: "old-source-revision" }],
        });
      h.state.nodes = {};
      await assert.rejects(h.prepare(), { code: "workflow_document_scope" });
      assert.equal(h.state.documentSource, undefined);
      h.state.plan.documentDelivery = undefined;
      await assert.rejects(h.check(), { code: "workflow_document_scope" });
    } finally {
      h.close();
    }
  });
