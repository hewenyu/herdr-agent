import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { REPORT_ATTACHMENT_MAX_BYTES } from "../../src/core/report-limits.js";
import type { StoredMessage, Task } from "../../src/core/types.js";
import { assertCodeDelivery, codeDeliveryEvidence } from "../../src/orchestration/code-delivery.js";
import { publishReport, reportText } from "../../src/orchestration/report.js";
import { workflowState } from "../../src/orchestration/state.js";
import type { StatusBlock } from "../../src/orchestration/status-block.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { logger, setup } from "../app/helpers.js";
import { branch, fixture, prUrl } from "./code-delivery-fixture.js";

interface Internals {
  taskOrchestrator: {
    tick(): Promise<void>;
    revision(task: Task, includeWorkflow?: boolean): string;
    workflow: { assertDelivery(task: Task, state: WorkflowState): Promise<void> };
  };
}

async function harness() {
  const git = await fixture();
  await git.initialize();
  await writeFile(join(git.directory, "index.mjs"), "export const answer = 43;\n");
  const h = setup(true, false);
  await h.app.projects.save({ name: "git-report", directories: [git.directory], agent: "codex" });
  const actor = {
    source: "web" as const,
    ownerId: "owner",
    chatId: "web:owner",
    sessionId: "entry",
    messageId: "git-report",
  };
  const task = await h.app.tasks.create(actor, {
    kind: "development",
    title: "代码交付",
    requirements: "实现并独立复核",
    project: "git-report",
    participants: [{ kind: "codex" }, { kind: "claude" }],
    orchestration: { mode: "workflow" },
    createGroup: false,
    createRemoteTask: false,
  });
  task.promptVersion = 3;
  h.app.tasks.records.save(task);
  await h.app.tasks.reconcile(task.id);
  const scheduler = (h.app as unknown as Internals).taskOrchestrator;
  const revision = await workspaceRevision(task.directories);
  const state = workflowState(h.store, task, scheduler.revision(task, false));
  state.phase = "reporting";
  state.planning = "ready";
  state.implementationParticipants = [task.participantIds[0] as string];
  for (const node of state.plan.nodes)
    state.nodes[node.id] = {
      status: "completed",
      attempt: 1,
      artifactRevision: revision,
      participantId: task.participantIds[node.role === "reviewer" ? 1 : 0],
      outputId: `${node.id}-output`,
    };
  state.evidence.push({
    id: "review-evidence",
    source: "agent_review",
    result: "passed",
    description: "独立重跑",
    command: "node --check index.mjs",
    artifactRevision: revision,
    participantId: task.participantIds[1],
    outputId: "validate-output",
  });
  const block: StatusBlock = {
    protocolVersion: 1,
    nodeId: "report",
    operationId: "report-operation",
    inputRevision: "revision",
    status: "completed",
    summary: "代码交付",
    issues: [],
    artifactRefs: [],
    evidence: [],
    blockers: [],
    reportSections: Object.fromEntries(
      state.plan.deliveryRequirements.map((name) => [name, "已完成并记录证据"]),
    ),
  };
  const publish = async () => {
    await publishReport(h.directory, task, state, block, "report-output", revision);
    h.store.set(WORKFLOWS, task.id, state);
  };
  await publish();
  const event: OrchestrationEvent = {
    id: "git-report-event",
    taskId: task.id,
    trigger: "output",
    outputIds: ["report-output"],
    userRevision: scheduler.revision(task),
    state: "done",
    attempts: 1,
    dispatches: [],
    decision: { action: "deliver", reason: "等待报告送达", reportId: state.report?.id },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  h.store.set("task_orchestration_events", event.id, event);
  return {
    ...h,
    git,
    task,
    actor,
    scheduler,
    state,
    revision,
    block,
    event,
    publish,
    async close() {
      await h.close();
      await git.close();
    },
  };
}

for (const mutation of ["empty-commit", "commit", "branch", "detached", "index"])
  test(`frozen Git report rejects ${mutation} changes with identical workspace bytes and can be republished`, async () => {
    const h = await harness();
    try {
      await h.scheduler.workflow.assertDelivery(h.task, h.state);
      const report = structuredClone(h.state.report);
      assert.ok(report?.deliveryRevision);
      const text = await reportText(h.state);
      const evidence = structuredClone(h.state.deliveryEvidence);
      if (mutation === "empty-commit")
        await h.git.git("commit", "--allow-empty", "--quiet", "-m", "Next commit");
      else if (mutation === "commit") {
        await h.git.git("add", "index.mjs");
        await h.git.git("commit", "--quiet", "-m", "Commit current bytes");
      } else if (mutation === "branch")
        await h.git.git("checkout", "--quiet", "-b", "feature/renamed");
      else if (mutation === "detached") await h.git.git("checkout", "--quiet", "--detach");
      else await h.git.git("add", "index.mjs");
      assert.equal(await workspaceRevision(h.task.directories), h.revision);
      await assert.rejects(h.scheduler.workflow.assertDelivery(h.task, h.state), {
        code: "workflow_report",
        message: /Git.*已变化/,
      });
      assert.deepEqual(h.state.report, report);
      assert.deepEqual(h.state.deliveryEvidence, evidence);
      assert.equal(await reportText(h.state), text);
      await h.publish();
      assert.notEqual(h.state.report?.id, report.id);
      assert.notEqual(h.state.report?.deliveryRevision, report.deliveryRevision);
      if (mutation === "index")
        assert.equal(
          await reportText(h.state),
          text,
          "an invisible index change still receives a distinct report and delivery ID",
        );
      assert.equal(
        await readFile(report.path, "utf8"),
        text,
        "the prior frozen file remains immutable",
      );
      await h.scheduler.workflow.assertDelivery(h.task, h.state);
    } finally {
      await h.close();
    }
  });

test("frozen report rejects mutated evidence and legacy v3 contracts, retaining v2/discussion compatibility", async () => {
  const h = await harness();
  try {
    const original = structuredClone(h.state);
    await h.git.git("checkout", "--quiet", "-b", "feature/changed");
    h.state.deliveryEvidence = await codeDeliveryEvidence(h.task);
    await assert.rejects(assertCodeDelivery(h.task, h.state), {
      code: "workflow_report",
      message: /冻结 Git/,
    });
    h.state.deliveryEvidence = original.deliveryEvidence;
    assert.ok(h.state.report);
    delete h.state.report.deliveryRevision;
    await assert.rejects(assertCodeDelivery(h.task, h.state), { code: "workflow_report" });
    await assertCodeDelivery({ ...h.task, promptVersion: 2 }, h.state);
    await assertCodeDelivery({ ...h.task, kind: "discussion" }, h.state);
  } finally {
    await h.close();
  }
});

test("a failed replacement publication cannot attach new Git facts to the previous frozen report", async () => {
  const h = await harness();
  try {
    const report = structuredClone(h.state.report);
    const evidence = structuredClone(h.state.deliveryEvidence);
    await h.git.git("checkout", "--quiet", "-b", "feature/next");
    h.block.reportSections = Object.fromEntries(
      h.state.plan.deliveryRequirements.map((name, index) => [
        name,
        index === 0 ? "x".repeat(REPORT_ATTACHMENT_MAX_BYTES) : "完整章节",
      ]),
    );
    await assert.rejects(h.publish(), { code: "workflow_report" });
    assert.deepEqual(h.state.report, report);
    assert.deepEqual(h.state.deliveryEvidence, evidence);
    await assert.rejects(assertCodeDelivery(h.task, h.state), { code: "workflow_report" });
  } finally {
    await h.close();
  }
});

test("current PR and upstream facts are bound to their frozen report", async () => {
  const h = await harness();
  try {
    const commit = await h.git.git("rev-parse", "HEAD");
    const pr = { url: prUrl, headRefOid: commit, headRefName: branch };
    await h.git.respond({ pr });
    await h.publish();
    const report = structuredClone(h.state.report);
    assert.match(await reportText(h.state), /pull\/42/);
    await h.scheduler.workflow.assertDelivery(h.task, h.state);
    await h.git.respond({ pr: { ...pr, url: "https://github.com/example/project/pull/43" } });
    await assert.rejects(assertCodeDelivery(h.task, h.state), { code: "workflow_report" });
    await h.git.respond({ pr });
    await h.git.git("branch", "delivery-upstream");
    await h.git.git("branch", "--set-upstream-to=delivery-upstream");
    await assert.rejects(assertCodeDelivery(h.task, h.state), { code: "workflow_report" });
    assert.deepEqual(h.state.report, report);
    assert.equal(await workspaceRevision(h.task.directories), h.revision);
  } finally {
    await h.close();
  }
});

test("first notification rejects a report whose branch changed after publication", async () => {
  const h = await harness();
  try {
    await h.git.git("checkout", "--quiet", "-b", "feature/not-the-report");
    await h.scheduler.tick();
    const event = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.equal(event?.state, "attention");
    assert.equal(event.error?.code, "workflow_report");
    assert.notEqual(event.notificationState, "sent");
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "reporting");
    assert.equal(h.store.list("workflow_report_deliveries").length, 0);
    assert.equal(
      h.store
        .list<StoredMessage>("messages")
        .filter((entry) => entry.source === "workflow_report_summary").length,
      0,
    );
  } finally {
    await h.close();
  }
});

