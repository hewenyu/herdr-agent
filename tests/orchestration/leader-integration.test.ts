import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import {
  LEADER_INBOX,
  LEADER_SESSIONS,
  type LeaderInboxRecord,
  type LeaderSessionRecord,
} from "../../src/orchestration/leader-session-types.js";
import {
  createLeaderActionTools,
  createLeaderReadTools,
} from "../../src/orchestration/leader-tools.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import type { EngineInput } from "../../src/runtime/types.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

const READ_TOOLS = ["workflow_status", "workflow_board", "workflow_detail"];
const ACTION_TOOLS = [
  "workflow_dispatch",
  "workflow_verify",
  "workflow_replan",
  "workflow_add_reviewer",
  "workflow_wait",
  "workflow_deliver",
];

function names(input: EngineInput): string[] {
  return input.tools.map((tool) => tool.name);
}

/** Planning mode selection stays a bounded Leader choice over fixed candidates. */
async function chooseTemplate(input: EngineInput) {
  const choice = input.tools.find((tool) => tool.name === "orchestration_choice");
  if (!choice) return false;
  await choice.execute({ candidateId: "use_template" }, input.actor);
  return true;
}

async function completePlanning(input: EngineInput) {
  const plan = input.tools.find((tool) => tool.name === "orchestration_plan");
  if (!plan) return false;
  await plan.execute(
    { template: "discussion", instructions: {}, deliveryRequirements: [] },
    input.actor,
  );
  return true;
}

/** The Leader picks the first candidate through the real action tool surface. */
function pickFirst() {
  return async (input: EngineInput) => {
    const status = input.tools.find((tool) => tool.name === "workflow_status");
    assert.ok(status, `workflow_status missing; saw ${names(input).join(",")}`);
    const view = (await status.execute({}, input.actor)) as {
      legalActions: Array<{ id: string; kind: string }>;
    };
    assert.ok(view.legalActions.length > 0, "fixture must offer at least one legal action");
    const candidate = view.legalActions[0] as { id: string; kind: string };
    const tool = input.tools.find(
      (entry) => entry.readOnly === false && toolAccepts(entry.parameters, candidate.id),
    );
    assert.ok(tool, `no action tool accepts ${candidate.id}: ${names(input).join(",")}`);
    await tool.execute({ candidateId: candidate.id, reason: "leader_pick" }, input.actor);
    return { text: "已提交调度动作。", messages: [] };
  };
}

function toolAccepts(parameters: Record<string, unknown>, candidateId: string): boolean {
  const properties = (parameters as { properties?: Record<string, { enum?: string[] }> })
    .properties;
  return !!properties?.candidateId?.enum?.includes(candidateId);
}

