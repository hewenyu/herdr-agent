import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import type { InboxRecord } from "../../src/app/inbox.js";
import type {
  OrchestrationEvent,
  TaskOrchestratorOptions,
} from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { PlatformPort } from "../../src/core/ports.js";
import type { Task } from "../../src/core/types.js";
import { publishReport } from "../../src/orchestration/report.js";
import type { ReportDeliveries, ReportDelivery } from "../../src/orchestration/report-delivery.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { deferred, logger, message, setup } from "../app/helpers.js";
import { fixture as gitFixture } from "./code-delivery-fixture.js";

interface Internals {
  reportDeliveries: ReportDeliveries;
  taskOrchestrator: {
    options: TaskOrchestratorOptions;
    tick(): Promise<void>;
    revision(task: Task, includeWorkflow?: boolean): string;
  };
}
const events = "task_orchestration_events";
const deliveries = "workflow_report_deliveries";
const internals = (app: Application) => app as unknown as Internals;

async function fixture() {
  const git = await gitFixture();
  await git.initialize();
  await writeFile(join(git.directory, "index.mjs"), "export const answer = 43;\n");
  const h = setup(true, false);
  await h.app.projects.save({ name: "report-gap", directories: [git.directory], agent: "codex" });
  const actor = {
    source: "web" as const,
    ownerId: "owner",
    chatId: "web:owner",
    sessionId: "entry",
    messageId: "report-gap",
  };
  const task = await h.app.tasks.create(actor, {
    kind: "development",
    title: "恢复冻结交付",
    requirements: "实现并独立复核",
    project: "report-gap",
    participants: [{ kind: "codex" }, { kind: "claude" }],
    orchestration: { mode: "workflow" },
    createGroup: false,
    createRemoteTask: false,
  });
  h.app.tasks.records.save({ ...task, promptVersion: 3 });
  await h.app.tasks.reconcile(task.id);
  const scheduler = internals(h.app).taskOrchestrator;
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
    id: "review",
    source: "agent_review",
    result: "passed",
    description: "独立重跑",
    command: "node --check index.mjs",
    artifactRevision: revision,
    participantId: task.participantIds[1],
    outputId: "validate-output",
  });
  await publishReport(
    h.directory,
    { ...task, promptVersion: 3 },
    state,
    {
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
    },
    "report-output",
    revision,
  );
  h.store.set(WORKFLOWS, task.id, state);
  assert.ok(state.report);
  const report = structuredClone(state.report);
  const text = await readFile(report.path, "utf8");
  const event: OrchestrationEvent = {
    id: "report-without-transport-record",
    taskId: task.id,
    trigger: "output",
    outputIds: ["report-output"],
    userRevision: scheduler.revision(task),
    state: "done",
    attempts: 1,
    dispatches: [],
    decision: { action: "deliver", reason: "发送已冻结报告", reportId: report.id },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  h.store.set(events, event.id, event);
  const calls = { uploads: 0, files: 0, cards: 0 };
  const platform = h.platform as typeof h.platform & PlatformPort;
  platform.uploadFile = async (_name, content) => {
    assert.equal(content, text);
    return `file-key-${++calls.uploads}`;
  };
  platform.sendFile = async () => `file-message-${++calls.files}`;
  h.platform.cardHook = async () => {
    calls.cards++;
  };
  h.app.attachPlatform(platform);
  const chatId = await platform.createGroup("交付群", actor.ownerId, "report-gap-group");
  h.app.tasks.records.save({ ...h.app.tasks.get(actor, task.id), chatId, keepGroup: false });
  let app = h.app;
  const complete = async (keep = false) => {
    h.engine.handler = async (turn) => {
      const tool = turn.tools.find((candidate) => candidate.name === "task_action");
      assert.ok(tool);
      await tool.execute({ action: "complete", keepGroup: keep, keepExecution: keep }, turn.actor);
      return { text: "已记录验收。", messages: [], toolCalls: 1, writeCalls: 1 };
    };
    await app.handlers().message({
      ...message("accept-report", "验收通过", chatId),
      chatType: "group",
      mentionedBot: true,
    });
    await app.inbox.drain();
    assert.equal(h.store.get<InboxRecord>("inbox", "message:accept-report")?.state, "done");
  };
  return {
    ...h,
    task,
    actor,
    report,
    text,
    event,
    calls,
    platform,
    chatId,
    complete,
    app: () => app,
    scheduler: () => internals(app).taskOrchestrator,
    record: () => h.store.get<ReportDelivery>(deliveries, event.id),
    async restart(checkpoint: "before_notify" | "sending") {
      let saved = structuredClone(event);
      if (checkpoint === "sending") {
        let captured = false;
        scheduler.options.onReply = async () => {
          const current = h.store.get<OrchestrationEvent>(events, event.id);
          assert.equal(current?.notificationState, "sending");
          assert.equal(h.store.get(deliveries, event.id), undefined);
          assert.ok(current);
          saved = current;
          captured = true;
          throw new OperationError("checkpoint_stop", "模拟回调开始前进程终止");
        };
        await scheduler.tick();
        assert.equal(captured, true, "capture the real durable notify-before-onReply boundary");
      }
      await app.shutdown();
      // Keep the actual durable checkpoint, discarding the synthetic exception's
      // unwind writes: a killed process cannot write those recovery updates.
      h.store.set(events, event.id, saved);
      assert.deepEqual(calls, { uploads: 0, files: 0, cards: 0 });
      app = new Application({
        config: h.config,
        store: h.store,
        engine: h.engine,
        herdr: h.herdr,
        platform,
        logger,
      });
    },
    async close() {
      await app.shutdown();
      await h.close();
      await git.close();
    },
  };
}

