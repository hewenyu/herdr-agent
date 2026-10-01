import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import type { Task, UserRequestSource } from "../../src/core/types.js";
import { compileConsensus } from "../../src/orchestration/consensus.js";
import { addDocumentDelivery } from "../../src/orchestration/document-delivery.js";
import { choosePlan } from "../../src/orchestration/plan-selection.js";
import { planWorkflow } from "../../src/orchestration/planner.js";
import type { PlanningAttempt } from "../../src/orchestration/planning-diagnostics.js";
import type { WorkflowPorts } from "../../src/orchestration/runner.js";
import { workflowState } from "../../src/orchestration/state.js";
import { validatePlan } from "../../src/orchestration/workflow.js";
import { Engine, logger } from "../app/helpers.js";
import { leaderEventPrompt } from "../app/leader-helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

const source = (text: string, messageId = "user-original"): UserRequestSource => ({
  source: "web",
  ownerId: actor.ownerId,
  chatId: actor.chatId,
  sessionId: actor.sessionId,
  messageId,
  eventId: messageId,
  text,
});

function portsFor(
  h: ReturnType<typeof setup>,
  task: Task,
  engine: Engine,
  choice: string,
  authorization = "authorized",
) {
  const calls: string[] = [];
  const ports: WorkflowPorts = {
    store: h.store,
    engine: {
      contextTokens: engine.contextTokens,
      summarize: () => engine.summarize(),
      run: async (request) => {
        if (request.tools[0]?.name !== "orchestration_choice") return engine.run(request);
        const body = JSON.parse(leaderEventPrompt(request));
        const candidates = body.candidates.map((candidate: { id: string }) => candidate.id);
        const selected = candidates.includes("authorized") ? authorization : choice;
        calls.push(selected);
        assert.ok(candidates.includes(selected));
        await request.tools[0].execute({ candidateId: selected }, request.actor);
        return { text: "", messages: [] };
      },
    },
    config: h.config,
    tasks: () => h.service,
    tools: () => [],
    signal: new AbortController().signal,
    logger,
    current: () => task,
    foregroundPending: () => false,
    revision: () => "revision",
    baseRevision: () => "revision",
    userMessages: () => [],
    events: () => [],
    outputs: () => [],
    save() {},
    assertCurrent: () => task,
    reconcile() {},
    notify: async () => {},
    attention: async () => {},
    recoverNotification: async () => {},
  };
  return { ports, calls };
}

function eventFor(task: Task): OrchestrationEvent {
  return {
    id: "plan-event",
    taskId: task.id,
    trigger: "ready",
    outputIds: [],
    userRevision: "revision",
    state: "processing",
    attempts: 1,
    dispatches: [],
    createdAt: "2026-09-29T00:00:00Z",
    updatedAt: "2026-09-29T00:00:00Z",
  };
}

test("pi selects the fixed document mode once, then authorization checks the actual original", async () => {
  const h = setup();
  try {
    const original = "请讨论方案并保存设计文档。";
    const task = {
      ...(await h.service.create(actor, discussion)),
      promptVersion: 3 as const,
      userRequest: source(original),
    };
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-key";
    const engine = new Engine();
    engine.handler = async () => {
      throw new Error("fixed mode must not call pi");
    };
    const { ports, calls } = portsFor(h, task, engine, "use_document_template");
    const plan = await choosePlan(
      ports,
      task,
      workflowState(h.store, task, "revision"),
      eventFor(task),
    );
    assert.deepEqual(calls, ["use_document_template", "authorized"]);
    assert.deepEqual(plan.documentDelivery, { paths: ["docs/DESIGN.md"], userRequest: original });
    const writers = plan.nodes.filter((node) => node.access === "write");
    assert.deepEqual(
      writers.map((node) => node.id),
      ["document"],
    );
    assert.equal(writers[0]?.role, "analyst");
    assert.deepEqual(plan.nodes.find((node) => node.id === "cross-review")?.dependsOn.slice(-1), [
      "document",
    ]);
    assert.equal(plan.validation, undefined);
    validatePlan(plan, task);
    assert.equal(engine.calls.length, 0);
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    h.close();
  }
});

