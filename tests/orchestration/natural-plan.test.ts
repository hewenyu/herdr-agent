import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { workflowCandidates } from "../../src/orchestration/candidates.js";
import { addDocumentDelivery } from "../../src/orchestration/document-delivery.js";
import { choosePlan } from "../../src/orchestration/plan-selection.js";
import type { WorkflowPorts } from "../../src/orchestration/runner.js";
import { workflowState } from "../../src/orchestration/state.js";
import { templatePlan } from "../../src/orchestration/templates.js";
import { validatePlan } from "../../src/orchestration/workflow.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

test("custom independent openings remain separate v3 choices while legacy discussions retain batching", async () => {
  const h = setup();
  try {
    const task = { ...(await h.service.create(actor, discussion)), promptVersion: 3 as const };
    const state = workflowState(h.store, task, "revision");
    for (const node of state.plan.nodes.filter((entry) => entry.id.startsWith("opening-")))
      node.dependsOn = [];
    validatePlan(state.plan, task);
    const participants = h.service.records.participants(task).map((entry, index) => ({
      ...entry,
      status: "idle" as const,
      started: true,
      execution: {
        workspaceId: "workspace",
        paneId: `pane-${index}`,
        kind: entry.kind,
        cwd: h.directory,
      },
    }));
    const choices = workflowCandidates(task, state, participants, [], false);
    assert.equal(choices.length, 2);
    assert.ok(
      choices.every((entry) => entry.kind === "dispatch" && entry.assignments?.length === 1),
    );
    assert.deepEqual(
      new Set(
        choices.flatMap((entry) => entry.assignments?.map((assignment) => assignment.nodeId) ?? []),
      ),
      new Set(["opening-1", "opening-2"]),
    );
    assert.ok(!choices.some((entry) => entry.id === "dispatch:independent-opening"));
    const legacy = workflowCandidates(
      { ...task, promptVersion: 2 },
      state,
      participants,
      [],
      false,
    );
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0]?.id, "dispatch:independent-opening");
    assert.equal(legacy[0]?.assignments?.length, 2);
  } finally {
    h.close();
  }
});

test("both template and pi planning filter removed participants before generating opening nodes", async () => {
  for (const choice of ["use_template", "request_pi"] as const) {
    const h = setup();
    try {
      const task = { ...(await h.service.create(actor, discussion)), promptVersion: 3 as const };
      const roster = h.service.records.participants(task);
      const removed = roster[1];
      const active = roster[0];
      assert.ok(removed && active);
      removed.status = "removed";
      h.service.records.saveParticipant(removed);
      assert.ok(
        task.participantIds.includes(removed.id),
        "persisted roster still preserves removed history",
      );
      const state = workflowState(h.store, task, "revision");
      assert.ok(h.config.jev);
      h.config.jev.apiKey = "fixture-key";
      const engine = new Engine();
      engine.handler = async (request) => {
        assert.equal(choice, "request_pi");
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          ["orchestration_plan"],
        );
        await request.tools[0]?.execute(
          { template: "discussion", instructions: {}, deliveryRequirements: [] },
          request.actor,
        );
        return { text: "", messages: [] };
      };
      const event: OrchestrationEvent = {
        id: `plan-${choice}`,
        taskId: task.id,
        trigger: "ready",
        outputIds: [],
        userRevision: "revision",
        state: "processing",
        attempts: 1,
        dispatches: [],
        createdAt: "2026-09-28T00:00:00Z",
        updatedAt: "2026-09-28T00:00:00Z",
      };
      const ports: WorkflowPorts = {
        store: h.store,
        engine,
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
        save: () => {},
        assertCurrent: () => task,
        reconcile: () => {},
        notify: async () => {},
        attention: async () => {},
        recoverNotification: async () => {},
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          const openings = body.state.template.nodes.filter((node: { id: string }) =>
            node.id.startsWith("opening-"),
          );
          assert.deepEqual(
            openings.map((node: { participantId: string }) => node.participantId),
            [active.id],
          );
          return Response.json({
            model: "jev-1.13.0",
            answers: {
              action: {
                type: "choice",
                choice,
                confidence: 0.95,
                probabilities: {
                  use_template: choice === "use_template" ? 0.95 : 0.05,
                  request_pi: choice === "request_pi" ? 0.95 : 0.05,
                },
              },
            },
            usage: { input_tokens: 20, output_tokens: 5 },
          });
        },
      };
      const plan = await choosePlan(ports, task, state, event);
      const openings = plan.nodes.filter((node) => node.id.startsWith("opening-"));
      assert.deepEqual(
        openings.map((node) => node.participantId),
        [active.id],
      );
      assert.ok(!plan.nodes.some((node) => node.participantId === removed.id));
      validatePlan(plan, { ...task, participantIds: [active.id] });
      assert.equal(engine.calls.length, choice === "request_pi" ? 1 : 0);
      assert.equal(h.herdr.sends.length, 0);
    } finally {
      h.close();
    }
  }
});

