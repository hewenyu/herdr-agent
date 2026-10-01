import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import type { InboxRecord } from "../../src/app/inbox.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import { REPORT_ATTACHMENT_MAX_BYTES } from "../../src/core/report-limits.js";
import type { StoredMessage, Task } from "../../src/core/types.js";
import { assertCodeDelivery, codeDeliveryEvidence } from "../../src/orchestration/code-delivery.js";
import { publishReport, reportText } from "../../src/orchestration/report.js";
import { ReportDeliveries, type ReportDelivery } from "../../src/orchestration/report-delivery.js";
import { workflowState } from "../../src/orchestration/state.js";
import type { StatusBlock } from "../../src/orchestration/status-block.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import type { TaskUserRevision } from "../../src/tasks/user-request.js";
import { logger, message, setup } from "../app/helpers.js";
import { chooseLeaderAction } from "../app/leader-helpers.js";
import { branch, fixture, prUrl } from "./code-delivery-fixture.js";

interface Internals {
  reportDeliveries: ReportDeliveries;
  taskOrchestrator: {
    tick(): Promise<void>;
    revision(task: Task, includeWorkflow?: boolean): string;
    workflow: { assertDelivery(task: Task, state: WorkflowState): Promise<void> };
  };
}

async function failedCardReport() {
  const h = await harness();
  const calls = { uploads: 0, files: 0, cards: 0 };
  const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
  platform.uploadFile = async () => `file-key-${++calls.uploads}`;
  platform.sendFile = async () => `file-message-${++calls.files}`;
  h.platform.cardHook = async () => {
    if (++calls.cards === 1) throw new OperationError("platform_unavailable", "known not sent");
  };
  h.app.attachPlatform(platform);
  const chatId = await platform.createGroup("报告群", h.actor.ownerId, "transport-report-group");
  h.app.tasks.records.save({ ...h.app.tasks.get(h.actor, h.task.id), chatId, keepGroup: false });
  await h.scheduler.tick();
  const event = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
  assert.equal(event?.state, "done");
  assert.equal(event.notificationState, "retryable");
  assert.equal(event.error?.code, "orchestration_notification_failed");
  const record = h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id);
  assert.ok(record);
  assert.equal(record.fileState, "delivered");
  assert.equal(record.cardState, "retryable");
  const receipts = (h.app as unknown as Internals).reportDeliveries;
  assert.equal(receipts.pendingInChat(chatId), true);
  assert.equal(receipts.retryable(h.task.id, event.id, record.reportId), true);
  return { ...h, calls, chatId, failedEvent: event, record, receipts };
}

