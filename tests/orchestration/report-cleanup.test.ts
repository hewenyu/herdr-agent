import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Application } from "../../src/app/application.js";
import type {
  OrchestrationEvent,
  TaskOrchestratorOptions,
} from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { PlatformPort } from "../../src/core/ports.js";
import type { Task } from "../../src/core/types.js";
import { inspectArtifact } from "../../src/orchestration/board.js";
import { compileConsensus } from "../../src/orchestration/consensus.js";
import { addDocumentDelivery } from "../../src/orchestration/document-delivery.js";
import { prepareDocumentSource } from "../../src/orchestration/document-source.js";
import { publishReport } from "../../src/orchestration/report.js";
import { finishReportNotifications } from "../../src/orchestration/report-cleanup.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { Store } from "../../src/storage/store.js";
import { setup } from "../app/helpers.js";

function fixture() {
  const store = new Store(":memory:");
  const task = {
    id: "task",
    promptVersion: 3,
    orchestration: { mode: "workflow" },
    status: "destroying",
    completedAt: "12345",
  } as Task;
  const event = {
    id: "event",
    taskId: "task",
    state: "done",
    userRevision: "revision",
    decision: { action: "deliver", reportId: "report" },
    notificationState: "retryable",
    dispatches: [],
  } as unknown as OrchestrationEvent;
  store.set("task_orchestration_events", event.id, event);
  store.set("workflow_report_deliveries", event.id, {
    taskId: task.id,
    eventId: event.id,
    reportId: "report",
    channel: "platform",
  });
  store.set(WORKFLOWS, task.id, { report: { id: "report" } });
  return { store, task, event };
}

test("cleanup notification contract failure stays attention even if later checks would succeed", async () => {
  const h = fixture();
  let notifications = 0;
  try {
    const ports = {
      store: h.store,
      revision: () => "revision",
      recover: async () => {},
      notify: async () => {
        notifications++;
        throw new OperationError("workflow_report", "文件变化，冻结合同失效");
      },
    };
    await finishReportNotifications(h.task, [h.event], ports);
    assert.equal(h.event.state, "attention");
    assert.equal(h.event.error?.code, "workflow_report");
    const restored = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.ok(restored);
    await finishReportNotifications(h.task, [restored], {
      ...ports,
      notify: async () => {
        notifications++;
      },
    });
    assert.equal(notifications, 1);
    assert.equal(restored.state, "attention");
  } finally {
    h.store.close();
  }
});

test("remote not-completed sentinel cannot authorize cleanup report recovery", async () => {
  const h = fixture();
  try {
    await finishReportNotifications({ ...h.task, completedAt: "0" }, [h.event], {
      store: h.store,
      revision: () => "revision",
      recover: async () => {
        assert.fail("completion is not confirmed");
      },
      notify: async () => {
        assert.fail("completion is not confirmed");
      },
    });
    assert.equal(h.event.state, "done");
  } finally {
    h.store.close();
  }
});

test("cleanup preserves an unresolved notification result instead of retrying its frozen message", async () => {
  const h = fixture();
  try {
    h.event.notificationState = "sending";
    await finishReportNotifications(h.task, [h.event], {
      store: h.store,
      revision: () => "revision",
      recover: async (_task, event) => {
        event.notificationState = "uncertain";
      },
      notify: async () => {
        assert.fail("unknown transport cannot be replayed during cleanup");
      },
    });
    assert.equal(h.event.notificationState, "uncertain");
  } finally {
    h.store.close();
  }
});

interface Internals {
  taskOrchestrator: {
    options: TaskOrchestratorOptions;
    tick(): Promise<void>;
    revision(task: Task, includeWorkflow?: boolean): string;
    assertNotificationDelivery(task: Task, state: WorkflowState): Promise<void>;
  };
}