test("an unacknowledged Web retry rejects new Git coordinates and retains its prepared envelope", async () => {
  const h = await harness();
  try {
    await h.scheduler.tick();
    const frozen = h.store.get("workflow_report_deliveries", h.event.id);
    assert.ok(frozen);
    const event = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.ok(event);
    event.notificationNextAttemptAt = undefined;
    h.store.set("task_orchestration_events", event.id, event);
    await h.git.git("commit", "--quiet", "--allow-empty", "-m", "New head without source changes");
    await h.scheduler.tick();
    const blocked = h.store.get<OrchestrationEvent>("task_orchestration_events", event.id);
    assert.equal(blocked?.state, "attention");
    assert.equal(blocked.error?.code, "workflow_report");
    assert.equal(blocked.notificationState, "retryable");
    assert.deepEqual(h.store.get("workflow_report_deliveries", event.id), frozen);
    const messages = h.store
      .list<StoredMessage>("messages")
      .filter((entry) => entry.source === "workflow_report_summary");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.delivery, "prepared");
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "reporting");
  } finally {
    await h.close();
  }
});

test("a Git contract failure after upload persists as attention and cannot become a send retry", async () => {
  const h = await harness();
  let uploads = 0;
  let files = 0;
  try {
    const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
    platform.uploadFile = async () => {
      uploads++;
      await h.git.git("checkout", "--quiet", "-b", "feature/changed-during-upload");
      return "frozen-file-key";
    };
    platform.sendFile = async () => {
      files++;
      return "file-message";
    };
    h.app.attachPlatform(platform);
    h.app.tasks.records.save({
      ...h.app.tasks.get(h.actor, h.task.id),
      entryChatId: "fixture-platform-chat",
    });
    await h.scheduler.tick();
    const event = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.equal(event?.state, "attention");
    assert.equal(event.error?.code, "workflow_report");
    assert.notEqual(event.notificationState, "retryable");
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "reporting");
    const frozen = h.store.get<Record<string, unknown>>("workflow_report_deliveries", h.event.id);
    assert.equal(frozen?.fileKey, "frozen-file-key");
    assert.equal(frozen.fileMessageId, undefined);
    await h.git.git("checkout", "--quiet", branch);
    await h.scheduler.tick();
    assert.equal(
      h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id)?.error?.code,
      "workflow_report",
    );
    assert.deepEqual(h.store.get("workflow_report_deliveries", h.event.id), frozen);
    assert.equal(uploads, 1);
    assert.equal(files, 0);
    assert.equal(h.platform.cards.length, 0);
  } finally {
    await h.close();
  }
});