async function harness() {
  const git = await fixture();
  await git.initialize();
  await writeFile(join(git.directory, "index.mjs"), "export const answer = 43;\n");
  const h = setup(true, false);
  h.engine.handler = async (input) => ({
    text: (await chooseLeaderAction(input))
      ? ""
      : input.sessionId.startsWith("notice:")
        ? '{"notify":true,"text":"进度通知"}'
        : h.engine.response,
    messages: [],
  });
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

for (const failure of ["workflow_report", "workflow_artifact"] as const)
  test(`first delivery candidate persists ${failure} immediately instead of retrying execution`, async () => {
    const h = await harness();
    let uploads = 0;
    let files = 0;
    try {
      // This must create/select/execute the initial candidate, not restore a done notification.
      h.store.delete("task_orchestration_events", h.event.id);
      const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
      platform.uploadFile = async () => {
        uploads++;
        await h.git.git("checkout", "--quiet", "-b", "feature/first-delivery-drift");
        return "first-upload-key";
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
      if (failure === "workflow_artifact") {
        h.state.artifacts.push({
          path: join(h.git.directory, "index.mjs"),
          reference: "index.mjs",
          hash: "incorrect-file-evidence",
          outputId: "implementation-output",
          artifactRevision: h.revision,
        });
        h.store.set(WORKFLOWS, h.task.id, h.state);
      }
      await h.scheduler.tick();
      const events = h.store.list<OrchestrationEvent>("task_orchestration_events");
      assert.equal(events.length, 1);
      const event = events[0];
      assert.ok(event);
      assert.ok(event.workflow);
      assert.equal(event.workflow.candidate.kind, "deliver");
      assert.equal(event.attempts, 1);
      assert.equal(
        event.state,
        "attention",
        "the first failed execution must not enter pending/backoff",
      );
      assert.equal(event.error?.code, failure);
      assert.equal(event.nextAttemptAt, undefined);
      assert.equal(h.app.tasks.get(h.actor, h.task.id).status, "attention");
      assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "reporting");
      const frozen = h.store.get("workflow_report_deliveries", event.id);
      if (failure === "workflow_report") {
        assert.equal(event.workflow.applied, true);
        assert.ok(frozen);
        await h.git.git("checkout", "--quiet", branch);
      } else {
        assert.notEqual(event.workflow.applied, true);
        assert.equal(frozen, undefined);
        h.state.artifacts = [];
        h.store.set(WORKFLOWS, h.task.id, h.state);
      }
      await h.scheduler.workflow.assertDelivery(h.task, h.state);
      await h.scheduler.tick();
      await h.scheduler.tick();
      const current = h.store.get<OrchestrationEvent>("task_orchestration_events", event.id);
      assert.equal(
        current?.state,
        "attention",
        "restored facts do not revive a rejected candidate",
      );
      assert.equal(current.attempts, 1);
      assert.equal(current.error?.code, failure);
      assert.equal(h.store.list("task_orchestration_events").length, 1);
      assert.deepEqual(h.store.get("workflow_report_deliveries", event.id), frozen);
      assert.equal(uploads, failure === "workflow_report" ? 1 : 0);
      assert.equal(files, 0);
      assert.equal(h.platform.cards.length, 0);
    } finally {
      await h.close();
    }
  });

test("resume and replacement delivery allow group cleanup after a superseded partial report, including restart", async () => {
  const h = await harness();
  let restarted: Application | undefined;
  let uploads = 0;
  let files = 0;
  try {
    const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
    platform.uploadFile = async () => `file-key-${++uploads}`;
    platform.sendFile = async () => {
      files++;
      if (files === 1)
        await h.git.git("checkout", "--quiet", "-b", "feature/new-report-before-card");
      return `file-message-${files}`;
    };
    h.app.attachPlatform(platform);
    const chatId = await platform.createGroup("报告群", h.actor.ownerId, "report-group");
    h.app.tasks.records.save({
      ...h.app.tasks.get(h.actor, h.task.id),
      chatId,
      keepGroup: false,
    });
    await h.scheduler.tick();
    const oldEvent = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.equal(oldEvent?.state, "attention");
    assert.equal(oldEvent.error?.code, "workflow_report");
    assert.equal(h.app.tasks.get(h.actor, h.task.id).status, "attention");
    const old = h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id);
    assert.ok(old);
    assert.equal(old.fileState, "delivered");
    assert.equal(old.cardState, "prepared");
    const receipts = new ReportDeliveries(h.store, h.app.outbox, () => platform);
    assert.equal(receipts.pendingInChat(chatId), true);
    assert.equal(
      h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id)?.retired,
      undefined,
      "a contract failure alone cannot authorize abandoning the incomplete delivery",
    );

    const resumed = await h.app.tasks.action(
      { ...h.actor, messageId: "resume-new-report" },
      h.task.id,
      "resume",
    );
    // Simulate the replacement report's completed work, while using the real resume,
    // supersession, candidate execution, notification and cleanup paths.
    h.state.userRevision = h.scheduler.revision(resumed, false);
    h.state.plan.version++;
    h.state.phase = "reporting";
    await h.publish();
    assert.notEqual(h.state.report?.id, old.reportId);
    await h.scheduler.tick();
    assert.equal(
      h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id)?.state,
      "superseded",
    );
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "awaiting_acceptance");
    assert.equal(uploads, 2);
    assert.equal(files, 2);
    assert.equal(h.platform.cards.length, 1, "only the current report receives a summary");
    assert.equal(
      h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id)?.retired,
      undefined,
      "the restart must discover the old incomplete record lazily",
    );
    await h.app.shutdown();
    restarted = new Application({
      config: h.config,
      store: h.store,
      engine: h.engine,
      herdr: h.herdr,
      platform,
      logger,
    });
    await restarted.tasks.action({ ...h.actor, messageId: "accept-report" }, h.task.id, "complete");
    await restarted.tasks.reconcile(h.task.id);
    await restarted.tasks.reconcile(h.task.id);
    assert.equal(restarted.tasks.get(h.actor, h.task.id).status, "destroyed");
    assert.equal(restarted.tasks.get(h.actor, h.task.id).groupDeleted, true);
    assert.equal(h.platform.deletions, 1);
    assert.equal(h.herdr.closes, 2);
    const retired = h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id);
    assert.equal(retired?.retired?.reason, "superseded");
    assert.equal(retired?.fileMessageId, old.fileMessageId);
    assert.equal(retired?.fileState, "delivered");
    assert.equal(retired?.cardState, "prepared");
    const recovered = new ReportDeliveries(h.store, restarted.outbox, () => platform);
    assert.equal(recovered.retryable(h.task.id, h.event.id, old.reportId), false);
    assert.equal(await recovered.confirmed(h.task.id, h.event.id, old.reportId), false);
    await assert.rejects(recovered.send(old), { code: "report_delivery_retired" });
    assert.equal(recovered.download(h.task.id, old.cardId).content, old.text);
    assert.equal(uploads, 2);
    assert.equal(files, 2);
    assert.equal(h.platform.cards.length, 1);
  } finally {
    await restarted?.shutdown();
    await h.close();
  }
});

