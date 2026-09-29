import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { roleConflictQuestions } from "../../src/orchestration/role-conflicts.js";
import { currentUserDecision, ensureUserDecision } from "../../src/orchestration/user-decision.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function fixture(count = 2) {
  const h = setup();
  h.config.ai.enabled = true;
  assert.ok(h.config.jev);
  h.config.jev.apiKey = "fixture-only";
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# Role decisions\n");
  await h.catalog.save({ name: "roles", directories: [repo], agent: "codex" });
  const task = await h.service.create(actor, {
    ...discussion,
    project: "roles",
    orchestration: { mode: "workflow" },
    participants: Array.from({ length: count }, (_, index) => ({
      kind: index % 2 ? ("claude" as const) : ("codex" as const),
      name: index === 0 ? "Codex" : index === 1 ? "Claude" : `reviewer-${index}`,
    })),
  });
  await h.service.reconcile(task.id);
  const engine = new Engine();
  engine.handler = async () => {
    assert.fail("observed runtime constraints need no invented model explanation");
  };
  const replies: string[] = [];
  const options = {
    config: h.config,
    projects: h.catalog,
    store: h.store,
    engine,
    tasks: () => h.service,
    tools: () => [],
    logger,
    signal: new AbortController().signal,
    retryDelayMs: 0,
    fetch: (async (_url, init) => {
      const ids = Object.keys(JSON.parse(String(init?.body)).questions.action.criteria);
      const choice = ids.includes("use_template") ? "use_template" : "user:roles";
      assert.ok(ids.includes(choice), JSON.stringify(ids));
      return new Response(
        JSON.stringify({
          model: "jev-fixture",
          answers: {
            action: {
              type: "choice",
              choice,
              confidence: 0.99,
              probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
            },
          },
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      );
    }) as typeof fetch,
    onReply: async (_task: unknown, text: string) => {
      replies.push(text);
    },
  };
  const worker = new TaskOrchestrator(options);
  await worker.tick();
  const state = h.store.get<WorkflowState>(WORKFLOWS, task.id);
  assert.ok(state);
  for (const node of state.plan.nodes.filter((node) => node.id.startsWith("opening-")))
    state.nodes[node.id] = { status: "completed", attempt: 1, participantId: node.participantId };
  const review = state.plan.nodes.find((node) => node.role === "reviewer");
  assert.ok(review);
  review.participantId = task.participantIds[0];
  state.nodes[review.id] = { status: "pending", attempt: 0 };
  state.implementationParticipants = [task.participantIds[0] ?? ""];
  state.phase = review.phase;
  h.store.set(WORKFLOWS, task.id, state);
  const participants = h.service.records.participants(task);
  const questionInput = () => ({
    task,
    state,
    engine,
    actor,
    eventId: "role-question",
    revision: "current",
    programQuestions: roleConflictQuestions(task, state, participants),
    assertCurrent() {},
    persist(decision: NonNullable<WorkflowState["userDecision"]>) {
      state.userDecision = decision;
      h.store.set(WORKFLOWS, task.id, state);
    },
  });
  return {
    ...h,
    task,
    state,
    review,
    participants,
    worker,
    options,
    engine,
    replies,
    questionInput,
  };
}

test("a real user:roles wait presents the fixed author conflict and concrete independent alternatives", async () => {
  const h = await fixture();
  try {
    const binding = h.review.participantId;
    await h.worker.tick();
    const event = h.store
      .list<OrchestrationEvent>("task_orchestration_events")
      .find((entry) => entry.decision?.candidateId === "user:roles");
    assert.ok(event?.notified);
    assert.equal(event.decision?.action, "wait");
    assert.equal(h.replies.length, 1);
    for (const text of [
      h.review.id,
      "固定为 Codex",
      "参与本任务实现",
      "Claude",
      "申请",
      "影响范围",
      "回复示例",
      "独立评审",
    ])
      assert.ok(h.replies[0]?.includes(text), text);
    assert.doesNotMatch(h.replies[0] ?? "", /当前没有已确认|已经改由|已新增/);
    const latest = h.store.get<WorkflowState>(WORKFLOWS, h.task.id);
    assert.equal(latest?.userDecision?.status, "ready");
    const source = latest?.userDecision?.sources.find((source) => source.kind === "role_conflict");
    assert.ok(source?.runtimeFacts);
    assert.equal(
      latest?.plan.nodes.find((node) => node.id === h.review.id)?.participantId,
      binding,
    );
    assert.equal(h.herdr.sends.length, 0, "presenting options does not change or execute the plan");
    assert.equal(h.engine.calls.length, 0);
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.replies.length, 1);
  } finally {
    h.close();
  }
});

test("a reviewer binding change invalidates the saved role question without silently adopting it", async () => {
  const h = await fixture();
  try {
    const question = await ensureUserDecision(h.questionInput());
    assert.equal(question.status, "ready");
    assert.ok(currentUserDecision(h.state));
    h.review.participantId = h.task.participantIds[1];
    assert.equal(currentUserDecision(h.state), undefined);
    assert.deepEqual(roleConflictQuestions(h.task, h.state, h.participants), []);
    const updated = await ensureUserDecision(h.questionInput());
    assert.equal(updated.status, "system");
    assert.deepEqual(updated.questions, []);
    assert.equal(h.engine.calls.length, 0);
  } finally {
    h.close();
  }
});

test("busy compatible participants and a generic selector reason do not invent role decisions", async () => {
  const h = await fixture();
  try {
    h.state.implementationParticipants = [];
    const busy = h.participants.map((participant) => ({
      ...participant,
      status: "working" as const,
    }));
    assert.deepEqual(roleConflictQuestions(h.task, h.state, busy), []);
    const decision = await ensureUserDecision({
      ...h.questionInput(),
      diagnostics: ["请选择需要用户裁决的固定角色冲突。"],
    });
    assert.equal(decision.status, "system");
    assert.deepEqual(decision.questions, []);
    assert.equal(h.engine.calls.length, 0);
  } finally {
    h.close();
  }
});

test("a full roster of authors requests a concrete replacement name without promising an impossible ninth agent", async () => {
  const h = await fixture(8);
  try {
    h.review.participantId = undefined;
    h.state.implementationParticipants = [...h.task.participantIds];
    const decision = await ensureUserDecision(h.questionInput());
    assert.equal(decision.status, "ready");
    assert.equal(decision.questions[0]?.kind, "input");
    assert.match(decision.questions[0]?.missingInput ?? "", /8\/8.*参与者姓名/);
    assert.match(decision.questions[0]?.example ?? "", /现有参与者姓名.*替换/);
    assert.equal(decision.questions[0]?.options, undefined);
    assert.equal(h.engine.calls.length, 0);
    assert.equal(h.service.records.participants(h.task).length, 8);
  } finally {
    h.close();
  }
});
