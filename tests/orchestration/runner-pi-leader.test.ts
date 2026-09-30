import assert from "node:assert/strict";
import test from "node:test";
import { TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { workflowCandidates } from "../../src/orchestration/candidates.js";
import type { DecisionLog } from "../../src/orchestration/decision-log.js";
import { currentOpenIssues } from "../../src/orchestration/state.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

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
    assert.deepEqual(
      input.tools.map((tool) => tool.name),
      ["orchestration_choice"],
    );
    const ids: string[] = JSON.parse(input.prompt).candidates.map(
      (candidate: { id: string }) => candidate.id,
    );
    choices.push(ids);
    await input.tools[0]?.execute(
      { candidateId: ids.includes("use_template") ? "use_template" : ids[ids.length - 1] },
      input.actor,
    );
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

test("workflow tick dispatches the restricted pi choice with no Jev configuration", async () => {
  const h = await fixture();
  try {
    await h.worker.tick();
    const state = h.state();
    for (const node of state.plan.nodes.filter((node) => node.id.startsWith("opening-")))
      node.dependsOn = [];
    h.store.set(WORKFLOWS, h.task.id, state);
    await h.worker.tick();
    const offered = h.choices[1];
    assert.equal(offered?.length, 2);
    const decision = h.store.list<DecisionLog>("workflow_decisions")[0];
    assert.equal(decision?.final?.source, "pi");
    assert.equal(decision?.final?.candidateId, offered?.[1]);
    assert.equal(decision?.pi.status, "success");
    assert.equal(decision?.jev.status, "skipped");
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.state().nodes["opening-2"]?.status, "dispatched");
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