for (const checkpoint of ["retryable", "sending", "uncertain"] as const)
  test(`a replaced done report with ${checkpoint} notification checkpoint cannot trap cleanup after restart`, async () => {
    const h = await failedCardReport();
    let restarted: Application | undefined;
    try {
      const resumed = await h.app.tasks.action(
        { ...h.actor, messageId: `transport-resume-${checkpoint}` },
        h.task.id,
        "resume",
      );
      h.state.userRevision = h.scheduler.revision(resumed, false);
      h.state.plan.version++;
      h.state.phase = "reporting";
      await h.publish();
      assert.notEqual(h.state.report?.id, h.record.reportId);
      await h.scheduler.tick();
      assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "awaiting_acceptance");
      assert.equal(
        h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id)?.state,
        "done",
        "the old executed business event is not rewritten as failed or superseded",
      );
      assert.deepEqual(h.calls, { uploads: 2, files: 2, cards: 2 });
      assert.equal(
        h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id)?.retired,
        undefined,
      );
      // Recreate durable upper-layer crash checkpoints: the definitive transport
      // receipt is already saved, while notification recovery has not settled it.
      h.store.set("task_orchestration_events", h.event.id, {
        ...h.failedEvent,
        notificationState: checkpoint,
      });
      await h.app.tasks.action(
        { ...h.actor, messageId: "accept-replacement" },
        h.task.id,
        "complete",
      );
      await h.app.shutdown();
      restarted = new Application({
        config: h.config,
        store: h.store,
        engine: h.engine,
        herdr: h.herdr,
        platform: h.platform,
        logger,
      });
      await restarted.tasks.reconcile(h.task.id);
      await restarted.tasks.reconcile(h.task.id);
      assert.equal(restarted.tasks.get(h.actor, h.task.id).status, "destroyed");
      assert.equal(h.platform.deletions, 1);
      assert.equal(h.herdr.closes, 2);
      const retired = h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id);
      assert.equal(retired?.retired?.reason, "stale_report");
      const { retired: _retired, updatedAt: _updated, ...facts } = retired as ReportDelivery;
      const { updatedAt: _oldUpdated, ...originalFacts } = h.record;
      assert.deepEqual(facts, originalFacts);
      const receipts = (restarted as unknown as Internals).reportDeliveries;
      assert.equal(receipts.retryable(h.task.id, h.event.id, h.record.reportId), false);
      assert.equal(await receipts.confirmed(h.task.id, h.event.id, h.record.reportId), false);
      await assert.rejects(receipts.send(h.record), { code: "report_delivery_retired" });
      assert.equal(receipts.download(h.task.id, h.record.cardId).content, h.record.text);
      assert.deepEqual(h.calls, { uploads: 2, files: 2, cards: 2 });
    } finally {
      await restarted?.shutdown();
      await h.close();
    }
  });

