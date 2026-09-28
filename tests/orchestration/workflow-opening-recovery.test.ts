import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { HerdrPort } from "../../src/core/ports.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import type { InputDelivery } from "../../src/tasks/input-delivery.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function harness() {
  const h = setup();
  h.config.ai.enabled = true;
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "source.txt"), "unchanged");
  await h.catalog.save({ name: "opening-recovery", directories: [repo], agent: "codex" });
  const engine = new Engine();
  let plans = 0;
  engine.handler = async (input) => {
    assert.equal(input.tools[0]?.name, "orchestration_plan");
    plans++;
    await input.tools[0].execute(
      { template: "discussion", instructions: {}, deliveryRequirements: [] },
      input.actor,
    );
    return { text: "", messages: [] };
  };
  const task = await h.service.create(actor, {
    ...discussion,
    project: "opening-recovery",
    orchestration: { mode: "workflow" },
  });
  // Exercise persisted v2 workflows; v3 integration has its own end-to-end suite.
  task.promptVersion = 2;
  h.service.records.save(task);
  await h.service.reconcile(task.id);
  const options = {
    store: h.store,
    engine,
    tasks: () => h.service,
    tools: () => [],
    signal: new AbortController().signal,
    logger,
    config: h.config,
    projects: h.catalog,
    retryDelayMs: 0,
    onReply: async () => {},
  };
  const tick = () => new TaskOrchestrator(options).tick();
  const event = () => {
    const result = h.store
      .list<OrchestrationEvent>("task_orchestration_events")
      .find((entry) => entry.workflow?.candidate.id === "dispatch:independent-opening");
    assert.ok(result);
    return result;
  };
  await tick();
  h.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
  await tick();
  await tick(); // Reconcile the original unknown receipt without retrying its input.
  const failed = event();
  assert.equal(failed.state, "attention");
  assert.equal(failed.error?.code, "orchestration_delivery_unknown");
  assert.deepEqual(
    failed.dispatches.map((entry) => entry.state),
    ["uncertain", "failed"],
  );
  assert.equal(failed.attempts, 1);
  assert.equal(h.herdr.sends.length, 1);
  const first = failed.dispatches[0];
  assert.ok(first);
  const prepared = h.store.get<InputDelivery>("input_deliveries", first.operationId);
  assert.ok(prepared);
  h.herdr.delivery = { status: "delivered", acked: true, verified: true, attempts: 1 };
  const firstAgent = h.herdr.agents.get(prepared.execution.paneId);
  assert.ok(firstAgent);
  firstAgent.status = "working"; // The real input arrived; only acknowledgement was lost.
  let proved = false;
  (h.herdr as HerdrPort).initialInput = async (ref, receipt) =>
    proved && ref.paneId === prepared.execution.paneId && receipt === prepared.receipt
      ? prepared.prompt
      : undefined;
  const prove = async () => {
    proved = true;
    await h.service.reconcile(task.id);
    assert.equal(h.store.get<OperationReceipt>("operations", first.operationId)?.state, "done");
    assert.ok(h.store.get("task_input_applied", first.operationId));
  };
  return { ...h, task, tick, event, prepared, prove, plans: () => plans };
}

for (const outputReady of [false, true])
  test(`proved first opening resumes only its unsent peer after restart (outputReady=${outputReady})`, async () => {
    const h = await harness();
    try {
      const original = h.event();
      for (let poll = 0; poll < 3; poll++) {
        await h.service.reconcile(h.task.id);
        await h.tick();
      }
      assert.equal(h.herdr.sends.length, 1, "unknown effects are never resent or bypassed");
      assert.equal(h.event().attempts, 1, "polling unresolved proof consumes no attempts");
      if (outputReady) {
        const state = h.store.get<WorkflowState>(WORKFLOWS, h.task.id);
        const progress = state?.nodes["opening-1"];
        assert.ok(progress);
        const block = {
          protocolVersion: 1,
          nodeId: "opening-1",
          operationId: progress.operationId,
          inputRevision: progress.inputRevision,
          status: "completed",
          summary: "已独立分析",
          issues: [],
          artifactRefs: [],
          evidence: [],
          blockers: [],
        };
        h.herdr.finish(
          h.prepared.execution.paneId,
          `独立分析结果。\n\n\`\`\`myrix-status\n${JSON.stringify(block)}\n\`\`\``,
        );
      }
      await h.prove();
      await h.tick();
      const recovered = h.event();
      assert.equal(recovered.id, original.id);
      assert.deepEqual(recovered.workflow?.candidate, original.workflow?.candidate);
      assert.deepEqual(
        recovered.dispatches.map((entry) => entry.operationId),
        original.dispatches.map((entry) => entry.operationId),
      );
      assert.deepEqual(
        recovered.dispatches.map((entry) => entry.state),
        ["sent", "sent"],
      );
      assert.equal(recovered.workflow?.applied, true);
      assert.equal(recovered.state, "done");
      assert.equal(recovered.attempts, 2);
      assert.equal(h.herdr.sends.length, 2);
      assert.notEqual(h.herdr.sends[1]?.pane, h.prepared.execution.paneId);
      assert.equal(h.plans(), 1);
      const state = h.store.get<WorkflowState>(WORKFLOWS, h.task.id);
      assert.equal(state?.nodes["opening-1"]?.attempt, 1);
      assert.equal(state?.nodes["opening-2"]?.attempt, 1);
      await h.tick();
      assert.equal(h.herdr.sends.length, 2, "completed batch dispatches are not replayed");
      assert.equal(h.event().attempts, 2);
      if (outputReady)
        assert.equal(
          h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.nodes["opening-1"]?.status,
          "completed",
        );
    } finally {
      h.close();
    }
  });

for (const change of ["pause", "close", "revision"])
  test(`proved opening cannot dispatch its peer after user ${change}`, async () => {
    const h = await harness();
    try {
      await h.prove();
      const current = h.service.records.get(actor, h.task.id);
      if (change === "pause") {
        current.discussion.paused = true;
        current.status = "paused";
      } else if (change === "close") current.closeRequested = true;
      else current.requirements += "\n改为只比较新的方案，原开场安排失效。";
      h.service.records.save(current);
      await h.tick();
      await h.tick();
      assert.equal(h.herdr.sends.length, 1);
      assert.equal(h.event().attempts, 1);
      assert.equal(h.event().dispatches[1]?.state, "failed");
      if (change === "revision") assert.equal(h.event().state, "superseded");
    } finally {
      h.close();
    }
  });
