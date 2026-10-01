import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { TASK_DETAIL_SECTIONS, taskDetailPage } from "../../src/app/task-details.js";
import { applicationTools } from "../../src/app/tools.js";
import { taskProgress } from "../../src/app/workflow-progress.js";
import { stableId } from "../../src/core/ids.js";
import type { ActorContext, Task } from "../../src/core/types.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { setup } from "./helpers.js";

const actor: ActorContext = {
  ownerId: "owner",
  chatId: "entry",
  sessionId: "entry",
  messageId: "views",
};

export function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
}

const AUDIT_BYTES = 6 * 1_048_576;

/**
 * Write a realistic oracle-scale audit: immutable decision logs (the historical
 * 5.47MB field), orchestration events, settled outputs and a large workflow
 * state, all durable and task-scoped.
 */
export function seedGiantAudit(
  store: ReturnType<typeof setup>["store"],
  task: Task,
  options: { minimumBytes?: number } = {},
): { totalBytes: number; decisions: number } {
  const minimum = options.minimumBytes ?? AUDIT_BYTES;
  const filler = "审计正文CHECK-7f3a。".repeat(4_000);
  const perDecision = JSON.stringify({
    snapshot: filler,
    candidates: [filler],
  }).length;
  // Overshoot the required canonical size with a margin for the event records.
  const decisions = Math.ceil(minimum / perDecision) + 4;
  for (let index = 0; index < decisions; index++) {
    const eventId = `orchestrate:${stableId(task.id, "audit-event", String(index))}`;
    store.set("task_orchestration_events", eventId, {
      id: eventId,
      taskId: task.id,
      trigger: "output",
      outputIds: [`audit-output-${index}`],
      userRevision: `revision-${index}`,
      state: "done",
      attempts: 1,
      dispatches: [],
      selectionLogId: `${eventId}:selection:attempt-${index}`,
      createdAt: new Date(index * 1_000).toISOString(),
      updatedAt: new Date(index * 1_000 + 500).toISOString(),
    });
    store.set("workflow_decisions", `${eventId}:selection:attempt-${index}`, {
      version: 1,
      policyVersion: "workflow-selection-v4",
      eventId: `${eventId}:selection:attempt-${index}`,
      revision: `revision-${index}`,
      planVersion: 1,
      templateVersion: 1,
      snapshotRef: stableId("workflow-snapshot-v1", String(index)),
      snapshot: { goal: filler, audit: filler },
      candidates: [{ id: `dispatch:node-${index}`, description: filler }],
      rule: { status: "not-applicable", reason: filler },
      jev: {
        status: "skipped",
        reason: filler,
        adapterVersion: "jev-v1",
        requestedModel: "m",
        threshold: 0.5,
      },
      pi: { status: "success", reason: filler, candidateId: `dispatch:node-${index}` },
      state: "selected",
      final: { source: "pi", candidateId: `dispatch:node-${index}`, reason: filler },
      dispatches: [],
      createdAt: new Date(index * 1_000).toISOString(),
      updatedAt: new Date(index * 1_000 + 500).toISOString(),
    });
    store.set("task_settled_outputs", stableId(task.id, "output", String(index)), {
      taskId: task.id,
      participantId: task.participantIds[0] ?? "",
      entry: { id: `audit-output-${index}`, role: "assistant", text: filler, final: true },
      observedAt: new Date(index * 1_000).toISOString(),
      sequence: index,
    });
  }
  const state = store.get<WorkflowState>(WORKFLOWS, task.id);
  if (state) {
    for (let index = 0; index < 60; index++)
      state.issues.push({
        id: `audit-issue-${index}`,
        description: filler,
        status: "open",
        blocking: index % 3 === 0,
        evidenceRefs: [],
        raisedBy: task.participantIds[0] ?? "",
        responses: [{ outputId: `audit-output-${index}`, summary: filler }],
      });
    for (let index = 0; index < 60; index++)
      state.evidence.push({
        id: `audit-evidence-${index}`,
        source: "self_report",
        description: filler,
        artifactRevision: "revision",
        outputId: `audit-output-${index}`,
        result: "passed",
      });
    store.set(WORKFLOWS, task.id, state);
  }
  const totalBytes = store
    .entries<unknown>("workflow_decisions")
    .filter(([, record]) => (record as { taskId?: string }).taskId !== "other")
    .reduce((sum, [key, record]) => sum + (key.startsWith("orchestrate:") ? bytes(record) : 0), 0);
  return { totalBytes, decisions };
}