async function fixture(kind: "discussion" | "development" = "discussion") {
  const h = setup();
  h.config.ai.enabled = true;
  delete h.config.jev;
  const repo = join(h.directory, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# leader integration\n");
  await h.catalog.save({ name: "leader", directories: [repo], agent: "codex" });
  const task = await h.service.create(actor, {
    ...discussion,
    ...(kind === "development" ? { kind: "development" as const } : {}),
    project: "leader",
    orchestration: { mode: "workflow" },
  });
  await h.service.reconcile(task.id);
  const engine = new Engine();
  const calls: EngineInput[] = [];
  engine.handler = async (input) => {
    calls.push(input);
    return { text: "", messages: [] };
  };
  const options = {
    store: h.store,
    config: h.config,
    projects: h.catalog,
    engine,
    tasks: () => h.service,
    tools: () => [],
    logger,
    signal: new AbortController().signal,
    retryDelayMs: 0,
    onReply: async () => {},
    fetch: async () => {
      assert.fail("workflow must not call Jev HTTP");
    },
  };
  return {
    ...h,
    task,
    engine,
    calls,
    options,
    worker: () => new TaskOrchestrator(options),
    state: () => {
      const value = h.store.get<WorkflowState>(WORKFLOWS, task.id);
      assert.ok(value);
      return value;
    },
    events: () => h.store.list<OrchestrationEvent>("task_orchestration_events"),
    leaderSession: () =>
      h.store.get<LeaderSessionRecord>(LEADER_SESSIONS, `task-leader:${task.id}`),
  };
}

test("workflow scheduling exposes real Leader tools and persists across activations", async () => {
  const h = await fixture();
  try {
    const engine = h.engine;
    engine.handler = async (input) => {
      if (await chooseTemplate(input)) return { text: "", messages: [] };
      if (await completePlanning(input)) return { text: "", messages: [] };
      assert.ok(
        names(input).includes("workflow_status"),
        `expected the Leader surface, saw ${names(input).join(",")}`,
      );
      for (const name of READ_TOOLS) assert.ok(names(input).includes(name), `missing ${name}`);
      assert.ok(!names(input).includes("orchestration_choice"), "enum chooser must not be offered");
      return await pickFirst()(input);
    };
    await h.worker().tick();
    await h.worker().tick();
    const session = h.leaderSession();
    assert.ok(session, "leader session must be durable");
    assert.equal(session.id, `task-leader:${h.task.id}`);
    assert.equal(session.taskId, h.task.id);
    const first = h.events().find((event) => event.workflow?.candidate);
    assert.ok(first?.workflow, "a committed scheduling action must be persisted on the event");
    assert.equal(first.decision?.source, "leader");
    const activation = h.store
      .list<{ taskId: string; activationId: string }>("leader_activations")
      .filter((entry) => entry.taskId === h.task.id);
    assert.ok(activation.length >= 1, "planning and scheduling run in the Leader session");
    // A second activation reuses the same durable session rather than a new one.
    const before = h.store.list(LEADER_SESSIONS).length;
    await h.worker().tick();
    assert.equal(h.store.list(LEADER_SESSIONS).length, before);
    assert.equal(h.leaderSession()?.id, `task-leader:${h.task.id}`);
  } finally {
    h.close();
  }
});

test("committed Leader action resumes after a restart without a second decision", async () => {
  const h = await fixture();
  try {
    const engine = h.engine;
    engine.handler = async (input) => {
      if (await chooseTemplate(input)) return { text: "", messages: [] };
      if (await completePlanning(input)) return { text: "", messages: [] };
      return await pickFirst()(input);
    };
    await h.worker().tick();
    await h.worker().tick();
    const event = h.events().find((entry) => entry.workflow?.candidate);
    assert.ok(event?.workflow);
    const recorded = event.workflow;
    // A committed but unexecuted action survives; a fresh worker must resume it.
    event.workflow = { ...recorded, applied: false };
    event.state = "pending";
    h.store.set("task_orchestration_events", event.id, event);
    const decisionCalls = () =>
      h.calls.filter((input) => names(input).includes("workflow_dispatch")).length;
    const before = decisionCalls();
    await h.worker().tick();
    assert.equal(
      decisionCalls(),
      before,
      "a recorded action must be resumed, not re-decided by the Leader",
    );
    const receipts = h.store.list<LeaderInboxRecord>(LEADER_INBOX);
    assert.ok(receipts.length >= 1, "Leader keeps a stable per-event inbox receipt");
    assert.ok(receipts.every((receipt) => receipt.taskId === h.task.id));
  } finally {
    h.close();
  }
});

test("read tools page bounded detail and reject foreign identifiers", async () => {
  const h = await fixture();
  try {
    h.engine.handler = async (input) => {
      if (await chooseTemplate(input)) return { text: "", messages: [] };
      if (await completePlanning(input)) return { text: "", messages: [] };
      return { text: "", messages: [] };
    };
    await h.worker().tick();
    const state = h.state();
    const long = "x".repeat(20000);
    const node = state.plan.nodes[0];
    assert.ok(node);
    state.plan.nodes[0] = { ...node, instruction: long };
    h.store.set(WORKFLOWS, h.task.id, state);
    const reads = createLeaderReadTools({
      store: h.store,
      task: h.task,
      state,
      eventId: "event",
      userRevision: "revision",
      artifactRevision: "artifact",
      planVersion: state.plan.version,
      candidates: [],
      participants: h.service.records.participants(h.task),
      commands: [],
      reportMissing: [],
      revision: () => "revision",
      assertCurrent: () => {},
      commit: async () => {},
    });
    const board = reads.find((tool) => tool.name === "workflow_board");
    const detail = reads.find((tool) => tool.name === "workflow_detail");
    assert.ok(board && detail);
    const first = (await board.execute({ section: "plan", limit: 100 }, actor)) as {
      text: string;
      nextOffset?: number;
      truncated: boolean;
    };
    assert.equal(first.text.length, 100);
    assert.equal(first.truncated, true);
    assert.ok((first.nextOffset ?? 0) > 0);
    const second = (await board.execute(
      { section: "plan", offset: first.nextOffset, limit: 100 },
      actor,
    )) as { text: string; offset: number };
    assert.notEqual(second.text, first.text);
    const page = (await detail.execute({ kind: "node", id: node.id, limit: 50 }, actor)) as {
      text: string;
      total: number;
    };
    assert.equal(page.text.length, 50);
    assert.ok(page.total > 50);
    await assert.rejects(detail.execute({ kind: "node", id: "no-such-node" }, actor), /不存在/);
    for (const tool of reads) {
      assert.equal(tool.readOnly, true);
      const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
      assert.ok(Object.keys(properties).length <= 4, `${tool.name} must stay bounded`);
    }
  } finally {
    h.close();
  }
});

test("action tools expose only program-computed candidates and one action per activation", async () => {
  const h = await fixture();
  try {
    h.engine.handler = async (input) => {
      if (await chooseTemplate(input)) return { text: "", messages: [] };
      if (await completePlanning(input)) return { text: "", messages: [] };
      return { text: "", messages: [] };
    };
    await h.worker().tick();
    const state = h.state();
    const participants = h.service.records.participants(h.task);
    let committed = 0;
    const tools = createLeaderActionTools({
      store: h.store,
      task: h.task,
      state,
      eventId: "event",
      userRevision: "revision",
      artifactRevision: "artifact",
      planVersion: state.plan.version,
      candidates: [
        {
          id: "dispatch:opening-1:p1",
          kind: "dispatch",
          description: "fixture",
          assignments: [{ nodeId: "opening-1", participantId: "p1" }],
        },
      ],
      participants,
      commands: [],
      reportMissing: [],
      revision: () => "revision",
      assertCurrent: () => {},
      commit: async () => {
        committed++;
      },
    });
    const dispatch = tools.find((tool) => tool.name === "workflow_dispatch");
    assert.ok(dispatch);
    const enumIds = (dispatch.parameters as { properties: { candidateId: { enum: string[] } } })
      .properties.candidateId.enum;
    assert.deepEqual(enumIds, ["dispatch:opening-1:p1"]);
    for (const name of ["workflow_verify", "workflow_deliver", "workflow_wait"]) {
      assert.ok(!names({ tools } as unknown as EngineInput).includes(name), `${name} unavailable`);
    }
    await assert.rejects(
      dispatch.execute({ candidateId: "dispatch:forged", reason: "x" }, actor),
      /合法骨架/,
    );
    await dispatch.execute({ candidateId: "dispatch:opening-1:p1", reason: "ok" }, actor);
    assert.equal(committed, 1);
    assert.ok(ACTION_TOOLS.length > 0);
  } finally {
    h.close();
  }
});
