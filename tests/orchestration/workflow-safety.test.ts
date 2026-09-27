import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { Task } from "../../src/core/types.js";
import { reportContract } from "../../src/orchestration/report.js";
import type { VerificationRun } from "../../src/orchestration/verify.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { verificationConfigRevision } from "../../src/projects/verification-config.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function harness(verify?: string[]) {
  const h = setup();
  h.config.ai.enabled = true;
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "app.txt"), "initial source");
  await h.catalog.save({
    name: "safety",
    directories: [repo],
    agent: "codex",
    verify,
    verifyTimeoutMs: 15_000,
  });
  const engine = new Engine();
  engine.handler = async (input) => {
    const plan = input.tools.find((tool) => tool.name === "orchestration_plan");
    if (plan)
      await plan.execute(
        { template: "development", instructions: {}, deliveryRequirements: [] },
        input.actor,
      );
    else {
      const data = JSON.parse(input.prompt);
      const candidate = data.candidates[0];
      await input.tools[0]?.execute(
        { candidateId: candidate.id, reason: "按安全测试合法候选执行。" },
        input.actor,
      );
    }
    return { text: "", messages: [] };
  };
  const controller = new AbortController();
  const worker = new TaskOrchestrator({
    store: h.store,
    engine,
    tasks: () => h.service,
    tools: () => [],
    signal: controller.signal,
    logger,
    config: h.config,
    projects: h.catalog,
    retryDelayMs: 0,
  });
  const create = async (id = "first") => {
    const task = await h.service.create(
      { ...actor, messageId: id },
      {
        ...discussion,
        kind: "development",
        title: id,
        requirements: "实现小改动并独立验证评审。",
        project: "safety",
        orchestration: { mode: "workflow" },
      },
    );
    await h.service.reconcile(task.id);
    return task;
  };
  const state = (task: Task) => h.store.get<WorkflowState>(WORKFLOWS, task.id) as WorkflowState;
  const finish = async (task: Task, nodeId: string, override: Record<string, unknown> = {}) => {
    const progress = state(task).nodes[nodeId];
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
      summary: `${nodeId} 真实完成`,
      issues: [],
      artifactRefs: [],
      blockers: [],
      evidence:
        nodeId === "validate"
          ? [{ command: "node -e test", result: "passed", description: "独立重跑" }]
          : [],
      ...override,
    };
    h.herdr.finish(
      participant.execution.paneId,
      `原始结果\n\n\`\`\`myrix-status\n${JSON.stringify(block)}\n\`\`\``,
    );
    await h.service.reconcile(task.id);
  };
  return { ...h, repo, engine, controller, worker, create, state, finish };
}

test("a participant not assigned to this phase does not gate an available participant", async () => {
  const h = await harness();
  try {
    const task = await h.create();
    await h.worker.tick();
    const unused = h.service.records.participants(task)[1];
    assert.ok(unused);
    h.service.records.saveParticipant({ ...unused, status: "unknown" });
    await h.worker.tick();
    assert.equal(h.state(task).nodes.analysis?.status, "dispatched");
    assert.notEqual(h.state(task).nodes.analysis?.participantId, unused.id);
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    h.controller.abort();
    h.close();
  }
});

test("two workflows may analyze together but cannot concurrently write an overlapping directory", async () => {
  const h = await harness();
  try {
    const first = await h.create("first");
    const second = await h.create("second");
    await h.worker.tick();
    await h.worker.tick();
    assert.equal(h.herdr.sends.length, 2, "independent read phases are allowed");
    await h.finish(first, "analysis");
    await h.finish(second, "analysis");
    await h.worker.tick();
    assert.equal(
      [first, second].filter((task) => h.state(task).nodes.implement?.status === "dispatched")
        .length,
      1,
    );
    assert.equal(h.herdr.sends.length, 3, "only one new write dispatch is admitted");
  } finally {
    h.controller.abort();
    h.close();
  }
});

test("review output for an old code snapshot cannot certify changes made during the review", async () => {
  const h = await harness();
  try {
    const task = await h.create();
    await h.worker.tick();
    await h.worker.tick();
    await h.finish(task, "analysis");
    await h.worker.tick();
    writeFileSync(join(h.repo, "app.txt"), "implementation");
    await h.finish(task, "implement");
    await h.worker.tick();
    await h.finish(task, "validate");
    await h.worker.tick();
    assert.equal(h.state(task).nodes.review?.status, "dispatched");
    const reviewed = h.state(task).nodes.review?.artifactRevision;
    writeFileSync(join(h.repo, "app.txt"), "external change during review");
    const current = await workspaceRevision([h.repo]);
    assert.notEqual(current, reviewed);
    await h.finish(task, "review", {
      evidence: [{ command: "old-snapshot-check", result: "passed", description: "old-review" }],
    });
    await h.worker.tick();
    assert.notEqual(h.state(task).nodes.review?.status, "completed");
    assert.equal(
      h
        .state(task)
        .evidence.some(
          (entry) => entry.description === "old-review" && entry.artifactRevision === current,
        ),
      false,
    );
    assert.ok(
      h.store.list("task_settled_outputs").length >= 4,
      "old source output remains available",
    );
  } finally {
    h.controller.abort();
    h.close();
  }
});

test("same verify command with a changed timeout cannot reuse a previous configuration's evidence", async () => {
  const h = await harness(["printf verified"]);
  try {
    const task = await h.create();
    await h.worker.tick();
    await h.worker.tick();
    await h.finish(task, "analysis");
    await h.worker.tick();
    await h.finish(task, "implement");
    await h.worker.tick();
    const previous = verificationConfigRevision(h.catalog.get("safety"));
    assert.equal(h.store.list<VerificationRun>("verification_runs")[0]?.status, "passed");
    await h.catalog.save({ ...h.catalog.get("safety"), verifyTimeoutMs: 16_000 });
    const current = verificationConfigRevision(h.catalog.get("safety"));
    assert.notEqual(current, previous);
    const missing = reportContract(
      h.state(task),
      await workspaceRevision([h.repo]),
      h.catalog.get("safety").verify ?? [],
      current,
    );
    assert.ok(
      missing.some((item) => item.includes("配置命令")),
      "configuration mismatch is a separate missing proof",
    );
  } finally {
    h.controller.abort();
    h.close();
  }
});

test("pausing a task cancels its configured verification process and does not add passed evidence", async () => {
  const command = `exec '${process.execPath.replaceAll("'", "'\\''")}' -e 'setInterval(() => {}, 1000)'`;
  const h = await harness([command]);
  let running: Promise<void> | undefined;
  try {
    const task = await h.create();
    await h.worker.tick();
    await h.worker.tick();
    await h.finish(task, "analysis");
    await h.worker.tick();
    await h.finish(task, "implement");
    running = h.worker.tick();
    for (
      let attempt = 0;
      attempt < 2000 &&
      !h.store.list<VerificationRun>("verification_runs").some((run) => run.status === "running");
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(h.store.list<VerificationRun>("verification_runs")[0]?.status, "running");
    await h.service.action({ ...actor, messageId: "pause-verify" }, task.id, "pause");
    await running;
    const run = h.store.list<VerificationRun>("verification_runs")[0];
    assert.equal(run?.status, "cancelled");
    assert.equal(run?.exitConfirmed, true);
    assert.equal(
      h
        .state(task)
        .evidence.some(
          (entry) => entry.source === "configured_command" && entry.result === "passed",
        ),
      false,
    );
    assert.equal(h.service.records.get(actor, task.id).status, "paused");
  } finally {
    h.controller.abort();
    await running;
    h.close();
  }
});