async function fixture() {
  const h = setup();
  const task = await h.app.tasks.create(actor, {
    kind: "discussion",
    title: "审计边界讨论",
    requirements: "讨论两个方案，不修改项目文件。",
    project: "project",
    participants: [{ kind: "codex" }, { kind: "claude" }],
    orchestration: { mode: "workflow" },
    createRemoteTask: false,
  });
  await h.app.tasks.reconcile(task.id);
  const current = h.app.tasks.get(actor, task.id);
  assert.ok(current.chatId);
  const bound: ActorContext = {
    ...actor,
    source: "feishu",
    chatId: current.chatId,
    chatType: "group",
    taskId: current.id,
    messageId: "views-in-group",
  };
  const orchestrator = (
    h.app as unknown as { taskOrchestrator: { revision(task: Task, workflow?: boolean): string } }
  ).taskOrchestrator;
  const revision = orchestrator.revision(current, false);
  // Materialize the same durable workflow state the scheduler uses, so the
  // projection is exercised against a real plan, node map and issue list.
  workflowState(h.store, current, revision);
  for (const participant of h.app.tasks.records.participants(current))
    h.app.tasks.records.saveParticipant({ ...participant, initialSent: true, cursor: "0" });
  const seeded = seedGiantAudit(h.store, h.app.tasks.get(actor, current.id));
  return { ...h, task: h.app.tasks.get(actor, current.id), bound, seeded, revision };
}

test("a >=6MB task audit stays durable while task_get returns a bounded status view", async () => {
  const h = await fixture();
  try {
    const stored = h.store.entries("workflow_decisions");
    const durable = stored.reduce((sum, [, record]) => sum + bytes(record), 0);
    assert.ok(
      durable >= AUDIT_BYTES,
      `the audit fixture must exceed 6MB, got ${durable} bytes in ${stored.length} records`,
    );
    const tool = applicationTools(h.app, h.bound).find((entry) => entry.name === "task_get");
    assert.ok(tool?.readOnly);
    const result = await tool.execute({}, h.bound);
    assert.ok(
      bytes(result) <= 16_384,
      `task_get returned ${bytes(result)} bytes for a ${durable} byte audit`,
    );
    const view = result as Record<string, unknown>;
    assert.equal(view.id, h.task.id);
    assert.equal(view.status, h.task.status);
    assert.deepEqual(
      (view.participants as Array<{ id: string }>).map((entry) => entry.id),
      h.task.participantIds,
      "participant identities and delivery facts must survive projection",
    );
    assert.equal(view.orchestrationHistory, undefined);
    assert.equal(view.workflowDecisions, undefined);
    const workflow = view.workflow as Record<string, unknown>;
    assert.ok(workflow);
    const counts = workflow.counts as Record<string, number>;
    assert.equal(counts.evidence, 60);
    assert.ok((counts.issues ?? 0) >= 60);
    const audit = view.audit as Record<string, unknown>;
    assert.equal(audit.orchestrationEvents, h.seeded.decisions);
    assert.deepEqual(audit.sections, [...TASK_DETAIL_SECTIONS]);
    assert.doesNotMatch(JSON.stringify(view), /CHECK-7f3a/, "no raw audit body may be projected");
    // Durable originals remain untouched.
    assert.equal(h.store.entries("workflow_decisions").length, stored.length);
    assert.equal(
      h.store
        .list<{ taskId: string }>("task_settled_outputs")
        .filter((output) => output.taskId === h.task.id).length,
      h.seeded.decisions,
    );
  } finally {
    await h.close();
  }
});

