import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { TaskKind } from "../../src/core/types.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function harness(kind: TaskKind = "discussion", verify = false) {
  const h = setup();
  h.config.ai.enabled = true;
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "app.txt"), "before");
  await h.catalog.save({
    name: "isolated",
    directories: [repo],
    agent: "codex",
    ...(verify ? { verify: ["node -e \"console.log('verified')\""] } : {}),
  });
  const engine = new Engine();
  engine.handler = async (input) => {
    if (
      input.tools[0]?.name === "orchestration_choice" &&
      JSON.parse(input.prompt).candidates.some(
        (candidate: { id: string }) => candidate.id === "use_template",
      )
    ) {
      await input.tools[0].execute({ candidateId: "request_pi" }, input.actor);
      return { text: "", messages: [] };
    }
    const plan = input.tools.find((tool) => tool.name === "orchestration_plan");
    if (plan)
      await plan.execute(
        {
          template: kind === "discussion" ? "discussion" : "bugfix",
          instructions: {},
          deliveryRequirements: [],
        },
        input.actor,
      );
    else {
      assert.deepEqual(
        input.tools.map((tool) => tool.name),
        ["orchestration_choice"],
      );
      const data = JSON.parse(input.prompt);
      const chosen =
        data.candidates.find((entry: { kind: string }) => entry.kind === "deliver") ??
        data.candidates[0];
      await input.tools[0]?.execute({ candidateId: chosen.id }, input.actor);
    }
    return { text: "", messages: [] };
  };
  const task = await h.service.create(actor, {
    ...discussion,
    kind,
    project: "isolated",
    orchestration: { mode: "workflow" },
  });
  // Exercise persisted v2 workflows; v3 integration has its own end-to-end suite.
  task.promptVersion = 2;
  h.service.records.save(task);
  await h.service.reconcile(task.id);
  const replies: string[] = [];
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
    onReply: async (_task: unknown, text: string) => {
      replies.push(text);
    },
  };
  const worker = new TaskOrchestrator(options);
  const state = () => h.store.get<WorkflowState>(WORKFLOWS, task.id) as WorkflowState;
  const finish = async (nodeId: string, override: Record<string, unknown> = {}) => {
    const current = state();
    const progress = current.nodes[nodeId];
    assert.ok(progress?.operationId && progress.participantId && progress.inputRevision, nodeId);
    const participant = h.service.records
      .participants(task)
      .find((entry) => entry.id === progress.participantId);
    assert.ok(participant?.execution);
    const block = {
      protocolVersion: 1,
      nodeId,
      operationId: progress.operationId,
      inputRevision: progress.inputRevision,
      status: "completed",
      summary: `${nodeId} 已产出`,
      issues: [],
      artifactRefs: [],
      evidence:
        nodeId === "validate"
          ? [{ description: "独立重跑通过", command: "node test", result: "passed" }]
          : [],
      blockers: [],
      ...(nodeId === "report"
        ? {
            reportSections: Object.fromEntries(
              current.plan.deliveryRequirements.map((entry) => [
                entry,
                `针对 ${entry} 的实际结论。`,
              ]),
            ),
          }
        : {}),
      ...override,
    };
    h.herdr.finish(
      participant.execution.paneId,
      `真实结果正文。\n\n\`\`\`myrix-status\n${JSON.stringify(block)}\n\`\`\``,
    );
    await h.service.reconcile(task.id);
  };
  return { ...h, repo, task, engine, replies, options, worker, state, finish };
}

test("workflow discussion independently opens, cross reviews and delivers a report without completing the task", async () => {
  const h = await harness();
  try {
    assert.equal(h.herdr.sends.length, 0);
    await h.worker.tick(); // plan
    await h.worker.tick(); // independent opening
    assert.equal(h.herdr.sends.length, 2);
    await h.finish("opening-1");
    await h.worker.tick();
    assert.equal(h.herdr.sends.length, 2, "stage waits for both dispatched participants");
    await h.finish("opening-2");
    await h.worker.tick();
    assert.equal(h.herdr.sends.length, 3);
    await h.finish("cross-review");
    await h.worker.tick();
    await h.finish("report");
    await h.worker.tick();
    assert.equal(h.replies.length, 1);
    assert.match(h.replies[0] ?? "", /推荐方案与理由/);
    assert.match(readFileSync(h.state().report?.path ?? "", "utf8"), /报告交付不等于用户验收/);
    assert.equal(h.service.get(actor, h.task.id).status, "review");
    assert.equal(h.herdr.closes, 0);
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.replies.length, 1);
  } finally {
    h.close();
  }
});

for (const configured of [false, true])
  test(`bugfix uses a short flow with independent verification and review (configured=${configured})`, async () => {
    const h = await harness("development", configured);
    try {
      await h.worker.tick();
      await h.worker.tick();
      await h.finish("analysis");
      await h.worker.tick();
      const implementer = h.state().nodes.implement?.participantId;
      writeFileSync(join(h.repo, "app.txt"), "fixed");
      await h.finish("implement");
      await h.worker.tick();
      if (configured) {
        assert.equal(h.store.list<{ status: string }>("verification_runs")[0]?.status, "passed");
        await h.worker.tick();
      }
      assert.notEqual(h.state().nodes.validate?.participantId, implementer);
      assert.deepEqual(
        h.state().plan.nodes.map((node) => node.id),
        ["analysis", "implement", "validate", "report"],
      );
      assert.equal(h.state().plan.nodes.find((node) => node.id === "validate")?.role, "reviewer");
      await h.finish("validate");
      await h.worker.tick();
      await h.finish("report");
      await h.worker.tick();
      assert.equal(h.replies.length, 1);
      assert.match(h.replies[0] ?? "", configured ? /myrix 配置命令验证/ : /agent 复核/);
      assert.equal(h.state().plan.template, "bugfix");
      assert.equal(
        h.store
          .list<OrchestrationEvent>("task_orchestration_events")
          .filter((entry) => entry.decision?.action === "deliver").length,
        1,
      );
    } finally {
      h.close();
    }
  });

test("malformed or foreign status does not complete a node or deliver", async () => {
  const h = await harness();
  try {
    await h.worker.tick();
    await h.worker.tick();
    await h.finish("opening-1", { operationId: "another-dispatch" });
    await h.finish("opening-2");
    await h.worker.tick();
    assert.notEqual(h.state().nodes["opening-1"]?.status, "completed");
    assert.equal(h.replies.length, 0);
    assert.ok(h.store.list("task_settled_outputs").length >= 2, "original output remains durable");
  } finally {
    h.close();
  }
});

test("resuming after removing a participant replans openings against the active roster", async () => {
  const h = await harness();
  try {
    await h.worker.tick();
    const removed = h.task.participantIds[1];
    assert.ok(removed);
    await h.service.removeParticipant(actor, h.task.id, removed);
    await h.service.action({ ...actor, messageId: "resume-after-removal" }, h.task.id, "resume");
    await h.worker.tick();
    assert.equal(h.state().plan.version, 2);
    assert.deepEqual(
      h
        .state()
        .plan.nodes.filter((node) => !node.dependsOn.length)
        .map((node) => node.participantId),
      [h.task.participantIds[0]],
    );
    await h.worker.tick();
    assert.equal(h.herdr.sends.length, 1);
    await h.finish("opening-1");
    await h.worker.tick();
    assert.equal(h.state().nodes["cross-review"]?.status, "dispatched");
  } finally {
    h.close();
  }
});
