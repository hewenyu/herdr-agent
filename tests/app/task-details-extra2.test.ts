import assert from "node:assert/strict";
import test from "node:test";
import { taskDetailPage } from "../../src/app/task-details.js";
import { modelBytes, provisioningFacts, TASK_VIEW_MAX_BYTES } from "../../src/app/task-views.js";
import { applicationTools } from "../../src/app/tools.js";
import { stableId } from "../../src/core/ids.js";
import type { ActorContext, Task } from "../../src/core/types.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { setup } from "./helpers.js";

const actor: ActorContext = {
  ownerId: "owner",
  chatId: "entry",
  sessionId: "entry",
  messageId: "extra2",
};

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
}

async function fixture(requirements = "读取记录。") {
  const h = setup();
  const task = await h.app.tasks.create(actor, {
    kind: "discussion",
    title: "补充边界二",
    requirements,
    participants: [{ kind: "claude" }],
    createGroup: false,
    createRemoteTask: false,
    orchestration: { mode: "manual" },
  });
  const current = h.store.get<Task>("tasks", task.id);
  assert.ok(current);
  const services = { store: h.store, tasks: h.app.tasks };
  return { h, task: current, services };
}

async function readAll(
  services: Parameters<typeof taskDetailPage>[0],
  taskId: string,
  section: string,
  limitBytes = 16_000,
) {
  const chunks: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const result = await taskDetailPage(services, actor, taskId, { section, cursor, limitBytes });
    assert.ok(bytes(result) <= limitBytes, `${section} returned ${bytes(result)} bytes`);
    for (const entry of result.entries)
      chunks.push(`${entry.body ?? ""}${entry.fields ? JSON.stringify(entry.fields) : ""}`);
    if (result.complete) return chunks.join("");
    assert.ok(result.cursor);
    assert.notEqual(result.cursor, cursor);
    cursor = result.cursor;
  }
  assert.fail(`${section} did not terminate`);
}