test("fixed document mode cannot bypass a forbidden authorization decision", async () => {
  const h = setup();
  try {
    const task = {
      ...(await h.service.create(actor, discussion)),
      promptVersion: 3 as const,
      userRequest: source("只讨论，不写文件。"),
    };
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-key";
    const { ports } = portsFor(h, task, new Engine(), "use_document_template", "forbidden");
    await assert.rejects(
      choosePlan(ports, task, workflowState(h.store, task, "revision"), eventFor(task)),
      { code: "workflow_document_authorization" },
    );
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    h.close();
  }
});

test("an explicit all-participant agreement mode compiles confirmations without a pi graph", async () => {
  const h = setup();
  try {
    const task = {
      ...(await h.service.create(actor, discussion)),
      promptVersion: 3 as const,
      userRequest: source("讨论并保存设计文档，双方都认可最终版本后再交付。"),
    };
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-key";
    const engine = new Engine();
    const { ports } = portsFor(h, task, engine, "use_consensus_document_template");
    const plan = await choosePlan(
      ports,
      task,
      workflowState(h.store, task, "revision"),
      eventFor(task),
    );
    assert.deepEqual(plan.consensus?.participantIds, task.participantIds);
    assert.deepEqual(
      plan.nodes.filter((node) => node.consensus).map((node) => node.participantId),
      task.participantIds,
    );
    assert.equal(plan.nodes.filter((node) => node.documentPaths?.length).length, 1);
    assert.equal(engine.calls.length, 0);
    validatePlan(plan, task);
  } finally {
    h.close();
  }
});

test("ordinary pi customization keeps the graph and expands document before its instruction override", async () => {
  const h = setup();
  try {
    const original = "请把设计保存到 docs/ARCHITECTURE.md。";
    const task = {
      ...(await h.service.create(actor, discussion)),
      promptVersion: 3 as const,
      userRequest: source(original),
    };
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-key";
    const engine = new Engine();
    engine.handler = async (request) => {
      const tool = request.tools[0];
      assert.ok(tool);
      const properties = tool.parameters.properties as Record<string, unknown>;
      assert.equal(properties.nodes, undefined);
      assert.equal(properties.validation, undefined);
      await tool.execute(
        {
          template: "discussion",
          instructions: { document: "保存讨论后的架构与权衡。" },
          deliveryRequirements: ["架构权衡"],
          documentDelivery: { paths: ["docs/ARCHITECTURE.md"], sourceMessageId: "user-original" },
        },
        request.actor,
      );
      return { text: "", messages: [] };
    };
    const { ports } = portsFor(h, task, engine, "request_pi");
    const plan = await choosePlan(
      ports,
      task,
      workflowState(h.store, task, "revision"),
      eventFor(task),
    );
    assert.equal(engine.calls.length, 1);
    assert.equal(plan.nodes.filter((node) => node.documentPaths?.length).length, 1);
    assert.equal(
      plan.nodes.find((node) => node.id === "document")?.instruction,
      "保存讨论后的架构与权衡。",
    );
    const attempts = h.store.list<PlanningAttempt>("workflow_planning_attempts");
    assert.deepEqual(
      attempts.map((entry) => entry.outcome),
      ["accepted"],
    );
  } finally {
    h.close();
  }
});

