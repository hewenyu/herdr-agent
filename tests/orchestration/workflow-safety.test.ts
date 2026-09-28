import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { Task } from "../../src/core/types.js";
import { reportContract } from "../../src/orchestration/report.js";
import type { VerificationRun } from "../../src/orchestration/verify.js";
import {
  WORKFLOWS,
  type WorkflowIssue,
  type WorkflowState,
} from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { verificationConfigRevision } from "../../src/projects/verification-config.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function harness(verify?: string[] | ((directory: string) => string[])) {
  const h = setup();
  h.config.ai.enabled = true;
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "app.txt"), "initial source");
  await h.catalog.save({
    name: "safety",
    directories: [repo],
    agent: "codex",
    verify: typeof verify === "function" ? verify(h.directory) : verify,
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
      const candidate =
        data.candidates.find((entry: { kind: string }) => entry.kind === "deliver") ??
        data.candidates[0];
      await input.tools[0]?.execute(
        { candidateId: candidate.id, reason: "按安全测试合法候选执行。" },
        input.actor,
      );
    }
    return { text: "", messages: [] };
  };
  const controller = new AbortController();
  const replies: string[] = [];
  const orchestratorOptions = {
    store: h.store,
    engine,
    tasks: () => h.service,
    tools: () => [],
    signal: controller.signal,
    logger,
    config: h.config,
    projects: h.catalog,
    retryDelayMs: 0,
    onReply: async (_task: Task, text: string) => {
      replies.push(text);
    },
  };
  const worker = new TaskOrchestrator(orchestratorOptions);
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
    // Exercise persisted v2 workflows; v3 integration has its own end-to-end suite.
    task.promptVersion = 2;
    h.service.records.save(task);
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
      ...(nodeId === "report"
        ? {
            reportSections: Object.fromEntries(
              state(task).plan.deliveryRequirements.map((section) => [
                section,
                `${section}：根据本次实现与独立核验的结果交付。`,
              ]),
            ),
          }
        : {}),
      ...override,
    };
    h.herdr.finish(
      participant.execution.paneId,
      `原始结果\n\n\`\`\`myrix-status\n${JSON.stringify(block)}\n\`\`\``,
    );
    await h.service.reconcile(task.id);
  };
  return {
    ...h,
    repo,
    engine,
    controller,
    worker,
    orchestratorOptions,
    replies,
    create,
    state,
    finish,
  };
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