/** Every record in the store that names this task must be reachable through exactly one section. */
test("frozen plans, staged plans and recovery materials stay readable", async () => {
  const { h, task, services } = await fixture();
  try {
    const planBody = `${"P".repeat(9_000)}FROZEN_PLAN_TAIL`;
    h.store.set("workflow_plans", `${task.id}:1`, {
      taskId: task.id,
      plan: { id: "plan", version: 1, goal: planBody },
      userRevision: "revision",
      reason: "首次计划",
      at: "2026-01-01T00:00:00.000Z",
    });
    h.store.set("workflow_staged_plans", `orchestrate:${stableId(task.id, "e")}:1`, {
      id: "plan",
      version: 1,
      goal: `${"S".repeat(8_000)}STAGED_PLAN_TAIL`,
    });
    h.store.set("task_orchestration_events", `orchestrate:${stableId(task.id, "e")}`, {
      id: `orchestrate:${stableId(task.id, "e")}`,
      taskId: task.id,
      trigger: "ready",
      userRevision: "revision",
      state: "done",
      attempts: 1,
      outputIds: [],
      dispatches: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    h.store.set("workflow_recovery_materials", "material-1", {
      id: "material-1",
      validation: "unverified",
      taskId: task.id,
      nodeId: "node",
      participantId: "participant",
      outputId: "output",
      text: `${"M".repeat(7_000)}RECOVERY_TEXT_TAIL`,
      notes: `${"N".repeat(7_000)}RECOVERY_NOTES_TAIL`,
      notesHash: "notes-hash",
      receiptIdentityMatched: true,
      repair: { code: "workflow_status", recoverable: true, outputId: "output" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const planning = await readAll(services, task.id, "planning");
    assert.ok(planning.includes("FROZEN_PLAN_TAIL"), "frozen plan versions must stay readable");
    assert.ok(planning.includes("STAGED_PLAN_TAIL"), "staged plans must stay readable");
    const notes = await readAll(services, task.id, "evidence_notes");
    assert.ok(notes.includes("RECOVERY_TEXT_TAIL"), "rejected output text must stay readable");
    assert.ok(notes.includes("RECOVERY_NOTES_TAIL"), "captured notes must stay readable");
  } finally {
    await h.close();
  }
});

test("a foreign task's records never appear in a section, even with similar keys", async () => {
  const { h, task, services } = await fixture();
  try {
    const foreign = "task_foreign";
    h.store.set("workflow_decisions", `${foreign}:selection:x`, {
      policyVersion: "v",
      state: "selected",
      revision: "revision",
      snapshot: { secret: "FOREIGN_DECISION_SECRET" },
      candidates: [],
      dispatches: [],
    });
    h.store.set("workflow_conversation_evidence", "foreign-output", {
      taskId: foreign,
      participantId: "p",
      outputId: "foreign-output",
      text: "FOREIGN_NOTE_SECRET",
      notes: "FOREIGN_NOTES_SECRET",
      hash: "h",
    });
    h.store.set("workflow_recovery_materials", "foreign-material", {
      taskId: foreign,
      text: "FOREIGN_RECOVERY_SECRET",
    });
    h.store.set("workflow_plans", `${foreign}:1`, {
      taskId: foreign,
      plan: { goal: "FOREIGN_PLAN_SECRET" },
    });
    h.store.set("workflow_status_blocks", "foreign-block", {
      taskId: foreign,
      block: { summary: "FOREIGN_BLOCK_SECRET", reportSections: { x: "FOREIGN_SECTION_SECRET" } },
    });
    h.store.set("task_orchestration_events", `${foreign}-event`, {
      id: `${foreign}-event`,
      taskId: foreign,
      trigger: "ready",
      userRevision: "revision",
      state: "done",
      attempts: 1,
      outputIds: [],
      dispatches: [],
      error: { code: "x", outcome: "unknown", message: "FOREIGN_EVENT_SECRET" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    for (const section of [
      "status",
      "participants",
      "requirements",
      "orchestration",
      "decisions",
      "planning",
      "nodes",
      "issues",
      "evidence",
      "evidence_notes",
      "status_blocks",
      "outputs",
      "artifacts",
      "delivery",
      "report",
    ]) {
      const text = await readAll(services, task.id, section, 4_000);
      assert.doesNotMatch(text, /FOREIGN_/, `${section} leaked a foreign record`);
    }
  } finally {
    await h.close();
  }
});

test("a template-shaped task with no source metadata still yields every section a usable page", async () => {
  const { h, task, services } = await fixture();
  try {
    for (const section of [
      "status",
      "participants",
      "requirements",
      "orchestration",
      "decisions",
      "planning",
      "nodes",
      "issues",
      "evidence",
      "evidence_notes",
      "status_blocks",
      "outputs",
      "artifacts",
      "delivery",
      "report",
    ]) {
      const page = await taskDetailPage(services, actor, task.id, { section });
      assert.equal(page.section, section);
      assert.equal(page.complete, true, `${section} on an empty task must be complete`);
      assert.equal(page.cursor, undefined);
      assert.ok(Array.isArray(page.entries));
      if (section === "requirements" || section === "participants") {
        assert.ok(page.entries.length > 0, `${section} always has canonical content`);
        assert.equal(page.omittedFields, 0);
      }
      assert.ok(bytes(page) <= 16_000);
    }
  } finally {
    await h.close();
  }
});

test("section frames and bodies never repeat or lose canonical content across a long run", async () => {
  const canonical = `${"F".repeat(30_000)}FRAME_TAIL`;
  const { h, task, services } = await fixture(canonical);
  try {
    const chunks: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (; pages < 400; pages++) {
      const page = await taskDetailPage(services, actor, task.id, {
        section: "requirements",
        cursor,
        limitBytes: 1_000,
      });
      assert.ok(bytes(page) <= 1_000);
      for (const entry of page.entries) if (typeof entry.body === "string") chunks.push(entry.body);
      if (page.complete) break;
      assert.ok(page.cursor);
      assert.notEqual(page.cursor, cursor);
      cursor = page.cursor;
    }
    assert.ok(pages > 5, `30KB needs several 1KB pages, got ${pages}`);
    assert.ok(pages < 400, "canonical text must terminate, not loop forever");
    // The canonical requirements text appears exactly once, in order.
    const joined = chunks.join("");
    assert.equal(joined, canonical, "pages must reproduce the body exactly once");
  } finally {
    await h.close();
  }
});

test("task_get, task_progress and tasks_list keep provisioning evidence intact", async () => {
  const h = setup();
  try {
    const task = await h.app.tasks.create(actor, {
      kind: "discussion",
      title: "供给证据",
      requirements: "记录供给事实。",
      project: "project",
      participants: [{ kind: "codex" }],
      orchestration: { mode: "workflow" },
      createRemoteTask: false,
    });
    await h.app.tasks.reconcile(task.id);
    const current = h.app.tasks.get(actor, task.id);
    const tools = applicationTools(h.app, actor);
    const get = tools.find((entry) => entry.name === "task_get");
    const list = tools.find((entry) => entry.name === "tasks_list");
    assert.ok(get && list);
    const view = (await get.execute({ taskId: current.id }, actor)) as {
      id: string;
      status: string;
      remoteTaskId?: string;
      chatId?: string;
      groupDeleted?: boolean;
      participants: Array<{
        id: string;
        status: string;
        started: boolean;
        initialSent: boolean;
        initialDelivery?: string;
      }>;
    };
    // The fields the runtime claim policy reads must survive the projection.
    assert.equal(view.id, current.id);
    assert.equal(view.status, current.status);
    assert.equal(view.groupDeleted, current.groupDeleted);
    assert.deepEqual(
      view.participants.map((participant) => participant.id),
      current.participantIds,
    );
    const evidence = provisioningFacts({ created: [current.id], tasks: [] });
    assert.deepEqual(evidence.created, [current.id]);
    const listed = (await list.execute({ all: true }, actor)) as Array<Record<string, unknown>>;
    const found = listed.find((entry) => entry.id === current.id);
    assert.ok(found, "tasks_list must still return the real task");
    assert.equal(typeof found.status, "string");
    assert.ok(Array.isArray(found.participants));
    assert.ok(bytes(listed) <= TASK_VIEW_MAX_BYTES);
    assert.ok(modelBytes(view) <= TASK_VIEW_MAX_BYTES);
  } finally {
    await h.close();
  }
});

test("a workflow state with more than the inline array bound still names every node", async () => {
  const { h, task, services } = await fixture();
  try {
    const nodes = Array.from({ length: 120 }, (_, index) => ({
      id: `node-${index}`,
      phase: "discussing",
      role: "analyst",
      purpose: `目的 ${index}`,
      instruction: `${"I".repeat(2_000)}NODE_${index}_TAIL`,
      dependsOn: [],
      access: "read",
    }));
    const state = {
      taskId: task.id,
      plan: {
        id: "plan",
        version: 1,
        templateVersion: 1,
        template: "discussion",
        goal: "多节点",
        nodes,
        deliveryRequirements: ["结论"],
      },
      phase: "discussing",
      userRevision: "revision",
      nodes: Object.fromEntries(nodes.map((node) => [node.id, { status: "pending", attempt: 0 }])),
      issues: [],
      evidence: [],
      artifacts: [],
      consumedOutputs: [],
      batches: [],
      stall: { open: [], unchanged: 0, awaitingUser: false },
    } as unknown as WorkflowState;
    h.store.set(WORKFLOWS, task.id, state);
    const read = await readAll(services, task.id, "nodes", 4_000);
    for (const index of [0, 59, 119])
      assert.ok(read.includes(`NODE_${index}_TAIL`), `node-${index} must stay readable`);
    assert.ok(read.includes("node-119"), "every node id stays named");
  } finally {
    await h.close();
  }
});

test("task_get sheds duplicated task bodies before losing any workflow fact", async () => {
  const h = setup();
  try {
    const filler = "重复正文".repeat(3_000);
    const task = await h.app.tasks.create(actor, {
      kind: "discussion",
      title: "巨型任务体",
      requirements: filler,
      project: "project",
      participants: [{ kind: "codex" }],
      orchestration: { mode: "workflow" },
      createRemoteTask: false,
    });
    await h.app.tasks.reconcile(task.id);
    const current = h.app.tasks.get(actor, task.id);
    const orchestrator = (
      h.app as unknown as {
        taskOrchestrator: { revision(task: Task, workflow?: boolean): string };
      }
    ).taskOrchestrator;
    const state = workflowState(h.store, current, orchestrator.revision(current, false));
    state.plan.goal = filler;
    const firstNode = state.plan.nodes[0];
    assert.ok(firstNode);
    state.plan.nodes[0] = { ...firstNode, purpose: filler, instruction: filler };
    state.issues.push({
      id: "blocking",
      description: "等待用户裁决的阻塞问题。",
      status: "open",
      blocking: true,
      evidenceRefs: [],
      raisedBy: current.participantIds[0] ?? "",
      responses: [],
    });
    state.error = filler;
    h.store.set(WORKFLOWS, current.id, state);
    const stored = h.store.get<Task>("tasks", current.id);
    assert.ok(stored);
    h.store.set<Task>("tasks", current.id, { ...stored, result: filler, error: filler });
    const get = applicationTools(h.app, actor).find((entry) => entry.name === "task_get");
    assert.ok(get);
    const view = (await get.execute({ taskId: current.id }, actor)) as Record<string, unknown>;
    assert.ok(modelBytes(view) <= TASK_VIEW_MAX_BYTES, `task_get returned ${modelBytes(view)}`);
    const workflow = view.workflow as Record<string, unknown>;
    assert.ok(workflow, "a status answer must keep its workflow facts");
    assert.equal(workflow.phase, state.phase);
    assert.equal((workflow.plan as { version?: number } | undefined)?.version ?? 1, 1);
    assert.ok(workflow.counts, "counts survive the projection");
    assert.ok(view.status === current.status);
    // The giant bodies are genuinely available on demand.
    let cursor: string | undefined;
    let text = "";
    for (let page = 0; page < 200; page++) {
      const result = await taskDetailPage(
        { store: h.store, tasks: h.app.tasks },
        actor,
        current.id,
        { section: "requirements", cursor, limitBytes: 4_000 },
      );
      text += result.entries.map((entry) => entry.body ?? "").join("");
      if (result.complete) break;
      cursor = result.cursor;
    }
    assert.ok(text.includes("重复正文".repeat(100)), "the shed body stays readable on demand");
  } finally {
    await h.close();
  }
});