test("identical failed input stops planning and records useful structure without prose or keys", async () => {
  const h = setup();
  try {
    const task = { ...(await h.service.create(actor, discussion)), promptVersion: 3 as const };
    const engine = new Engine();
    engine.handler = async (request) => {
      const tool = request.tools[0];
      assert.ok(tool);
      const invalid = {
        template: "discussion",
        instructions: { missing_node: "sensitive-user-prose" },
        deliveryRequirements: [],
        apiKey: "sk-private-test-key",
        reasoning: "private-reasoning",
      };
      await assert.rejects(tool.execute(invalid, request.actor), { code: "workflow_plan" });
      await assert.rejects(tool.execute(invalid, request.actor), {
        code: "workflow_plan_no_progress",
      });
      assert.equal(request.signal?.aborted, true);
      return { text: "", messages: [] };
    };
    await assert.rejects(
      planWorkflow({
        task,
        state: workflowState(h.store, task, "revision"),
        engine,
        actor,
        userMessages: [],
        signal: new AbortController().signal,
        simpleDiscussion: true,
        audit: { store: h.store, id: "audit", taskId: task.id, planVersion: 1 },
        assertCurrent() {},
      }),
      { code: "workflow_plan_no_progress" },
    );
    const attempts = h.store.list<PlanningAttempt>("workflow_planning_attempts");
    assert.deepEqual(
      attempts.map((entry) => entry.outcome),
      ["rejected", "no_progress"],
    );
    assert.equal(attempts[1]?.error?.field, "instructions");
    assert.equal(attempts[1]?.error?.nodeId, "missing_node");
    assert.ok(attempts.every((entry) => entry.durationMs >= 0));
    const saved = JSON.stringify(attempts);
    for (const secret of ["sensitive-user-prose", "sk-private-test-key", "private-reasoning"])
      assert.equal(saved.includes(secret), false);
  } finally {
    h.close();
  }
});

test("corrected proposals continue without a retry-count budget and simple graph bypass is rejected", async () => {
  const h = setup();
  try {
    const task = { ...(await h.service.create(actor, discussion)), promptVersion: 3 as const };
    const state = workflowState(h.store, task, "revision");
    const engine = new Engine();
    engine.handler = async (request) => {
      const tool = request.tools[0];
      assert.ok(tool);
      await assert.rejects(
        tool.execute(
          {
            template: "discussion",
            instructions: {},
            deliveryRequirements: [],
            nodes: state.plan.nodes,
          },
          request.actor,
        ),
        /不能替换节点图/,
      );
      for (let index = 0; index < 4; index++)
        await assert.rejects(
          tool.execute(
            {
              template: "discussion",
              instructions: { [`absent-${index}`]: "修正中" },
              deliveryRequirements: [],
            },
            request.actor,
          ),
          { code: "workflow_plan" },
        );
      await tool.execute(
        { template: "discussion", instructions: {}, deliveryRequirements: [] },
        request.actor,
      );
      assert.equal(request.signal?.aborted, false);
      return { text: "", messages: [] };
    };
    const plan = await planWorkflow({
      task,
      state,
      engine,
      actor,
      userMessages: [],
      simpleDiscussion: true,
      signal: new AbortController().signal,
      assertCurrent() {},
    });
    assert.equal(plan.template, "discussion");
  } finally {
    h.close();
  }
});

test("not_run uses the complete real source and rejects derived requirements or reversed excerpts", async () => {
  const h = setup();
  try {
    const original = "只修复这个缺陷。这次不要运行测试，保留独立只读复核。";
    const task = {
      ...(await h.service.create(actor, { ...discussion, kind: "development" })),
      promptVersion: 3 as const,
      userRequest: source(original),
      requirements: "派生概括：禁止运行全部验证。",
    };
    const engine = new Engine();
    engine.handler = async (request) => {
      const tool = request.tools[0];
      assert.ok(tool);
      const base = { template: "development", instructions: {}, deliveryRequirements: [] };
      await assert.rejects(
        tool.execute(
          {
            ...base,
            validation: { mode: "not_run", reason: "概括", userConstraint: "禁止运行全部验证" },
          },
          request.actor,
        ),
        { code: "workflow_scope" },
      );
      await assert.rejects(
        tool.execute(
          { ...base, validation: { mode: "not_run", reason: "摘句", userConstraint: "运行测试" } },
          request.actor,
        ),
        { code: "workflow_scope" },
      );
      await tool.execute(
        {
          ...base,
          validation: {
            mode: "not_run",
            reason: "本次用户明确禁止测试",
            sourceMessageId: "user-original",
          },
        },
        request.actor,
      );
      return { text: "", messages: [] };
    };
    const plan = await planWorkflow({
      task,
      state: workflowState(h.store, task, "revision"),
      engine,
      actor,
      userMessages: [],
      signal: new AbortController().signal,
      assertCurrent() {},
    });
    assert.equal(plan.validation?.userConstraint, original);
    assert.equal(plan.nodes.find((node) => node.id === "validate")?.access, "read");
  } finally {
    h.close();
  }
});