function cancelOnce(directory: string): string[] {
  const fixture = join(directory, "cancel-once.mjs");
  writeFileSync(
    fixture,
    [
      'import { existsSync, writeFileSync } from "node:fs";',
      'const marker = new URL("./verification-started", import.meta.url);',
      "if (existsSync(marker)) {",
      '  console.log("retry verification passed");',
      "} else {",
      '  process.on("SIGTERM", () => {',
      '    console.log("first verification cancelled");',
      '    console.error("first cancellation confirmed by fixture");',
      "    process.exit(0);",
      "  });",
      "  setInterval(() => {}, 1000);",
      '  console.log("first verification waiting");',
      '  writeFileSync(marker, "ready");',
      "}",
    ].join("\n"),
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return [`exec ${quote(process.execPath)} ${quote(fixture)}`];
}

for (const interruption of ["pause/resume", "shutdown/restart"] as const)
  test(`${interruption} retries confirmed-cancelled verification on unchanged inputs and delivers`, async () => {
    const h = await harness(cancelOnce);
    const resumedController = new AbortController();
    let running: Promise<void> | undefined;
    try {
      const task = await h.create();
      const artifactRevision = await workspaceRevision([h.repo]);
      const configRevision = verificationConfigRevision(h.catalog.get("safety"));
      await h.worker.tick();
      await h.worker.tick();
      await h.finish(task, "analysis");
      await h.worker.tick();
      await h.finish(task, "implement");
      running = h.worker.tick();
      const marker = join(h.directory, "verification-started");
      for (let poll = 0; poll < 2000 && !existsSync(marker); poll++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(existsSync(marker), true, "the real verifier reached its cancellable state");
      assert.equal(h.store.list<VerificationRun>("verification_runs")[0]?.status, "running");
      if (interruption === "pause/resume")
        await h.service.action({ ...actor, messageId: "cancel-verify" }, task.id, "pause");
      else h.controller.abort();
      await running;

      const cancelled = h.store.list<VerificationRun>("verification_runs")[0];
      assert.ok(cancelled);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.exitConfirmed, true);
      assert.equal(cancelled.artifactRevision, artifactRevision);
      assert.equal(cancelled.configRevision, configRevision);
      const cancelledStdout = readFileSync(cancelled.stdoutPath, "utf8");
      const cancelledStderr = readFileSync(cancelled.stderrPath, "utf8");
      assert.match(cancelledStdout, /first verification cancelled/);
      assert.match(cancelledStderr, /first cancellation confirmed/);
      const cancelledEvidence = h
        .state(task)
        .evidence.find((entry) => entry.verificationId === cancelled.id);
      assert.ok(cancelledEvidence);
      assert.equal(cancelledEvidence.result, "failed");
      assert.equal(h.state(task).issues.find((issue) => issue.id === "verify-0")?.status, "open");
      const cancellationEvent = h.store
        .list<OrchestrationEvent>("task_orchestration_events")
        .find((event) => event.taskId === task.id && event.workflow?.candidate.kind === "verify");
      assert.ok(cancellationEvent);
      assert.ok(cancellationEvent.selectionLogId);
      const cancellationDecision = h.store.get(
        "workflow_decisions",
        cancellationEvent.selectionLogId,
      );
      assert.ok(cancellationDecision);

      if (interruption === "pause/resume") {
        assert.equal(h.service.get(actor, task.id).status, "paused");
        await h.service.action({ ...actor, messageId: "resume-verify" }, task.id, "resume");
      }
      const resumed = new TaskOrchestrator({
        ...h.orchestratorOptions,
        signal: resumedController.signal,
      });
      const finished = new Set<string>();
      for (let step = 0; step < 20 && h.state(task).phase !== "awaiting_acceptance"; step++) {
        for (const [nodeId, progress] of Object.entries(h.state(task).nodes)) {
          if (progress.status !== "dispatched") continue;
          await h.finish(task, nodeId);
          finished.add(nodeId);
        }
        await resumed.tick();
      }

      const runs = h.store.list<VerificationRun>("verification_runs");
      assert.equal(runs.length, 2, "only one fresh verification follows the confirmed exit");
      const passed = runs.find((run) => run.status === "passed");
      assert.ok(passed, "the cancellation must not permanently suppress the same command");
      assert.notEqual(passed.id, cancelled.id);
      assert.equal(passed.retryOf, cancelled.id);
      assert.equal(passed.artifactRevision, artifactRevision);
      assert.equal(passed.configRevision, configRevision);
      assert.equal(passed.exitConfirmed, true);
      assert.match(readFileSync(passed.stdoutPath, "utf8"), /retry verification passed/);
      assert.deepEqual(h.store.get("verification_runs", cancelled.id), cancelled);
      assert.equal(readFileSync(cancelled.stdoutPath, "utf8"), cancelledStdout);
      assert.equal(readFileSync(cancelled.stderrPath, "utf8"), cancelledStderr);
      assert.deepEqual(
        h.store.get("workflow_decisions", cancellationEvent.selectionLogId),
        cancellationDecision,
      );
      assert.deepEqual(
        h.state(task).evidence.find((entry) => entry.verificationId === cancelled.id),
        cancelledEvidence,
      );
      assert.equal(
        h.state(task).evidence.find((entry) => entry.verificationId === passed.id)?.result,
        "passed",
      );
      const resolved = h.state(task).issues.find((issue) => issue.id === "verify-0");
      assert.equal(resolved?.status, "resolved");
      assert.ok(resolved.evidenceRefs.includes(passed.id));
      assert.ok(["validate", "review", "report"].every((nodeId) => finished.has(nodeId)));
      if (interruption === "pause/resume") {
        assert.equal(h.state(task).plan.version, 2);
        assert.ok(finished.has("analysis") && finished.has("implement"));
      }
      assert.equal(await workspaceRevision([h.repo]), artifactRevision);
      assert.equal(verificationConfigRevision(h.catalog.get("safety")), configRevision);
      assert.deepEqual(
        reportContract(
          h.state(task),
          artifactRevision,
          h.catalog.get("safety").verify ?? [],
          configRevision,
        ),
        [],
      );
      assert.equal(h.state(task).phase, "awaiting_acceptance");
      assert.equal(h.replies.length, 1);
      assert.match(h.replies[0] ?? "", /myrix 配置命令验证/);
      assert.equal(h.service.get(actor, task.id).status, "review");
      assert.equal(h.herdr.closes, 0);
      await resumed.tick();
      assert.equal(h.store.list("verification_runs").length, 2);
      assert.equal(h.replies.length, 1, "the completed report must not be delivered twice");
    } finally {
      h.controller.abort();
      resumedController.abort();
      await running;
      h.close();
    }
  });

test("verification retry resolves only its own issue when a participant already owns verify-0", async () => {
  const h = await harness(cancelOnce);
  let running: Promise<void> | undefined;
  try {
    const task = await h.create();
    await h.worker.tick();
    await h.worker.tick();
    await h.finish(task, "analysis");
    await h.worker.tick();
    const participantIssue: WorkflowIssue = {
      id: "verify-0",
      description: "参与者发现尚未处理的验收缺陷。",
      status: "open",
      blocking: true,
      evidenceRefs: [],
      raisedBy: task.participantIds[0] as string,
      responses: [],
    };
    await h.finish(task, "implement", { issues: [participantIssue] });
    running = h.worker.tick();
    const marker = join(h.directory, "verification-started");
    for (let poll = 0; poll < 2000 && !existsSync(marker); poll++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(existsSync(marker), true);
    const originalIssue = h.state(task).issues.find((issue) => issue.id === "verify-0");
    assert.ok(originalIssue);
    assert.notEqual(originalIssue.raisedBy, "myrix");
    await h.service.action({ ...actor, messageId: "pause-collision" }, task.id, "pause");
    await running;
    const cancelled = h.store.list<VerificationRun>("verification_runs")[0];
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.exitConfirmed, true);
    const failedIssues = h.state(task).issues;
    assert.equal(failedIssues.length, 2);
    assert.equal(new Set(failedIssues.map((issue) => issue.id)).size, failedIssues.length);
    assert.deepEqual(
      failedIssues.find((issue) => issue.id === "verify-0"),
      originalIssue,
    );
    const systemIssue = failedIssues.find((issue) => issue.raisedBy === "myrix");
    assert.ok(systemIssue);
    assert.notEqual(systemIssue.id, "verify-0");
    assert.equal(systemIssue.verificationCommandIndex, 0);
    assert.equal(systemIssue.status, "open");

    await h.service.action({ ...actor, messageId: "resume-collision" }, task.id, "resume");
    for (
      let step = 0;
      step < 12 &&
      !h.store.list<VerificationRun>("verification_runs").some((run) => run.status === "passed");
      step++
    ) {
      for (const [nodeId, progress] of Object.entries(h.state(task).nodes))
        if (progress.status === "dispatched") await h.finish(task, nodeId);
      await h.worker.tick();
    }
    const passed = h.store
      .list<VerificationRun>("verification_runs")
      .find((run) => run.status === "passed");
    assert.ok(passed);
    assert.equal(passed.retryOf, cancelled?.id);
    const current = h.state(task);
    assert.equal(current.issues.length, 2);
    assert.equal(new Set(current.issues.map((issue) => issue.id)).size, current.issues.length);
    assert.deepEqual(
      current.issues.find((issue) => issue.id === "verify-0"),
      originalIssue,
    );
    const resolved = current.issues.find((issue) => issue.id === systemIssue.id);
    assert.equal(resolved?.status, "resolved");
    assert.ok(resolved.evidenceRefs.includes(passed.id));
    assert.ok(
      reportContract(
        current,
        passed.artifactRevision,
        h.catalog.get("safety").verify ?? [],
        passed.configRevision,
      ).includes("仍有未处理阻塞问题"),
      "a successful command does not resolve the participant's independent acceptance defect",
    );
    assert.equal(h.replies.length, 0);
  } finally {
    h.controller.abort();
    await running;
    h.close();
  }
});