test("document insertion preserves serial reviewer dependencies without creating a cycle", async () => {
  const h = setup();
  try {
    const task = {
      ...(await h.service.create(actor, {
        ...discussion,
        requirements: "讨论并保存 docs/DESIGN.md。",
      })),
      promptVersion: 3 as const,
    };
    const plan = templatePlan(task);
    const review = plan.nodes.find((node) => node.id === "cross-review");
    const report = plan.nodes.find((node) => node.id === "report");
    assert.ok(review && report);
    plan.nodes.splice(
      plan.nodes.indexOf(report),
      0,
      { ...review, id: "second-review", dependsOn: [review.id] },
      { ...review, id: "third-review", dependsOn: ["second-review"] },
    );
    report.dependsOn = ["third-review"];
    validatePlan(plan, task);
    plan.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: task.requirements };
    addDocumentDelivery(plan);
    validatePlan(plan, task);
    const document = plan.nodes.find((node) => node.id === "document");
    assert.ok(document);
    assert.deepEqual(new Set(document.dependsOn), new Set(["opening-1", "opening-2"]));
    assert.deepEqual(plan.nodes.find((node) => node.id === "second-review")?.dependsOn, [
      "cross-review",
      "document",
    ]);
    assert.deepEqual(plan.nodes.find((node) => node.id === "third-review")?.dependsOn, [
      "second-review",
      "document",
    ]);
    assert.ok(
      plan.nodes
        .filter((node) => node.role === "reviewer")
        .every((node) => node.dependsOn.includes("document")),
    );
    const before = structuredClone(plan);
    addDocumentDelivery(plan);
    assert.deepEqual(
      plan,
      before,
      "replaying the planner does not duplicate document nodes or edges",
    );
  } finally {
    h.close();
  }
});

test("document insertion follows the pre-review boundary through analyst revision nodes", async () => {
  const h = setup();
  try {
    const task = {
      ...(await h.service.create(actor, {
        ...discussion,
        requirements: "讨论并保存 docs/DESIGN.md。",
      })),
      promptVersion: 3 as const,
    };
    const plan = templatePlan(task);
    const review = plan.nodes.find((node) => node.id === "cross-review");
    const report = plan.nodes.find((node) => node.id === "report");
    assert.ok(review && report);
    plan.nodes.splice(
      plan.nodes.indexOf(report),
      0,
      {
        ...review,
        id: "analyst-revision",
        role: "analyst",
        phase: "discussing",
        dependsOn: [review.id, "opening-2"],
      },
      { ...review, id: "second-review", dependsOn: ["analyst-revision"] },
    );
    report.dependsOn = ["second-review"];
    validatePlan(plan, task);
    plan.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: task.requirements };
    addDocumentDelivery(plan);
    validatePlan(plan, task);
    const document = plan.nodes.find((node) => node.id === "document");
    assert.ok(document);
    assert.deepEqual(new Set(document.dependsOn), new Set(["opening-1", "opening-2"]));
    assert.ok(!document.dependsOn.includes("analyst-revision"));
    assert.deepEqual(plan.nodes.find((node) => node.id === "analyst-revision")?.dependsOn, [
      "cross-review",
      "opening-2",
    ]);
    assert.ok(
      plan.nodes
        .filter((node) => node.role === "reviewer")
        .every((node) => node.dependsOn.includes("document")),
    );
  } finally {
    h.close();
  }
});