test("explicit request context can supply a document source without copying a source excerpt", async () => {
  const h = setup();
  try {
    const prior = source("请沉淀 docs/DESIGN.md，保留两种方案的取舍。", "earlier-user");
    const task = {
      ...(await h.service.create(actor, discussion)),
      promptVersion: 3 as const,
      userRequest: source("按刚才要求继续。"),
      requestContext: [prior],
    };
    const engine = new Engine();
    engine.handler = async (request) => {
      const tool = request.tools[0];
      assert.ok(tool);
      await tool.execute(
        {
          template: "discussion",
          instructions: {},
          deliveryRequirements: [],
          documentDelivery: { paths: ["docs/DESIGN.md"], sourceMessageId: "earlier-user" },
        },
        request.actor,
      );
      return { text: "", messages: [] };
    };
    const plan = await planWorkflow({
      task,
      state: workflowState(h.store, task, "revision"),
      engine,
      actor,
      userMessages: [],
      simpleDiscussion: true,
      signal: new AbortController().signal,
      assertCurrent() {},
    });
    assert.equal(plan.documentDelivery?.userRequest, prior.text);
    validatePlan(plan, task);
  } finally {
    h.close();
  }
});

test("custom replan diagnostics identify the cycle node and allow a corrected dependency", async () => {
  const h = setup();
  try {
    const task = { ...(await h.service.create(actor, discussion)), promptVersion: 3 as const };
    const state = workflowState(h.store, task, "revision");
    state.plan.version = 2;
    const engine = new Engine();
    engine.handler = async (request) => {
      const tool = request.tools[0];
      assert.ok(tool);
      const nodes = structuredClone(state.plan.nodes);
      const first = nodes[0];
      assert.ok(first);
      first.dependsOn = [first.id];
      const args = { template: "discussion", instructions: {}, deliveryRequirements: [], nodes };
      await assert.rejects(
        tool.execute(args, request.actor),
        /字段：nodes.dependsOn；节点：opening-1/,
      );
      first.dependsOn = [];
      await tool.execute(args, request.actor);
      return { text: "", messages: [] };
    };
    await planWorkflow({
      task,
      state,
      engine,
      actor,
      userMessages: [],
      signal: new AbortController().signal,
      audit: { store: h.store, id: "cycle-audit", taskId: task.id, planVersion: 2 },
      assertCurrent() {},
    });
    const failed = h.store
      .list<PlanningAttempt>("workflow_planning_attempts")
      .find((entry) => entry.outcome === "rejected");
    assert.equal(failed?.error?.nodeId, "opening-1");
    assert.equal(failed?.error?.field, "nodes.dependsOn");
  } finally {
    h.close();
  }
});

test("template and pi replanning preserve document consensus when the proposal omits the flag", async () => {
  const h = setup();
  try {
    const task = {
      ...(await h.service.create(actor, discussion)),
      promptVersion: 3 as const,
      userRequest: source("双方都认可最终 docs/DESIGN.md 后再交付。"),
    };
    const state = workflowState(h.store, task, "revision");
    state.plan.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: task.userRequest.text };
    addDocumentDelivery(state.plan);
    compileConsensus(state.plan, task.participantIds);
    state.plan.version = 2;
    const engine = new Engine();
    engine.handler = async (request) => {
      const tool = request.tools[0];
      assert.ok(tool);
      await tool.execute(
        { template: "discussion", instructions: {}, deliveryRequirements: [] },
        request.actor,
      );
      return { text: "", messages: [] };
    };
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-key";
    for (const choice of ["use_template", "request_pi"]) {
      const { ports } = portsFor(h, task, engine, choice);
      const plan = await choosePlan(ports, task, state, eventFor(task));
      assert.deepEqual(plan.consensus?.participantIds, task.participantIds);
      assert.deepEqual(plan.documentDelivery?.paths, ["docs/DESIGN.md"]);
      assert.equal(plan.nodes.filter((node) => node.consensus).length, task.participantIds.length);
      validatePlan(plan, task);
    }
  } finally {
    h.close();
  }
});
