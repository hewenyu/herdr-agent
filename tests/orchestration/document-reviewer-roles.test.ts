import assert from "node:assert/strict";
import test from "node:test";
import { workflowCandidates } from "../../src/orchestration/candidates.js";
import { addDocumentDelivery } from "../../src/orchestration/document-delivery.js";
import { planWorkflow } from "../../src/orchestration/planner.js";
import { workflowState } from "../../src/orchestration/state.js";
import { validatePlan, type WorkflowNode } from "../../src/orchestration/workflow.js";
import { Engine } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function fixture(count = 2) {
  const h = setup();
  const task = {
    ...(await h.service.create(actor, {
      ...discussion,
      requirements: "讨论方案并保存 docs/DESIGN.md，保留指定的独立评审者。",
      participants: Array.from({ length: count }, (_, index) => ({
        kind: index % 2 ? ("claude" as const) : ("codex" as const),
      })),
    })),
    promptVersion: 3 as const,
  };
  const state = workflowState(h.store, task, "revision");
  const plan = state.plan;
  plan.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: task.requirements };
  const review = plan.nodes.find((node) => node.role === "reviewer");
  const report = plan.nodes.find((node) => node.role === "reporter");
  assert.ok(review && report);
  review.participantId = task.participantIds[0];
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
  const choices = () => workflowCandidates(task, state, participants, [], false);
  const completeOpenings = () => {
    for (const node of plan.nodes.filter((entry) => entry.id.startsWith("opening-")))
      state.nodes[node.id] = { status: "completed", attempt: 1, participantId: node.participantId };
  };
  return { ...h, task, state, plan, review, report, participants, choices, completeOpenings };
}

test("an automatic document author leaves the fixed first analyst available for independent review", async () => {
  const h = await fixture();
  try {
    const pinned = h.review.participantId;
    addDocumentDelivery(h.plan);
    validatePlan(h.plan, h.task);
    const writer = h.plan.nodes.find((node) => node.id === "document");
    assert.ok(writer);
    assert.equal(writer.participantId, h.task.participantIds[1]);
    assert.equal(h.review.participantId, pinned);
    h.completeOpenings();
    h.state.nodes[writer.id] = { status: "pending", attempt: 0 };
    assert.deepEqual(
      h.choices().flatMap((choice) => choice.assignments ?? []),
      [{ nodeId: writer.id, participantId: h.task.participantIds[1] }],
    );
    h.state.nodes[writer.id] = {
      status: "completed",
      attempt: 1,
      participantId: writer.participantId,
    };
    assert.deepEqual(
      h.choices().flatMap((choice) => choice.assignments ?? []),
      [{ nodeId: h.review.id, participantId: pinned }],
    );
    assert.ok(!h.choices().some((choice) => choice.kind === "add_reviewer"));
  } finally {
    h.close();
  }
});

test("document insertion retains an unbound author when no reviewer is fixed", async () => {
  const h = await fixture();
  try {
    for (const node of h.plan.nodes) node.participantId = undefined;
    addDocumentDelivery(h.plan);
    assert.equal(h.plan.nodes.find((node) => node.id === "document")?.participantId, undefined);
  } finally {
    h.close();
  }
});

for (const count of [2, 8])
  test(`automatic document insertion rejects a roster of ${count} fixed reviewers without changing pins`, async () => {
    const h = await fixture(count);
    try {
      let previous = h.review.id;
      for (const [index, participantId] of h.task.participantIds.slice(1).entries()) {
        const review: WorkflowNode = {
          ...h.review,
          id: `review-${index + 2}`,
          dependsOn: [previous],
          participantId,
        };
        h.plan.nodes.splice(h.plan.nodes.indexOf(h.report), 0, review);
        previous = review.id;
      }
      h.report.dependsOn = [previous];
      const before = structuredClone(h.plan);
      assert.throws(
        () => addDocumentDelivery(h.plan),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, "workflow_plan");
          assert.match((error as Error).message, /固定评审者之外没有/);
          return true;
        },
      );
      assert.deepEqual(h.plan, before);
    } finally {
      h.close();
    }
  });

test("custom unpinned document dispatch, rework and issue resolution all preserve the fixed reviewer", async () => {
  const h = await fixture();
  try {
    addDocumentDelivery(h.plan);
    const writer = h.plan.nodes.find((node) => node.id === "document");
    assert.ok(writer);
    writer.participantId = undefined;
    validatePlan(h.plan, h.task);
    h.completeOpenings();
    h.state.nodes[writer.id] = { status: "pending", attempt: 0 };
    const assigned = () => h.choices().flatMap((choice) => choice.assignments ?? []);
    assert.deepEqual(assigned(), [{ nodeId: writer.id, participantId: h.task.participantIds[1] }]);
    h.state.nodes[writer.id] = { status: "blocked", attempt: 1 };
    h.state.issues.push({
      id: "document-fix",
      description: "补齐文档依据。",
      status: "open",
      blocking: true,
      raisedBy: h.review.participantId as string,
      evidenceRefs: [],
      responses: [],
    });
    const repairs = h.choices().filter((choice) => choice.kind === "rework");
    assert.equal(
      repairs.length,
      2,
      "both blocked-node correction and issue resolution are available",
    );
    assert.ok(
      repairs.every(
        (choice) => choice.assignments?.[0]?.participantId === h.task.participantIds[1],
      ),
    );
    assert.equal(h.review.participantId, h.task.participantIds[0]);
  } finally {
    h.close();
  }
});

