import assert from "node:assert/strict";
import test from "node:test";
import { TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { workflowCandidates } from "../../src/orchestration/candidates.js";
import type { DecisionLog } from "../../src/orchestration/decision-log.js";
import { currentOpenIssues } from "../../src/orchestration/state.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

const READ_TOOLS = ["workflow_status", "workflow_board", "workflow_detail"];

async function fixture() {
  const h = setup();
  h.config.ai.enabled = true;
  delete h.config.jev;
  const task = await h.service.create(actor, {
    ...discussion,
    orchestration: { mode: "workflow" },
  });
  await h.service.reconcile(task.id);
  const choices: string[][] = [];
  const engine = new Engine();
  engine.handler = async (input) => {
    // Planning mode selection is a Leader activation with the same decision
    // tool; it stays a bounded choice over program-computed candidates.
    const choice = input.tools.find((tool) => tool.name === "orchestration_choice");
    if (choice) {
      await choice.execute({ candidateId: "use_template" }, input.actor);
      return { text: "", messages: [] };
    }
    const plan = input.tools.find((tool) => tool.name === "orchestration_plan");
    if (plan) {
      await plan.execute(
        { template: "discussion", instructions: {}, deliveryRequirements: [] },
        input.actor,
      );
      return { text: "", messages: [] };
    }
    // The durable Leader reads bounded status itself instead of receiving one
    // pre-selected enum choice.
    assert.ok(
      READ_TOOLS.every((name) => input.tools.some((tool) => tool.name === name)),
      `expected the Leader read surface, saw ${input.tools.map((tool) => tool.name).join(",")}`,
    );
    assert.ok(
      !input.tools.some((tool) => tool.name === "orchestration_choice"),
      "the restricted enum chooser is no longer the workflow scheduling interface",
    );
    const status = input.tools.find((tool) => tool.name === "workflow_status");
    assert.ok(status);
    const view = (await status.execute({}, input.actor)) as {
      legalActions: Array<{ id: string; kind: string }>;
    };
    choices.push(view.legalActions.map((candidate) => candidate.id));
    assert.ok(view.legalActions.length > 0);
    const candidate = view.legalActions.at(-1) as { id: string };
    const action = input.tools.find(
      (tool) =>
        tool.readOnly === false &&
        (
          tool.parameters as { properties?: { candidateId?: { enum?: string[] } } }
        ).properties?.candidateId?.enum?.includes(candidate.id),
    );
    assert.ok(action, `no action tool accepts ${candidate.id}`);
    await action.execute({ candidateId: candidate.id, reason: "leader_dispatch" }, input.actor);
    return { text: "", messages: [] };
  };
  const worker = new TaskOrchestrator({
    store: h.store,
    config: h.config,
    projects: h.catalog,
    engine,
    tasks: () => h.service,
    tools: () => [],
    logger,
    signal: new AbortController().signal,
    onReply: async () => {},
    fetch: async () => {
      assert.fail("workflow must not call Jev HTTP");
    },
  });
  const state = () => {
    const value = h.store.get<WorkflowState>(WORKFLOWS, task.id);
    assert.ok(value);
    return value;
  };
  return { ...h, task, worker, state, choices };
}

test("workflow tick lets the durable Leader choose through its own bounded tools", async () => {
  const h = await fixture();
  try {
    await h.worker.tick();
    const state = h.state();
    for (const node of state.plan.nodes.filter((node) => node.id.startsWith("opening-")))
      node.dependsOn = [];
    h.store.set(WORKFLOWS, h.task.id, state);
    const current = h.service.records.get(actor, h.task.id);
    const candidates = workflowCandidates(
      current,
      state,
      h.service.records.participants(current),
      [],
      false,
    );
    assert.equal(candidates.length, 2);
    const chosen = candidates[1];
    assert.ok(chosen);
    await h.worker.tick();
    const offered = h.choices.at(-1);
    assert.deepEqual(
      offered,
      candidates.map((candidate) => candidate.id),
    );
    const decision = h.store
      .list<DecisionLog>("workflow_decisions")
      .find((log) => log.state === "selected");
    assert.ok(decision);
    assert.equal(decision.final?.source, "leader");
    assert.equal(
      decision.final?.candidateId,
      chosen.id,
      "the Leader selected the non-first action",
    );
    assert.equal(decision.jev.status, "skipped");
    assert.equal(decision.rule.status, "not-applicable");
    assert.equal(h.herdr.sends.length, 1);
    const dispatched = Object.entries(h.state().nodes).filter(
      ([, progress]) => progress.status === "dispatched",
    );
    assert.equal(dispatched.length, 1);
    assert.deepEqual(
      dispatched.map(([nodeId, progress]) => ({ nodeId, participantId: progress.participantId })),
      chosen.assignments,
      "native dispatch must execute exactly the Leader's non-first choice",
    );
  } finally {
    h.close();
  }
});

test("user revision preserves old issue history but removes its reporting barrier", async () => {
  const h = await fixture();
  try {
    await h.worker.tick();
    const state = h.state();
    const version = state.plan.version;
    state.issues.push({
      id: "old-blocker",
      description: "旧输入的阻塞",
      status: "open",
      blocking: true,
      evidenceRefs: [],
      raisedBy: "participant",
      responses: [],
    });
    h.store.set(WORKFLOWS, h.task.id, state);
    const current = h.service.records.get(actor, h.task.id);
    h.service.records.save({
      ...current,
      requirements: `${current.requirements}\n用户修订：只报告当前讨论。`,
    });
    await h.worker.tick();
    const revised = h.state();
    assert.equal(revised.plan.version, version + 1);
    assert.equal(revised.issues[0]?.planVersion, version);
    assert.equal(revised.issues[0]?.status, "open");
    assert.equal(revised.issues[0]?.needsRevalidation, true);
    assert.deepEqual(currentOpenIssues(revised), []);
    for (const node of revised.plan.nodes)
      revised.nodes[node.id] = {
        status: node.phase === "reporting" ? "pending" : "completed",
        attempt: 0,
      };
    const candidates = workflowCandidates(
      current,
      revised,
      h.service.records.participants(current),
      [],
      false,
    );
    assert.ok(
      candidates.some((candidate) =>
        candidate.assignments?.some((assignment) => assignment.nodeId === "report"),
      ),
    );
    assert.ok(!candidates.some((candidate) => candidate.id === "user:blocked"));
  } finally {
    h.close();
  }
});
