import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import type { StoredMessage, Task } from "../../src/core/types.js";
import { prepareDocumentSource } from "../../src/orchestration/document-source.js";
import { publishReport } from "../../src/orchestration/report.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import type { WebReportReceipt } from "../../src/web/contracts.js";
import { startWeb } from "../../src/web/server.js";
import { logger, setup } from "../app/helpers.js";

interface Internals {
  taskOrchestrator: {
    tick(): Promise<void>;
    revision(task: Task, includeWorkflow?: boolean): string;
    recoverNotification(task: Task, event: OrchestrationEvent): Promise<void>;
    workflow: { assertDelivery(task: Task, state: WorkflowState): Promise<void> };
  };
}

async function harness(version: 2 | 3 = 3) {
  const h = setup(true, false);
  const directory = join(h.directory, "repo");
  await mkdir(directory);
  await h.app.projects.save({ name: "report", directories: [directory], agent: "codex" });
  const actor = {
    source: "web" as const,
    ownerId: "owner",
    chatId: "web:owner",
    sessionId: "entry",
    messageId: "report",
  };
  const task = await h.app.tasks.create(actor, {
    kind: "discussion",
    title: "Web报告",
    requirements: "讨论方案",
    project: "report",
    participants: [{ kind: "codex" }, { kind: "claude" }],
    orchestration: { mode: "workflow" },
    createGroup: false,
    createRemoteTask: false,
  });
  task.promptVersion = version;
  h.app.tasks.records.save(task);
  await h.app.tasks.reconcile(task.id);
  const scheduler = (h.app as unknown as Internals).taskOrchestrator;
  const state = workflowState(h.store, task, scheduler.revision(task, false));
  const revision = await workspaceRevision(task.directories);
  state.phase = "reporting";
  state.planning = "ready";
  if (version === 3) state.documentSource = await prepareDocumentSource(h.store, task, state);
  for (const node of state.plan.nodes)
    state.nodes[node.id] = {
      status: "completed",
      attempt: 1,
      participantId: task.participantIds[0],
      artifactRevision: revision,
    };
  await publishReport(
    h.directory,
    task,
    state,
    {
      protocolVersion: 1,
      nodeId: "report",
      operationId: "report-op",
      inputRevision: "revision",
      status: "completed",
      summary: "已整理方案",
      issues: [],
      artifactRefs: [],
      evidence: [],
      blockers: [],
      reportSections: Object.fromEntries(
        state.plan.deliveryRequirements.map((name) => [name, "实际讨论结论"]),
      ),
    },
    "report-output",
    revision,
  );
  h.store.set(WORKFLOWS, task.id, state);
  const event: OrchestrationEvent = {
    id: "report-event",
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
  await scheduler.tick();
  const message = h.store
    .list<StoredMessage>("messages")
    .find((entry) => entry.source === "workflow_report_summary");
  assert.ok(message);
  const input: WebReportReceipt = {
    ownerId: "owner",
    sessionId: message.sessionId,
    taskId: task.id,
    messageId: message.id,
  };
  const web = await startWeb({
    listen: "127.0.0.1:0",
    backend: h.app,
    assets: {
      "index.html": '<meta name="csrf-token" content="__CSRF_TOKEN__">',
      "styles.css": "",
      "app.js": "",
    },
  });
  const token = (await (await fetch(web.url)).text()).match(/content="([^"]+)"/)?.[1] ?? "";
  const post = (body: unknown, csrf = token, origin = web.url) =>
    fetch(`${web.url}/api/reports/ack`, {
      method: "POST",
      headers: { Origin: origin, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { ...h, task, actor, state, event, scheduler, message, input, web, post };
}

test("Web report ACK is CSRF-protected and scoped to its frozen owner/session/task/message", async () => {
  const h = await harness();
  try {
    await fetch(`${h.web.url}/api/state?ownerId=owner`);
    await fetch(`${h.web.url}/api/reports?ownerId=owner&messageId=${h.message.id}`);
    assert.equal(h.store.get<StoredMessage>("messages", h.message.id)?.delivery, "prepared");
    assert.equal((await h.post(h.input, "wrong")).status, 403);
    assert.equal((await h.post(h.input, undefined, "https://other.invalid")).status, 403);
    h.config.feishu.allowedOpenIds.push("other");
    const session = h.app.sessions.current("owner", "web:other-session");
    for (const change of [
      { ownerId: "other" },
      { sessionId: session.id },
      { taskId: "other-task" },
      { messageId: "missing" },
      { action: "task.complete" },
      { taskId: undefined },
    ])
      assert.equal((await h.post({ ...h.input, ...change })).status, 400);
    const ordinary = h.app.sessions.recordExternal(
      { ...h.actor, taskId: h.task.id, sessionId: h.message.sessionId },
      {
        id: "ordinary",
        text: "普通准备消息",
        pendingDelivery: true,
        source: "lifecycle",
      },
    );
    assert.equal((await h.post({ ...h.input, messageId: ordinary.id })).status, 400);
    const record = h.store.get<Record<string, unknown>>("workflow_report_deliveries", h.event.id);
    assert.ok(record);
    h.store.set("workflow_report_deliveries", h.event.id, { ...record, text: "tampered" });
    assert.equal((await h.post(h.input)).status, 400);
    h.store.set("workflow_report_deliveries", h.event.id, record);
    h.store.set("messages", h.message.id, { ...h.message, generation: h.message.generation - 1 });
    assert.equal((await h.post(h.input)).status, 400);
    assert.equal(h.store.get<StoredMessage>("messages", h.message.id)?.delivery, "prepared");
    h.store.set("messages", h.message.id, h.message);
    assert.equal((await h.post(h.input)).status, 200);
    assert.equal((await h.post(h.input)).status, 200, "same receipt is idempotent");
    assert.equal(h.store.get<StoredMessage>("messages", h.message.id)?.delivery, "delivered");
    assert.notEqual(h.app.tasks.get(h.actor, h.task.id).status, "completed");
    assert.equal(h.engine.calls.length, 0);
    assert.equal(h.platform.texts.length, 0);
  } finally {
    await h.web.close();
    await h.close();
  }
});

test("an exhausted Web report notification resumes after rendered ACK and restart without duplicate reports", async () => {
  const h = await harness();
  let restarted: Application | undefined;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const saved = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
      assert.ok(saved);
      saved.notificationNextAttemptAt = undefined;
      h.store.set("task_orchestration_events", h.event.id, saved);
      await h.scheduler.tick();
    }
    const waiting = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.ok(waiting);
    assert.equal(waiting.notificationAttempts, 0, "waiting for rendering consumes no send retries");
    assert.equal(waiting.state, "done");
    assert.equal(h.store.list("workflow_report_deliveries").length, 1);
    // Old releases could exhaust retries before the UI had an acknowledgement endpoint.
    waiting.state = "attention";
    waiting.notificationAttempts = 3;
    waiting.notified = true;
    h.store.set("task_orchestration_events", waiting.id, waiting);
    h.app.tasks.records.save({
      ...h.app.tasks.get(h.actor, h.task.id),
      status: "attention",
      error: waiting.error?.message,
    });
    const exhausted = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.equal(exhausted?.state, "attention");
    assert.equal(exhausted.notificationAttempts, 3);
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "reporting");
    await h.scheduler.tick();
    assert.deepEqual(
      h.store.get("task_orchestration_events", h.event.id),
      exhausted,
      "no ACK keeps the same exhausted receipt",
    );
    assert.equal((await h.post(h.input)).status, 200);
    await h.app.shutdown();
    restarted = new Application({
      config: h.config,
      store: h.store,
      engine: h.engine,
      herdr: h.herdr,
      logger,
    });
    await (restarted as unknown as Internals).taskOrchestrator.tick();
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "awaiting_acceptance");
    const confirmed = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.equal(confirmed?.notificationState, "sent");
    assert.equal(confirmed.notificationAttempts, 3);
    assert.equal(confirmed.error, undefined);
    assert.notEqual(restarted.tasks.get(h.actor, h.task.id).status, "completed");
    await (restarted as unknown as Internals).taskOrchestrator.tick();
    assert.equal(
      h.store
        .list<StoredMessage>("messages")
        .filter((entry) => entry.source === "workflow_report_summary").length,
      1,
    );
    assert.equal(h.engine.calls.length, 0);
    assert.equal(h.platform.texts.length, 0);
  } finally {
    await h.web.close();
    await restarted?.shutdown();
    await h.close();
  }
});