for (const change of ["user_revision", "report"] as const)
  test(`cleanup retires a done report after ${change} changes, but pause or completion alone never retires a valid retry`, async () => {
    const h = await failedCardReport();
    let restarted: Application | undefined;
    try {
      await h.app.tasks.action({ ...h.actor, messageId: "pause" }, h.task.id, "pause");
      assert.equal(h.receipts.pendingInChat(h.chatId), true);
      assert.equal(h.receipts.retryable(h.task.id, h.event.id, h.record.reportId), true);
      await h.app.tasks.action(
        { ...h.actor, messageId: "complete-current" },
        h.task.id,
        "complete",
      );
      await h.app.tasks.reconcile(h.task.id);
      assert.equal(h.app.tasks.get(h.actor, h.task.id).status, "destroying");
      assert.equal(h.platform.deletions, 0);
      assert.equal(h.receipts.pendingInChat(h.chatId), true);
      assert.equal(h.receipts.retryable(h.task.id, h.event.id, h.record.reportId), true);
      assert.equal(
        h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id)?.retired,
        undefined,
      );
      // Upgrade recovery must use actual persisted revision/report invalidation,
      // even when the scheduler no longer admits this destroying task.
      const current = h.app.tasks.get(h.actor, h.task.id);
      if (change === "user_revision") {
        h.app.tasks.records.save({
          ...current,
          requirements: `${current.requirements}；已修订交付要求`,
        });
        assert.equal(
          h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.report?.id,
          h.record.reportId,
        );
      } else {
        h.block.reportSections = Object.fromEntries(
          h.state.plan.deliveryRequirements.map((name) => [name, "已修订报告结论"]),
        );
        await h.publish();
        assert.notEqual(h.state.report?.id, h.record.reportId);
        assert.equal(h.scheduler.revision(current), h.failedEvent.userRevision);
      }
      await h.app.shutdown();
      restarted = new Application({
        config: h.config,
        store: h.store,
        engine: h.engine,
        herdr: h.herdr,
        platform: h.platform,
        logger,
      });
      await restarted.tasks.reconcile(h.task.id);
      assert.equal(restarted.tasks.get(h.actor, h.task.id).status, "destroyed");
      assert.equal(h.platform.deletions, 1);
      assert.equal(h.herdr.closes, 2);
      assert.equal(
        h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id)?.retired?.reason,
        "stale_report",
      );
      assert.deepEqual(h.calls, { uploads: 1, files: 1, cards: 1 });
    } finally {
      await restarted?.shutdown();
      await h.close();
    }
  });

for (const chatType of ["group", "private"] as const)
  for (const action of ["pause", "complete"] as const)
    test(`real Feishu ${chatType} ${action} provenance cannot discard a current failed report card`, async () => {
      const h = await failedCardReport();
      let restarted: Application | undefined;
      const errors: unknown[] = [];
      try {
        h.store.set("task_orchestration_events", h.event.id, {
          ...h.failedEvent,
          notificationNextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        });
        const report = structuredClone(h.state.report);
        const before = h.scheduler.revision(h.app.tasks.get(h.actor, h.task.id));
        h.engine.handler = async (turn) => {
          try {
            assert.equal(turn.actor.source, "feishu");
            assert.equal(turn.actor.chatType, chatType);
            const tool = turn.tools.find((entry) => entry.name === "task_action");
            assert.ok(tool);
            await tool.execute(
              {
                action,
                ...(chatType === "private"
                  ? {
                      taskId: h.task.id,
                      ...(action === "complete" ? { keepGroup: true, keepExecution: true } : {}),
                    }
                  : {}),
              },
              turn.actor,
            );
            return { text: "已记录本次控制操作。", messages: [] };
          } catch (error) {
            errors.push(error);
            throw error;
          }
        };
        const messageId = `${chatType}-${action}`;
        await h.app.handlers().message({
          ...message(
            messageId,
            action === "pause" ? "暂停一下，等我回来" : "验收通过，完成这个任务",
            chatType === "group" ? h.chatId : "entry",
          ),
          chatType,
          mentionedBot: true,
        });
        await h.app.inbox.drain();
        assert.deepEqual(errors, []);
        assert.equal(h.store.get<InboxRecord>("inbox", `message:${messageId}`)?.state, "done");
        const provenance = h.store
          .list<TaskUserRevision>("task_user_revisions")
          .find((entry) => entry.source.messageId === messageId);
        assert.equal(provenance?.usage, "control");
        assert.equal(provenance?.taskId, h.task.id);
        assert.equal(provenance?.source.source, "feishu");
        assert.equal(h.scheduler.revision(h.app.tasks.get(h.actor, h.task.id)), before);
        await h.scheduler.tick();
        await h.app.tasks.reconcile(h.task.id);
        assert.deepEqual(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.report, report);
        assert.equal(h.receipts.pendingInChat(h.chatId), true);
        assert.equal(
          h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id)?.retired,
          undefined,
        );
        assert.equal(h.platform.deletions, 0);
        await h.app.shutdown();
        restarted = new Application({
          config: h.config,
          store: h.store,
          engine: h.engine,
          herdr: h.herdr,
          platform: h.platform,
          logger,
        });
        await restarted.tasks.reconcile(h.task.id);
        assert.equal(
          (restarted as unknown as Internals).reportDeliveries.pendingInChat(h.chatId),
          true,
        );
        assert.equal(h.platform.deletions, 0);
        assert.deepEqual(h.calls, { uploads: 1, files: 1, cards: 1 });
        if (action === "complete") {
          const pending = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
          assert.ok(pending);
          h.store.set("task_orchestration_events", h.event.id, {
            ...pending,
            notificationNextAttemptAt: undefined,
          });
          const inputs = h.herdr.sends.length;
          await (restarted as unknown as Internals).taskOrchestrator.tick();
          await restarted.tasks.reconcile(h.task.id);
          await (restarted as unknown as Internals).taskOrchestrator.tick();
          assert.deepEqual(h.calls, { uploads: 1, files: 1, cards: 2 });
          assert.equal(
            h.herdr.sends.length,
            inputs,
            "completion resumes notification only, never native work",
          );
          assert.equal(h.platform.deletions, chatType === "group" ? 1 : 0);
          assert.equal(
            restarted.tasks.get(h.actor, h.task.id).status,
            chatType === "group" ? "destroyed" : "completed",
          );
          assert.equal(
            h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id)?.retired,
            undefined,
          );
          assert.equal(
            await (restarted as unknown as Internals).reportDeliveries.confirmed(
              h.task.id,
              h.event.id,
              h.record.reportId,
            ),
            true,
          );
        }
      } finally {
        await restarted?.shutdown();
        await h.close();
      }
    });