for (const notificationState of ["retryable", "sending", "uncertain"] as const)
  test(`confirmed ${notificationState} receipt revalidates Git after restart without resending or rewriting the envelope`, async () => {
    const h = await harness();
    let restarted: Application | undefined;
    try {
      await h.scheduler.tick();
      const message = h.store
        .list<StoredMessage>("messages")
        .find((entry) => entry.source === "workflow_report_summary");
      assert.ok(message);
      h.app.acknowledgeReport({
        ownerId: "owner",
        sessionId: message.sessionId,
        taskId: h.task.id,
        messageId: message.id,
      });
      const event = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
      assert.ok(event);
      event.notificationState = notificationState;
      event.notificationNextAttemptAt = undefined;
      h.store.set("task_orchestration_events", event.id, event);
      const frozen = h.store.get("workflow_report_deliveries", event.id);
      await h.git.git("add", "index.mjs");
      assert.equal(await workspaceRevision(h.task.directories), h.revision);
      await h.app.shutdown();
      restarted = new Application({
        config: h.config,
        store: h.store,
        engine: h.engine,
        herdr: h.herdr,
        logger,
      });
      const scheduler = (restarted as unknown as Internals).taskOrchestrator;
      await scheduler.tick();
      const blocked = h.store.get<OrchestrationEvent>("task_orchestration_events", event.id);
      assert.equal(blocked?.state, "attention");
      assert.equal(blocked.error?.code, "workflow_report");
      assert.equal(
        blocked.notificationState,
        notificationState,
        "the original delivery certainty must not be downgraded",
      );
      assert.equal(restarted.tasks.get(h.actor, h.task.id).status, "attention");
      assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "reporting");
      assert.equal(
        h.store.get<StoredMessage>("messages", message.id)?.delivery,
        "delivered",
        "a stale report does not erase its actual rendered receipt",
      );
      assert.deepEqual(h.store.get("workflow_report_deliveries", event.id), frozen);
      const messages = h.store.list("messages");
      await scheduler.tick();
      assert.deepEqual(h.store.list("messages"), messages);
      await h.git.git("reset", "--quiet", "HEAD", "--", "index.mjs");
      await assertCodeDelivery(h.task, h.state);
      await scheduler.tick();
      const stillInvalid = h.store.get<OrchestrationEvent>("task_orchestration_events", event.id);
      assert.equal(
        stillInvalid?.state,
        "attention",
        "restoring old Git facts cannot revive a rejected report",
      );
      assert.equal(stillInvalid.error?.code, "workflow_report");
      assert.equal(stillInvalid.notificationState, notificationState);
      assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "reporting");
      assert.equal(h.store.list("workflow_report_deliveries").length, 1);
      assert.equal(h.engine.calls.length, 0);
      assert.equal(h.platform.texts.length, 0);
    } finally {
      await restarted?.shutdown();
      await h.close();
    }
  });

test("an unchanged Git snapshot can recover a confirmed report after restart", async () => {
  const h = await harness();
  let restarted: Application | undefined;
  try {
    await h.scheduler.tick();
    const message = h.store
      .list<StoredMessage>("messages")
      .find((entry) => entry.source === "workflow_report_summary");
    assert.ok(message);
    h.app.acknowledgeReport({
      ownerId: "owner",
      sessionId: message.sessionId,
      taskId: h.task.id,
      messageId: message.id,
    });
    await h.app.shutdown();
    restarted = new Application({
      config: h.config,
      store: h.store,
      engine: h.engine,
      herdr: h.herdr,
      logger,
    });
    await (restarted as unknown as Internals).taskOrchestrator.tick();
    const event = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.equal(event?.notificationState, "sent");
    assert.equal(event.notified, true);
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "awaiting_acceptance");
    assert.equal(h.store.list("workflow_report_deliveries").length, 1);
  } finally {
    await restarted?.shutdown();
    await h.close();
  }
});