test("Web ACK cannot recover superseded, differently bound or non-delivery failures", async () => {
  const h = await harness();
  try {
    assert.equal((await h.post(h.input)).status, 200);
    const original = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.ok(original);
    assert.ok(original.decision);
    for (const change of [
      { state: "superseded" as const },
      { userRevision: "previous-requirements" },
      { decision: { ...original.decision, action: "deliver" as const, reportId: "other-report" } },
      {
        state: "attention" as const,
        error: {
          code: "workflow_document_scope",
          message: "source changed",
          outcome: "not_executed" as const,
        },
      },
      { notificationCause: "duplicate_identity" },
    ]) {
      const event: OrchestrationEvent = { ...structuredClone(original), ...change };
      h.store.set("task_orchestration_events", event.id, event);
      await h.scheduler.recoverNotification(h.task, event);
      assert.deepEqual(h.store.get("task_orchestration_events", event.id), event);
      assert.equal(event.notificationState, "retryable");
    }
  } finally {
    await h.web.close();
    await h.close();
  }
});

test("a rendered ACK rechecks current source before recovering a prepared report", async () => {
  const h = await harness();
  try {
    await writeFile(
      join(h.task.directories[0] as string, "app.ts"),
      "source changed after report\n",
    );
    assert.equal((await h.post(h.input)).status, 200);
    await h.scheduler.tick();
    const blocked = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.equal(blocked?.state, "attention");
    assert.equal(blocked.error?.code, "workflow_document_scope");
    assert.equal(blocked.notificationState, "retryable");
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "reporting");
    const messages = h.store.list<StoredMessage>("messages");
    await h.scheduler.tick();
    await h.scheduler.tick();
    assert.deepEqual(h.store.list("messages"), messages);
    assert.equal(
      h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id)?.error?.code,
      "workflow_document_scope",
    );
    assert.equal(h.engine.calls.length, 0);
  } finally {
    await h.web.close();
    await h.close();
  }
});

