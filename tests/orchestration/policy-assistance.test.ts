import assert from "node:assert/strict";
import test from "node:test";
import { assessPlanningAssistance } from "../../src/orchestration/assistance.js";
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
const actor = { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "message" };
function pi(choice: string | "error" | "empty", after?: () => void) {
  const requests: Array<{ state: unknown; candidates: typeof candidates }> = [];
  const engine: ConversationEngine = {
    contextTokens: 1000,
    summarize: async () => "",
    run: async (request) => {
      requests.push(JSON.parse(request.prompt));
      assert.deepEqual(
        request.tools.map((tool) => tool.name),
        ["orchestration_choice"],
      );
      assert.equal(request.tools[0]?.readOnly, true);
      if (choice === "error") throw new Error("private provider details");
      if (choice !== "empty")
        await request.tools[0]?.execute({ candidateId: choice }, request.actor);
      after?.();
      return { text: "internal judgment", messages: [] };
    },
  };
  return { engine, requests };
}
const unused = pi("error");
const input: WorkflowSelectionInput = {
  eventId: "natural_selection",
  revision: "revision_1",
  planVersion: 1,
  templateVersion: 3,
  snapshot: { phase: "review", issue: "needs_review" },
  candidates,
  engine: unused.engine,
  actor,
};

test("rules select without invoking pi; otherwise pi directly chooses the legal action", async () => {
  const p = pi("review");
  const rule = await selectWorkflowCandidate({
    ...input,
    engine: p.engine,
    rule: { candidateId: "wait", reason: "user_control" },
  });
  assert.equal(rule.source, "rule");
  assert.equal(p.requests.length, 0);
  assert.equal(replayDecision(rule.log).valid, true);
  const selected = await selectWorkflowCandidate({ ...input, engine: p.engine });
  assert.equal(selected.source, "pi");
  assert.equal(selected.candidateId, "review");
  assert.equal(selected.log.policyVersion, "workflow-selection-v4");
  assert.equal(selected.log.jev.status, "skipped");
  assert.equal(selected.log.pi.status, "success");
  assert.deepEqual(p.requests[0]?.candidates, candidates);
  assert.equal(p.requests.length, 1);
  assert.equal(replayDecision(selected.log).valid, true);
});

test("pi invalid and error outcomes persist deferred evidence without fabricated dispatch", async () => {
  for (const choice of ["unknown", "empty", "error"]) {
    const store = new Store(":memory:");
    try {
      const p = pi(choice);
      const result = await selectWorkflowCandidate({
        ...input,
        engine: p.engine,
        onLog: (log) => saveDecisionLog(store, log),
      });
      assert.equal(result.deferred, true);
      assert.equal(result.candidateId, undefined);
      assert.equal(result.log.state, "deferred");
      assert.equal(result.log.pi.status, choice === "error" ? "error" : "invalid");
      assert.equal(p.requests.length, 1);
      assert.equal(JSON.stringify(result).includes("private provider details"), false);
      const saved = store.get<DecisionLog>("workflow_decisions", input.eventId);
      assert.ok(saved);
      assert.equal(replayDecision(saved).valid, true);
      assert.throws(() => saveDecisionLog(store, { ...saved, state: "pending" }), /immutable/);
    } finally {
      store.close();
    }
  }
});

test("a legal wait remains a pi choice rather than failed-choice deferral", async () => {
  const result = await selectWorkflowCandidate({ ...input, engine: pi("wait").engine });
  assert.equal(result.candidateId, "wait");
  assert.equal(result.deferred, undefined);
  assert.equal(replayDecision(result.log).valid, true);
});

test("cancellation or revision changes cannot authorize a late workflow choice", async () => {
  for (const mode of ["cancel", "revision"]) {
    const controller = new AbortController();
    let fresh = true;
    const p = pi("review", () => {
      if (mode === "cancel") controller.abort();
      else fresh = false;
    });
    const promise = selectWorkflowCandidate({
      ...input,
      engine: p.engine,
      signal: controller.signal,
      assertCurrent: () => {
        if (!fresh) throw new Error("superseded");
      },
    });
    if (mode === "revision") await assert.rejects(promise, /superseded/);
    else await assert.rejects(promise, { code: "cancelled" });
    assert.equal(p.requests.length, 1);
  }
});

test("persisting pending choice evidence does not bypass freshness before pi", async () => {
  let fresh = true;
  const p = pi("review");
  await assert.rejects(
    selectWorkflowCandidate({
      ...input,
      engine: p.engine,
      assertCurrent: () => {
        if (!fresh) throw new Error("superseded");
      },
      onLog: (log) => {
        if (log.pi.status === "pending") fresh = false;
      },
    }),
    /superseded/,
  );
  assert.equal(p.requests.length, 0);
});

test("replay rejects fabricated final actions and invalid pi evidence", async () => {
  const result = await selectWorkflowCandidate({ ...input, engine: pi("review").engine });
  const forged = structuredClone(result.log);
  forged.final = { source: "pi", reason: "fabricated", candidateId: "unknown" };
  assert.ok(replayDecision(forged).errors.includes("invalid_final_candidate"));
  forged.final = result.log.final;
  forged.pi.status = "invalid";
  assert.equal(replayDecision(forged).valid, false);
});

test("planning uses a suitable template or requests internal planning via the same restricted chooser", async () => {
  for (const choice of ["use_template", "request_pi"]) {
    const p = pi(choice);
    const result = await assessPlanningAssistance({
      engine: p.engine,
      actor,
      snapshot: { requirements: "讨论并写入设计文档", template: "discussion-artifact" },
    });
    assert.equal(result.decision, choice);
    assert.equal(result.policyVersion, "workflow-planning-assistance-v3");
    assert.equal(result.jev.status, "skipped");
    assert.equal(result.pi?.status, "success");
    assert.equal(p.requests.length, 1);
  }
});

test("planning invalid and error choices defer rather than starting an unauthorized planner", async () => {
  for (const choice of ["unknown", "empty", "error"]) {
    const p = pi(choice);
    const result = await assessPlanningAssistance({ engine: p.engine, actor, snapshot: {} });
    assert.equal(result.decision, "deferred");
    assert.equal(result.assistance.status, "deferred");
    assert.equal(result.pi?.status, choice === "error" ? "error" : "invalid");
    assert.equal(p.requests.length, 1);
  }
});

test("planning cancellation and revision checks reject late authorization", async () => {
  const controller = new AbortController();
  controller.abort();
  const p = pi("use_template");
  const cancelled = await assessPlanningAssistance({
    engine: p.engine,
    actor,
    snapshot: {},
    signal: controller.signal,
  });
  assert.equal(cancelled.decision, "cancelled");
  assert.equal(p.requests.length, 0);
  let fresh = true;
  const late = pi("use_template", () => {
    fresh = false;
  });
  await assert.rejects(
    assessPlanningAssistance({
      engine: late.engine,
      actor,
      snapshot: {},
      assertCurrent: () => {
        if (!fresh) throw new Error("superseded");
      },
    }),
    /superseded/,
  );
});

test("planning receives requirements and template context before execution, without artifact prerequisites", async () => {
  const p = pi("use_template");
  const snapshot = {
    userRequest: "只讨论两种方案，不修改项目、不运行测试；材料和报告写在任务看板。",
    template: { template: "discussion", nodes: [{ phase: "discussing" }, { phase: "reporting" }] },
    issues: [],
  };
  const result = await assessPlanningAssistance({ engine: p.engine, actor, snapshot });
  assert.equal(result.decision, "use_template");
  assert.deepEqual(p.requests[0]?.state, snapshot);
});