test("planner rejects an explicitly conflicting writer until the author is corrected without changing the reviewer", async () => {
  const h = await fixture();
  try {
    addDocumentDelivery(h.plan);
    const writer = h.plan.nodes.find((node) => node.id === "document");
    assert.ok(writer);
    writer.participantId = h.review.participantId;
    assert.throws(() => validatePlan(h.plan, h.task), { code: "workflow_plan" });
    const engine = new Engine();
    engine.handler = async (request) => {
      const tool = request.tools[0];
      assert.ok(tool);
      const args = {
        template: "discussion",
        instructions: {},
        deliveryRequirements: [],
        documentDelivery: h.plan.documentDelivery,
        nodes: structuredClone(h.plan.nodes),
      };
      await assert.rejects(tool.execute(args, request.actor), { code: "workflow_plan" });
      assert.equal(
        args.nodes.find((node) => node.id === h.review.id)?.participantId,
        h.task.participantIds[0],
      );
      const corrected = args.nodes.find((node) => node.id === writer.id);
      assert.ok(corrected);
      corrected.participantId = h.task.participantIds[1];
      await tool.execute(args, request.actor);
      return { text: "", messages: [] };
    };
    const selected = await planWorkflow({
      task: h.task,
      state: h.state,
      engine,
      actor,
      userMessages: [],
      signal: new AbortController().signal,
      assertCurrent() {},
    });
    assert.equal(
      selected.nodes.find((node) => node.id === writer.id)?.participantId,
      h.task.participantIds[1],
    );
    assert.equal(
      selected.nodes.find((node) => node.id === h.review.id)?.participantId,
      h.task.participantIds[0],
    );
    validatePlan(selected, h.task);
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    h.close();
  }
});

for (const count of [2, 8])
  for (const status of ["pending", "blocked"] as const)
    test(`a recovered ${status} fixed author-reviewer conflict does not add unassignable reviewers (${count} participants)`, async () => {
      const h = await fixture(count);
      try {
        addDocumentDelivery(h.plan);
        h.completeOpenings();
        // Simulate the old auto-assignment already dispatched to the fixed reviewer.
        h.state.nodes.document = {
          status: "completed",
          attempt: 1,
          participantId: h.review.participantId,
        };
        h.state.nodes[h.review.id] = { status, attempt: status === "blocked" ? 1 : 0 };
        const before = structuredClone(h.plan);
        for (let poll = 0; poll < 3; poll++) {
          const choices = h.choices();
          assert.ok(choices.some((choice) => choice.id === "replan:roles"));
          assert.ok(choices.some((choice) => choice.id === "user:roles"));
          assert.ok(!choices.some((choice) => choice.kind === "add_reviewer"));
          assert.deepEqual(
            choices.flatMap((choice) => choice.assignments ?? []),
            [],
          );
        }
        assert.deepEqual(h.plan, before, "recovery never silently drops a participant binding");
      } finally {
        h.close();
      }
    });

test("an unbound review may add an independent participant below the cap and exposes a decision at the cap", async () => {
  for (const count of [2, 8]) {
    const h = await fixture(count);
    try {
      h.review.participantId = undefined;
      addDocumentDelivery(h.plan);
      h.completeOpenings();
      h.state.nodes.document = {
        status: "completed",
        attempt: 1,
        participantId: h.task.participantIds[0],
      };
      h.state.implementationParticipants = [...h.task.participantIds];
      const choices = h.choices();
      assert.equal(
        choices.some((choice) => choice.kind === "add_reviewer"),
        count < 8,
      );
      assert.equal(
        choices.some((choice) => choice.id === "user:roles"),
        count === 8,
      );
      assert.equal(
        choices.some((choice) => choice.id === "replan:roles"),
        count === 8,
      );
    } finally {
      h.close();
    }
  }
});

test("a missing fixed document author produces a decision; a busy fixed reviewer waits without adding agents", async () => {
  const h = await fixture();
  try {
    addDocumentDelivery(h.plan);
    h.completeOpenings();
    h.state.nodes.document = { status: "pending", attempt: 0 };
    const author = h.participants[1];
    assert.ok(author);
    const absent = workflowCandidates(h.task, h.state, h.participants.slice(0, 1), [], false);
    assert.ok(absent.some((choice) => choice.id === "user:roles"));
    assert.ok(absent.some((choice) => choice.id === "replan:roles"));
    assert.ok(!absent.some((choice) => choice.kind === "add_reviewer"));
    h.state.nodes.document = { status: "completed", attempt: 1, participantId: author.id };
    const busy = h.participants.map((participant) => ({
      ...participant,
      status: participant.id === h.review.participantId ? ("working" as const) : participant.status,
    }));
    assert.deepEqual(workflowCandidates(h.task, h.state, busy, [], false), []);
    assert.equal(h.review.participantId, h.task.participantIds[0]);
  } finally {
    h.close();
  }
});