async function consensusReportFixture() {
  const h = setup(true, false);
  const repo = join(h.directory, "repository");
  await mkdir(join(repo, "docs"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, ".gitignore"), "docs/\n");
  const document = "docs/DESIGN.md";
  const original = "# 共同认可的设计\n\n使用有界队列。\n";
  await writeFile(join(repo, document), original);
  await h.app.projects.save({ name: "consensus-report", directories: [repo], agent: "codex" });
  const actor = {
    source: "web" as const,
    ownerId: "owner",
    chatId: "web:owner",
    sessionId: "entry",
    messageId: "consensus-report",
  };
  const task = await h.app.tasks.create(actor, {
    kind: "discussion",
    title: "交付共同认可文档",
    requirements: "讨论并保存 docs/DESIGN.md，双方认可同版文档后交付。",
    project: "consensus-report",
    participants: [{ kind: "codex" }, { kind: "claude" }],
    orchestration: { mode: "workflow" },
    createGroup: false,
    createRemoteTask: false,
  });
  await h.app.tasks.reconcile(task.id);
  const scheduler = (h.app as Application as unknown as Internals).taskOrchestrator;
  const errors: unknown[] = [];
  scheduler.options.logger = {
    ...scheduler.options.logger,
    error: (...args) => {
      errors.push(args);
    },
  };
  const state = workflowState(h.store, task, scheduler.revision(task, false));
  state.plan.documentDelivery = { paths: [document], userRequest: task.requirements };
  addDocumentDelivery(state.plan);
  compileConsensus(state.plan, task.participantIds);
  state.documentSource = await prepareDocumentSource(h.store, task, state);
  const revision = await workspaceRevision(task.directories);
  const artifact = await inspectArtifact(task, document);
  state.artifacts.push({
    ...artifact,
    reference: document,
    outputId: "document-output",
    artifactRevision: revision,
  });
  state.phase = "reporting";
  state.planning = "ready";
  state.consensusApprovals = [];
  for (const node of state.plan.nodes) {
    const participantId =
      node.participantId ?? task.participantIds[node.role === "reviewer" ? 1 : 0];
    assert.ok(participantId);
    state.nodes[node.id] = {
      status: "completed",
      attempt: 1,
      artifactRevision: revision,
      participantId,
      outputId: `${node.id}-output`,
    };
    if (node.consensus)
      state.consensusApprovals.push({
        participantId,
        outputId: `${node.id}-output`,
        artifactRevision: revision,
        documents: [{ path: document, hash: artifact.hash }],
      });
  }
  await publishReport(
    h.directory,
    task,
    state,
    {
      protocolVersion: 1,
      nodeId: "report",
      operationId: "report-operation",
      inputRevision: "revision",
      status: "completed",
      summary: "共同认可的文档交付",
      issues: [],
      artifactRefs: [document],
      evidence: [],
      blockers: [],
      reportSections: Object.fromEntries(
        state.plan.deliveryRequirements.map((name) => [name, "双方已认可同版文档"]),
      ),
    },
    "report-output",
    revision,
  );
  h.store.set(WORKFLOWS, task.id, state);
  await scheduler.assertNotificationDelivery(task, state);
  assert.ok(state.report);
  const report = structuredClone(state.report);
  const frozen = await readFile(report.path, "utf8");
  const event: OrchestrationEvent = {
    id: "frozen-consensus-report",
    taskId: task.id,
    trigger: "output",
    outputIds: ["report-output"],
    userRevision: scheduler.revision(task),
    state: "done",
    attempts: 1,
    dispatches: [],
    decision: { action: "deliver", reason: "补投已冻结报告", reportId: report.id },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  h.store.set("task_orchestration_events", event.id, event);
  const calls = { uploads: 0, files: 0, cards: 0 };
  const platform: PlatformPort = h.platform;
  platform.uploadFile = async () => `file-key-${++calls.uploads}`;
  platform.sendFile = async () => `file-message-${++calls.files}`;
  h.platform.cardHook = async () => {
    calls.cards++;
  };
  h.app.attachPlatform(platform);
  const chatId = await platform.createGroup("文档交付群", actor.ownerId, "consensus-report");
  h.app.tasks.records.save({ ...h.app.tasks.get(actor, task.id), chatId, keepGroup: false });
  return {
    ...h,
    actor,
    task,
    scheduler,
    errors,
    state,
    report,
    frozen,
    event,
    calls,
    repo,
    document,
    original,
    revision,
  };
}

for (const checkpoint of ["before_notify", "sending"] as const)
  test(`completion stops a frozen consensus report at attention when its document changes (${checkpoint})`, async () => {
    const h = await consensusReportFixture();
    try {
      if (checkpoint === "sending") {
        h.event.notificationState = "sending";
        h.store.set("task_orchestration_events", h.event.id, h.event);
      }
      await h.app.tasks.action({ ...h.actor, messageId: "accept-report" }, h.task.id, "complete");
      await h.app.tasks.reconcile(h.task.id);
      assert.equal(h.app.tasks.get(h.actor, h.task.id).status, "destroying");
      assert.equal(h.platform.deletions, 0);
      await writeFile(join(h.repo, h.document), "# 未经双方认可的新设计\n\n改用无界队列。\n");
      assert.equal(await workspaceRevision(h.task.directories), h.revision);
      await h.scheduler.tick();
      const stopped = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
      assert.equal(stopped?.state, "attention");
      assert.equal(stopped?.error?.code, "workflow_consensus");
      assert.notEqual(stopped?.notified, true);
      assert.deepEqual(
        h.errors,
        [],
        "consensus invalidation is classified, not a scheduler failure",
      );
      for (let repeat = 0; repeat < 2; repeat++) {
        await h.scheduler.tick();
        await h.app.tasks.reconcile(h.task.id);
      }
      assert.deepEqual(h.calls, { uploads: 0, files: 0, cards: 0 });
      assert.equal(h.platform.deletions, 0);
      assert.equal(h.app.tasks.get(h.actor, h.task.id).status, "destroying");
      assert.deepEqual(h.errors, []);
      assert.deepEqual(h.store.get("task_orchestration_events", h.event.id), stopped);
      assert.equal(await readFile(h.report.path, "utf8"), h.frozen);
      assert.equal(h.store.get("workflow_report_deliveries", h.event.id), undefined);
      assert.equal(h.herdr.sends.length, 0);
      await writeFile(join(h.repo, h.document), h.original);
      await h.scheduler.tick();
      await h.app.tasks.reconcile(h.task.id);
      assert.deepEqual(h.calls, { uploads: 0, files: 0, cards: 0 });
      assert.equal(
        h.platform.deletions,
        0,
        "restoring bytes cannot silently approve the stopped report",
      );
      assert.deepEqual(h.store.get("task_orchestration_events", h.event.id), stopped);
    } finally {
      await h.close();
    }
  });