test("legacy Web reports require both bound rendered body and summary messages", async () => {
  const h = await harness(2);
  try {
    const body = h.store
      .list<StoredMessage>("messages")
      .find((entry) => entry.source === "workflow_report");
    assert.ok(body);
    assert.equal((await h.post(h.input)).status, 200);
    await h.scheduler.recoverNotification(
      h.task,
      h.store.get<OrchestrationEvent>(
        "task_orchestration_events",
        h.event.id,
      ) as OrchestrationEvent,
    );
    assert.equal(
      h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id)?.notificationState,
      "retryable",
    );
    assert.equal((await h.post({ ...h.input, messageId: body.id })).status, 200);
    await h.scheduler.tick();
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "awaiting_acceptance");
  } finally {
    await h.web.close();
    await h.close();
  }
});

test("workspace replacement during rendered-report validation cannot confirm the old directory", async () => {
  const h = await harness();
  const verify = h.scheduler.workflow.assertDelivery.bind(h.scheduler.workflow);
  try {
    assert.equal((await h.post(h.input)).status, 200);
    const directory = join(h.directory, "replacement");
    await mkdir(directory);
    h.scheduler.workflow.assertDelivery = async (...args) => {
      await verify(...args);
      h.app.tasks.records.save({
        ...h.app.tasks.get(h.actor, h.task.id),
        directories: [directory],
      });
    };
    const event = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.ok(event);
    event.notificationNextAttemptAt = undefined;
    h.store.set("task_orchestration_events", event.id, event);
    await h.scheduler.tick();
    assert.equal(
      h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id)?.notificationState,
      "retryable",
    );
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.phase, "reporting");
    h.scheduler.workflow.assertDelivery = verify;
    await h.scheduler.tick();
    assert.equal(
      h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id)?.error?.code,
      "workflow_document_scope",
    );
  } finally {
    h.scheduler.workflow.assertDelivery = verify;
    await h.web.close();
    await h.close();
  }
});