for (const action of ["resume", "reopen"] as const)
  test(`real Feishu ${action} retains an explicit report input revision`, async () => {
    const h = await failedCardReport();
    const errors: unknown[] = [];
    try {
      if (action === "reopen")
        await h.app.tasks.action(
          { ...h.actor, messageId: "complete-keep" },
          h.task.id,
          "complete",
          { keepExecution: true, keepGroup: true },
        );
      h.engine.handler = async (turn) => {
        try {
          assert.equal(turn.actor.source, "feishu");
          const tool = turn.tools.find((entry) => entry.name === "task_action");
          assert.ok(tool);
          await tool.execute({ action, taskId: h.task.id }, turn.actor);
          return { text: "已记录恢复操作。", messages: [] };
        } catch (error) {
          errors.push(error);
          throw error;
        }
      };
      await h.app.handlers().message(message(`real-${action}`, "请恢复这个任务", "entry"));
      await h.app.inbox.drain();
      assert.deepEqual(errors, []);
      assert.equal(h.store.get<InboxRecord>("inbox", `message:real-${action}`)?.state, "done");
      const source = h.store
        .list<TaskUserRevision>("task_user_revisions")
        .find((entry) => entry.source.messageId === `real-${action}`);
      assert.equal(source?.usage, "input");
      assert.notEqual(
        h.scheduler.revision(h.app.tasks.get(h.actor, h.task.id)),
        h.failedEvent.userRevision,
      );
      assert.equal(h.receipts.pendingInChat(h.chatId), false);
      assert.equal(
        h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id)?.retired?.reason,
        "stale_report",
      );
      assert.deepEqual(h.calls, { uploads: 1, files: 1, cards: 1 });
    } finally {
      await h.close();
    }
  });

test("legacy partial reports without revision evidence keep their barrier until an actual replacement report exists", async () => {
  const h = await failedCardReport();
  try {
    const { revisionEvidence: _evidence, ...legacy } = h.record;
    h.store.set("workflow_report_deliveries", h.event.id, legacy);
    const current = h.app.tasks.get(h.actor, h.task.id);
    h.app.tasks.records.save({
      ...current,
      requirements: "新的需求，但历史回执不能推造旧需求快照",
    });
    assert.equal(h.receipts.pendingInChat(h.chatId), true);
    assert.equal(
      h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id)?.retired,
      undefined,
    );
    h.block.reportSections = Object.fromEntries(
      h.state.plan.deliveryRequirements.map((name) => [name, "替代报告实际产出"]),
    );
    await h.publish();
    assert.notEqual(h.state.report?.id, h.record.reportId);
    assert.equal(h.receipts.pendingInChat(h.chatId), false);
    assert.equal(
      h.store.get<ReportDelivery>("workflow_report_deliveries", h.event.id)?.retired?.reason,
      "stale_report",
    );
    assert.deepEqual(h.calls, { uploads: 1, files: 1, cards: 1 });
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