test("task_progress stays bounded for the same oversized audit and keeps workflow facts", async () => {
  const h = await fixture();
  try {
    const tool = applicationTools(h.app, h.bound).find((entry) => entry.name === "task_progress");
    assert.ok(tool?.readOnly);
    const result = await tool.execute({ taskId: h.task.id }, h.bound);
    assert.ok(bytes(result) <= 16_384, `task_progress returned ${bytes(result)} bytes`);
    const workflow = (result as { workflow?: Record<string, unknown> }).workflow;
    assert.ok(workflow);
    assert.equal((workflow.counts as Record<string, number>).evidence, 60);
    assert.equal((workflow.plan as { version: number }).version, 1);
    assert.equal(typeof workflow.phase, "string");
    assert.equal((workflow.stall as { awaitingUser: boolean }).awaitingUser, false);
    assert.doesNotMatch(JSON.stringify(result), /CHECK-7f3a/);
    const direct = await taskProgress(
      { tasks: h.app.tasks, herdr: h.herdr, store: h.store },
      h.bound,
      h.task.id,
    );
    assert.ok(bytes(direct) <= 16_384);
  } finally {
    await h.close();
  }
});

test("a tasks_list page never returns an unbounded number of audit-sized tasks", async () => {
  const h = await fixture();
  try {
    const template = h.store.get<Task>("tasks", h.task.id);
    assert.ok(template);
    for (let index = 0; index < 40; index++) {
      const id = `task_bulk_${index}`;
      const task: Task = {
        ...template,
        id,
        title: `批量任务 ${index} ${"标题".repeat(400)}`,
        requirements: "需求".repeat(4_000),
        chatId: `group-${index}`,
        participantIds: [],
        createdAt: new Date(index * 1_000).toISOString(),
      };
      h.store.set("tasks", id, task);
    }
    const tool = applicationTools(h.app, actor).find((entry) => entry.name === "tasks_list");
    assert.ok(tool);
    const result = (await tool.execute({ all: true }, actor)) as Array<Record<string, unknown>>;
    assert.ok(bytes(result) <= 16_384, `tasks_list returned ${bytes(result)} bytes`);
    const marker = result.find((entry) => typeof entry.omittedTasks === "number");
    assert.ok(marker, "the page must state how many tasks were left out");
    assert.doesNotMatch(
      JSON.stringify(result),
      /需求{200,}/u,
      "oversized requirement prose must be reduced, not projected verbatim",
    );
    assert.match(JSON.stringify(result), /已截断|omittedTasks/);
  } finally {
    await h.close();
  }
});

test("task_get and task_progress read failures stay explicit instead of becoming empty success", async () => {
  const h = await fixture();
  try {
    const participant = h.app.tasks.records.participants(h.task)[0];
    assert.ok(participant);
    await h.app.tasks.records.saveParticipant({
      ...participant,
      execution: {
        workspaceId: "workspace",
        paneId: "pane",
        kind: participant.kind,
        cwd: h.directory,
      },
    });
    h.herdr.get = async () => {
      throw new Error("native transport down");
    };
    const get = applicationTools(h.app, h.bound).find((entry) => entry.name === "task_get");
    assert.ok(get);
    const result = await get.execute({}, h.bound);
    const projected = (result as { participants: Array<{ readError?: string }> }).participants;
    assert.ok(
      projected.some((entry) => entry.readError),
      "a failed probe must be stated",
    );
    assert.doesNotMatch(JSON.stringify(result), /native transport down/);
    await assert.rejects(
      get.execute({ taskId: "task_other" }, { ...h.bound, taskId: "task_other" }),
      /绑定任务|任务不存在/,
    );
  } finally {
    await h.close();
  }
});

test("the projection module is a pure view helper and never writes to the store", async () => {
  const source = readFileSync(join(process.cwd(), "src", "app", "task-views.ts"), "utf8");
  assert.doesNotMatch(source, /store\.set|store\.delete|store\.transaction/);
  const details = readFileSync(join(process.cwd(), "src", "app", "task-details.ts"), "utf8");
  assert.doesNotMatch(details, /store\.set|store\.delete|store\.transaction/);
  const page = await taskDetailPage(
    { tasks: { get: () => ({ id: "task" }) }, store: {} } as never,
    actor,
    "task",
    { section: "not-a-section" },
  ).catch((error: unknown) => error);
  assert.equal((page as { code?: string }).code, "input");
});
