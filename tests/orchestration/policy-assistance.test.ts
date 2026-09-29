import assert from "node:assert/strict";
import test from "node:test";
import {
  assessPlanningAssistance,
  REQUEST_PI_CANDIDATE,
} from "../../src/orchestration/assistance.js";
import {
  type DecisionLog,
  replayDecision,
  saveDecisionLog,
} from "../../src/orchestration/decision-log.js";
import {
  selectWorkflowCandidate,
  type WorkflowSelectionInput,
} from "../../src/orchestration/policy.js";
import type { ConversationEngine } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

const candidates = [
  { id: "review", description: "继续评审" },
  { id: "wait", description: "等待用户处理" },
];
const unused: ConversationEngine = {
  contextTokens: 1000,
  run: async () => {
    assert.fail("must not invoke pi");
  },
  summarize: async () => "",
};
const input: WorkflowSelectionInput = {
  eventId: "natural_selection",
  revision: "revision_1",
  planVersion: 1,
  templateVersion: 3,
  snapshot: { phase: "review", issue: "needs_review" },
  candidates,
  engine: unused,
  actor: { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "message" },
  jev: { apiKey: "fixture-key", confidenceThreshold: 0.8 },
  assistancePolicy: "jev-requested",
};

function provider(
  ...answers: Array<{ choice: string; confidence?: number; probability?: number } | "error">
) {
  const requests: Array<{ state: unknown; ids: string[] }> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const ids = Object.keys(body.questions.action.criteria);
    requests.push({ state: body.state, ids });
    const answer = answers[requests.length - 1];
    assert.ok(answer, "unexpected additional Jev request");
    if (answer === "error") throw new Error("private provider details");
    assert.ok(ids.includes(answer.choice));
    const confidence = answer.confidence ?? 0.95;
    const probability = answer.probability ?? confidence;
    return Response.json({
      model: "jev-1.13.0",
      answers: {
        action: {
          type: "choice",
          choice: answer.choice,
          confidence,
          probabilities: Object.fromEntries(
            ids.map((id) => [
              id,
              id === answer.choice ? probability : (1 - probability) / (ids.length - 1),
            ]),
          ),
        },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  };
  return { fetch: fetchImpl, requests };
}

function pi() {
  let calls = 0;
  const engine: ConversationEngine = {
    ...unused,
    run: async (request) => {
      calls++;
      assert.deepEqual(
        request.tools.map((tool) => tool.name),
        ["orchestration_decide"],
      );
      assert.deepEqual(JSON.parse(request.prompt).candidates, candidates);
      const tool = request.tools[0];
      assert.ok(tool);
      await assert.rejects(
        tool.execute(
          { candidateId: REQUEST_PI_CANDIDATE.id, reason: "cannot dispatch control" },
          request.actor,
        ),
        { code: "workflow_choice" },
      );
      await tool.execute({ candidateId: "review", reason: "已有产物需要独立评审" }, request.actor);
      return { text: "internal judgment", messages: [] };
    },
  };
  return { engine, calls: () => calls };
}

test("natural rules and high-confidence business choices need no assistance or pi", async () => {
  const p = provider({ choice: "review", confidence: 0.91 });
  const rule = await selectWorkflowCandidate({
    ...input,
    rule: { candidateId: "wait", reason: "user_control" },
    fetch: p.fetch,
  });
  assert.equal(rule.source, "rule");
  assert.equal(p.requests.length, 0);
  assert.equal(replayDecision(rule.log).valid, true);
  const selected = await selectWorkflowCandidate({ ...input, fetch: p.fetch });
  assert.equal(selected.source, "jev");
  assert.equal(selected.candidateId, "review");
  assert.equal(selected.log.assistance?.status, "skipped");
  assert.equal(selected.log.jev.confidence, 0.91);
  assert.deepEqual(p.requests[0]?.ids, ["review", "wait", REQUEST_PI_CANDIDATE.id]);
  assert.deepEqual(selected.log.candidates, candidates);
  assert.equal(replayDecision(selected.log).valid, true);
});

test("Jev may request one internal pi selection without adding its control to business candidates", async () => {
  const p = provider({ choice: REQUEST_PI_CANDIDATE.id });
  const internal = pi();
  const result = await selectWorkflowCandidate({
    ...input,
    fetch: p.fetch,
    engine: internal.engine,
  });
  assert.equal(result.source, "pi");
  assert.equal(result.candidateId, "review");
  assert.equal(result.log.assistance?.requestedBy, "jev-control");
  assert.equal(result.log.pi.reason, "jev_requested_pi");
  assert.equal(internal.calls(), 1);
  assert.equal(p.requests.length, 1);
  assert.equal(replayDecision(result.log).valid, true);
});

test("a low-confidence action requires Jev assistance consent before invoking pi", async () => {
  const p = provider({ choice: "review", confidence: 0.6 }, { choice: "request_pi" });
  const internal = pi();
  const result = await selectWorkflowCandidate({
    ...input,
    fetch: p.fetch,
    engine: internal.engine,
  });
  assert.equal(result.source, "pi");
  assert.equal(result.log.jev.status, "low-confidence");
  assert.equal(result.log.assistance?.requestedBy, "jev-assistance");
  assert.equal(result.log.assistance?.jev?.probabilities?.request_pi, 0.95);
  assert.equal(internal.calls(), 1);
  assert.deepEqual(p.requests[1]?.ids, ["request_pi", "wait_for_evidence"]);
  assert.equal(replayDecision(result.log).valid, true);
});

test("a confident external evidence wait persists without accepting an action", async () => {
  for (const answer of [{ choice: "wait_for_evidence", confidence: 0.95 }]) {
    const store = new Store(":memory:");
    try {
      const p = provider({ choice: "review", confidence: 0.6 }, answer);
      const result = await selectWorkflowCandidate({
        ...input,
        fetch: p.fetch,
        onLog: (log) => saveDecisionLog(store, log),
      });
      assert.equal(result.deferred, true);
      assert.equal(result.candidateId, undefined);
      assert.equal(result.log.state, "deferred");
      assert.equal(result.log.pi.status, "skipped");
      assert.equal(p.requests.length, 2);
      const saved = store.get<DecisionLog>("workflow_decisions", input.eventId);
      assert.ok(saved);
      assert.equal(replayDecision(saved).valid, true);
      assert.throws(() => saveDecisionLog(store, { ...saved, state: "pending" }), /immutable/);
    } finally {
      store.close();
    }
  }
});

test("uncertain assistance recovers through one restricted pi selection, never a user evidence wait", async () => {
  for (const choice of ["wait_for_evidence", "request_pi"]) {
    const p = provider(
      { choice: "review", confidence: 0.65 },
      { choice, confidence: 0.45, probability: 0.73 },
    );
    const internal = pi();
    const result = await selectWorkflowCandidate({
      ...input,
      engine: internal.engine,
      fetch: p.fetch,
    });
    assert.equal(result.source, "pi");
    assert.equal(result.deferred, undefined);
    assert.equal(result.log.assistance?.reason, "jev_assistance_uncertain_recovery");
    assert.equal(result.log.assistance?.requestedBy, "recovery");
    assert.equal(result.log.policyVersion, "workflow-selection-v3");
    assert.equal(internal.calls(), 1);
    assert.equal(p.requests.length, 2);
    assert.equal(replayDecision(result.log).valid, true);
    const forgedLegacy = { ...result.log, policyVersion: "workflow-selection-v2" as const };
    assert.ok(replayDecision(forgedLegacy).errors.includes("invalid_assistance_request"));
  }
});

test("failed uncertainty recovery never fabricates a selected action or retries the model in one step", async () => {
  const p = provider(
    { choice: "review", confidence: 0.65 },
    { choice: "wait_for_evidence", confidence: 0.45, probability: 0.73 },
  );
  let calls = 0;
  const result = await selectWorkflowCandidate({
    ...input,
    fetch: p.fetch,
    engine: {
      ...unused,
      run: async () => {
        calls++;
        throw new Error("offline");
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.log.state, "failed");
  assert.equal(result.deferred, undefined);
  assert.equal(result.candidateId, undefined);
  assert.equal(replayDecision(result.log).valid, true);
});

test("provider failures have explicit recovery evidence and invoke pi only once", async () => {
  for (const answers of [
    ["error"] as const,
    [{ choice: "review", confidence: 0.6 }, "error"] as const,
  ]) {
    const p = provider(...answers);
    const internal = pi();
    const result = await selectWorkflowCandidate({
      ...input,
      fetch: p.fetch,
      engine: internal.engine,
    });
    assert.equal(result.source, "pi");
    assert.equal(result.log.assistance?.requestedBy, "recovery");
    assert.equal(internal.calls(), 1);
    assert.equal(JSON.stringify(result).includes("private provider details"), false);
    assert.equal(replayDecision(result.log).valid, true);
  }
});

test("assistance cancellation or a changed revision never starts pi", async () => {
  for (const invalidation of ["cancel", "revision"] as const) {
    const p = provider({ choice: "review", confidence: 0.6 }, { choice: "request_pi" });
    const controller = new AbortController();
    let fresh = true;
    const promise = selectWorkflowCandidate({
      ...input,
      signal: controller.signal,
      assertCurrent: () => {
        if (!fresh) throw new Error("superseded");
      },
      fetch: async (...args) => {
        const result = await p.fetch(...args);
        if (p.requests.length === 2) {
          if (invalidation === "cancel") controller.abort();
          else fresh = false;
        }
        return result;
      },
    });
    if (invalidation === "revision") await assert.rejects(promise, /superseded/);
    else {
      const result = await promise;
      assert.equal(result.log.state, "cancelled");
      assert.equal(result.log.pi.status, "skipped");
      assert.equal(result.candidateId, undefined);
      assert.equal(replayDecision(result.log).valid, true);
    }
  }
});

test("request persistence does not bypass the pre-pi freshness check", async () => {
  const p = provider({ choice: REQUEST_PI_CANDIDATE.id });
  let fresh = true;
  await assert.rejects(
    selectWorkflowCandidate({
      ...input,
      fetch: p.fetch,
      assertCurrent: () => {
        if (!fresh) throw new Error("superseded");
      },
      onLog: (log) => {
        if (log.pi.status === "pending") fresh = false;
      },
    }),
    /superseded/,
  );
});

test("replay rejects a fabricated assistance request and selector controls as final actions", async () => {
  const p = provider({ choice: "review" });
  const result = await selectWorkflowCandidate({ ...input, fetch: p.fetch });
  const forged = structuredClone(result.log);
  forged.assistance = { status: "requested", requestedBy: "jev-control", reason: "fabricated" };
  forged.pi = { status: "success", reason: "fabricated", candidateId: "review" };
  forged.final = { source: "pi", reason: "fabricated", candidateId: "review" };
  assert.ok(replayDecision(forged).errors.includes("invalid_assistance_request"));
  forged.final = { source: "jev", reason: "control", candidateId: REQUEST_PI_CANDIDATE.id };
  assert.ok(replayDecision(forged).errors.includes("invalid_final_candidate"));
  await assert.rejects(
    selectWorkflowCandidate({ ...input, candidates: [REQUEST_PI_CANDIDATE, ...candidates] }),
    { code: "workflow_candidates" },
  );
});

test("planning assistance uses a suitable template without an unconditional pi planner", async () => {
  const p = provider({ choice: "use_template" });
  const result = await assessPlanningAssistance({
    jev: input.jev,
    snapshot: { requirements: "讨论并写入设计文档", template: "discussion-artifact" },
    fetch: p.fetch,
  });
  assert.equal(result.decision, "use_template");
  assert.equal(result.assistance.status, "skipped");
  assert.equal(p.requests.length, 1);
});

test("planning records explicit requests, confident waits, and uncertainty or provider recovery", async () => {
  const cases = [
    { answers: [{ choice: "request_pi" }], decision: "request_pi", requestedBy: "jev-control" },
    {
      answers: [{ choice: "use_template", confidence: 0.6 }, { choice: "wait_for_evidence" }],
      decision: "deferred",
      requestedBy: "jev-assistance",
    },
    { answers: ["error" as const], decision: "request_pi", requestedBy: "recovery" },
    {
      answers: [
        { choice: "use_template", confidence: 0.6 },
        { choice: "wait_for_evidence", confidence: 0.45, probability: 0.73 },
      ],
      decision: "request_pi",
      requestedBy: "recovery",
    },
  ];
  for (const scenario of cases) {
    const p = provider(...scenario.answers);
    const result = await assessPlanningAssistance({ jev: input.jev, snapshot: {}, fetch: p.fetch });
    assert.equal(result.decision, scenario.decision);
    assert.equal(result.assistance.requestedBy, scenario.requestedBy);
  }
});

test("planning cancellation and revision changes cannot authorize a late plan", async () => {
  const controller = new AbortController();
  const p = provider({ choice: "use_template" });
  const result = await assessPlanningAssistance({
    jev: input.jev,
    snapshot: {},
    signal: controller.signal,
    fetch: async (...args) => {
      controller.abort();
      return p.fetch(...args);
    },
  });
  assert.equal(result.decision, "cancelled");
  let fresh = true;
  const late = provider({ choice: "request_pi" });
  await assert.rejects(
    assessPlanningAssistance({
      jev: input.jev,
      snapshot: {},
      fetch: late.fetch,
      assertCurrent: () => {
        if (!fresh) throw new Error("superseded");
      },
      onLog: (log) => {
        if (log.assistance.status === "requested") fresh = false;
      },
    }),
    /superseded/,
  );
});

test("uncertain planning uses planning context instead of requiring artifacts before execution", async () => {
  const p = provider({ choice: "use_template", confidence: 0.6 }, { choice: "request_pi" });
  const snapshots: Array<Record<string, unknown>> = [];
  const result = await assessPlanningAssistance({
    jev: input.jev,
    snapshot: {
      userRequest: "只讨论两种方案，不修改项目、不运行测试；材料和报告写在任务看板。",
      template: {
        template: "discussion",
        nodes: [{ phase: "discussing" }, { phase: "reporting" }],
      },
      issues: [],
    },
    fetch: async (...args) => {
      const body = JSON.parse(String(args[1]?.body));
      snapshots.push(body.state);
      return p.fetch(...args);
    },
  });
  assert.equal(result.decision, "request_pi");
  assert.equal(result.jev.status, "low-confidence");
  assert.equal(result.assistance.requestedBy, "jev-assistance");
  assert.equal(snapshots[1]?.decisionContext, "before_execution_planning");
  assert.equal(p.requests.length, 2, "one assistance question, with no automatic retry");
  assert.equal(result.jev.threshold, 0.8);
  assert.equal(result.assistance.jev?.threshold, 0.8);
  const selection = provider(
    { choice: "review", confidence: 0.6 },
    { choice: "wait_for_evidence" },
  );
  const deferred = await selectWorkflowCandidate({ ...input, fetch: selection.fetch });
  assert.equal(deferred.deferred, true);
  assert.equal(
    (selection.requests[1]?.state as { decisionContext: string }).decisionContext,
    "workflow_action_selection",
  );
});