for (const checkpoint of ["before_notify", "sending"] as const)
  for (const keep of [false, true])
    test(`completion recovers the original frozen report from ${checkpoint} without a delivery record (keep=${keep})`, async () => {
      const h = await fixture();
      try {
        await h.restart(checkpoint);
        await h.complete(keep);
        await h.app().tasks.reconcile(h.task.id);
        assert.equal(
          h.platform.deletions,
          0,
          "cleanup must wait before notification recovery starts",
        );
        assert.equal(h.record(), undefined);
        await h.scheduler().tick();
        await h.app().tasks.reconcile(h.task.id);
        await h.scheduler().tick();
        assert.deepEqual(h.calls, { uploads: 1, files: 1, cards: 1 });
        assert.equal(h.herdr.sends.length, 0);
        assert.equal(h.platform.deletions, keep ? 0 : 1);
        assert.equal(
          h.app().tasks.get(h.actor, h.task.id).status,
          keep ? "completed" : "destroyed",
        );
        assert.equal(h.record()?.text, h.text);
        assert.equal(h.record()?.reportId, h.report.id);
        assert.equal(h.store.get<OrchestrationEvent>(events, h.event.id)?.notified, true);
        assert.deepEqual(
          h.store.list<OrchestrationEvent>(events).map((entry) => entry.id),
          [h.event.id],
        );
      } finally {
        await h.close();
      }
    });

test("live onReply before receipt creation blocks cleanup until the original notification settles", async () => {
  const h = await fixture();
  const entered = deferred();
  const release = deferred();
  let running: Promise<void> | undefined;
  try {
    const original = h.scheduler().options.onReply;
    assert.ok(original);
    h.scheduler().options.onReply = async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    };
    running = h.scheduler().tick();
    await entered.promise;
    assert.equal(h.record(), undefined);
    await h.complete();
    await h.app().tasks.reconcile(h.task.id);
    assert.equal(h.platform.deletions, 0);
    assert.deepEqual(h.calls, { uploads: 0, files: 0, cards: 0 });
    release.resolve();
    await running;
    await h.app().tasks.reconcile(h.task.id);
    assert.deepEqual(h.calls, { uploads: 1, files: 1, cards: 1 });
    assert.equal(h.platform.deletions, 1);
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    release.resolve();
    await running;
    await h.close();
  }
});

test("a missing receipt cannot bypass a failed frozen-report contract after completion", async () => {
  const h = await fixture();
  try {
    await h.restart("sending");
    await h.complete();
    await writeFile(h.report.path, "报告正文被修改");
    await h.scheduler().tick();
    await h.app().tasks.reconcile(h.task.id);
    assert.equal(h.platform.deletions, 0);
    assert.equal(h.record(), undefined);
    assert.equal(h.store.get<OrchestrationEvent>(events, h.event.id)?.state, "attention");
    assert.equal(
      h.store.get<OrchestrationEvent>(events, h.event.id)?.error?.code,
      "workflow_report",
    );
    await writeFile(h.report.path, h.text);
    await h.scheduler().tick();
    await h.app().tasks.reconcile(h.task.id);
    assert.deepEqual(h.calls, { uploads: 0, files: 0, cards: 0 });
    assert.equal(h.platform.deletions, 0);
  } finally {
    await h.close();
  }
});

test("revoked owner authorization preserves a missing-receipt report without sending or clearing its barrier", async () => {
  const h = await fixture();
  try {
    await h.restart("sending");
    await h.complete();
    h.config.feishu.allowedOpenIds = [];
    await h.scheduler().tick();
    await h.app().tasks.reconcile(h.task.id);
    assert.deepEqual(h.calls, { uploads: 0, files: 0, cards: 0 });
    assert.equal(h.record(), undefined);
    assert.equal(h.platform.deletions, 0);
    h.config.feishu.allowedOpenIds = ["owner"];
    await h.app().tasks.reconcile(h.task.id);
    assert.equal(h.platform.deletions, 0, "restoring authorization cannot skip the unsent report");
  } finally {
    await h.close();
  }
});

for (const stage of ["upload", "file", "card"] as const)
  test(`an unknown ${stage} result during missing-receipt recovery keeps the completed task group`, async () => {
    const h = await fixture();
    try {
      await h.restart("sending");
      await h.complete();
      if (stage === "upload")
        h.platform.uploadFile = async () => {
          h.calls.uploads++;
          throw new OperationError("delivery_uncertain", "上传结果未知", "unknown");
        };
      if (stage === "file")
        h.platform.sendFile = async () => {
          h.calls.files++;
          throw new OperationError("delivery_uncertain", "文件消息结果未知", "unknown");
        };
      if (stage === "card")
        h.platform.cardHook = async () => {
          h.calls.cards++;
          throw new OperationError("delivery_uncertain", "摘要结果未知", "unknown");
        };
      await h.scheduler().tick();
      const calls = { ...h.calls };
      assert.equal(stage === "card" ? h.record()?.cardState : h.record()?.fileState, "uncertain");
      await h.app().tasks.reconcile(h.task.id);
      await h.scheduler().tick();
      await h.app().tasks.reconcile(h.task.id);
      assert.deepEqual(h.calls, calls);
      assert.deepEqual(h.calls, {
        uploads: 1,
        files: stage === "upload" ? 0 : 1,
        cards: stage === "card" ? 1 : 0,
      });
      assert.equal(h.platform.deletions, 0);
      assert.equal(h.herdr.sends.length, 0);
    } finally {
      await h.close();
    }
  });
