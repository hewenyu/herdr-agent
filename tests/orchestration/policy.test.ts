import assert from "node:assert/strict";
import test from "node:test";
import {
  type DecisionLog,
  linkDecisionDispatches,
  replayDecision,
  saveDecisionLog,
} from "../../src/orchestration/decision-log.js";
import {
  selectWorkflowCandidate,
  type WorkflowSelectionInput,
} from "../../src/orchestration/policy.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type { ConversationEngine } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "../runtime/helpers.js";

const candidates = [
  { id: "review", description: "独立评审" },
  { id: "wait", description: "等待用户裁决" },
] as const;
const unused: ConversationEngine = {
  contextTokens: 1000,
  run: async () => {
    throw new Error("must not invoke pi");
  },
  summarize: async () => "",
};
const input: WorkflowSelectionInput = {
  eventId: "event_1",
  revision: "revision_1",
  planVersion: 1,
  templateVersion: "development-v1",
  snapshot: { stage: "review", issues: ["security"] },
  candidates,
  engine: unused,
  actor: {
    ownerId: "owner",
    chatId: "chat",
    sessionId: "session",
    messageId: "message",
    taskId: "task",
  },
  jev: { apiKey: "fixture-key", confidenceThreshold: 0.8 },
};
function chooser(candidateId = "review", after?: () => void): ConversationEngine {
  return {
    ...unused,
    run: async (request) => {
      await request.tools[0]?.execute({ candidateId }, request.actor);
      after?.();
      return { text: "", messages: [] };
    },
  };
}

test("rule choice skips both models with replayable evidence and no fabricated distribution", async () => {
  let requests = 0;
  const result = await selectWorkflowCandidate({
    ...input,
    rule: { candidateId: "wait", reason: "需要用户批准新目录" },
    fetch: async () => {
      requests++;
      throw new Error("unexpected fetch");
    },
  });
  assert.equal(result.source, "rule");
  assert.equal(result.candidateId, "wait");
  assert.equal(result.log.jev.status, "skipped");
  assert.equal(result.log.jev.probabilities, undefined);
  assert.equal(requests, 0);
  assert.equal(replayDecision(result.log).valid, true);
});

test("sole candidate and no-candidate states do not invoke a selector", async () => {
  const single = await selectWorkflowCandidate({ ...input, candidates: [candidates[0]] });
  assert.equal(single.source, "rule");
  const empty = await selectWorkflowCandidate({ ...input, candidates: [] });
  assert.equal(empty.candidateId, undefined);
  assert.equal(empty.reason, "no_legal_candidates");
  assert.equal(empty.log.jev.status, "skipped");
  assert.equal(empty.log.pi.status, "skipped");
});

test("accepted pi candidate records the same legal set without Jev", async () => {
  const result = await selectWorkflowCandidate({ ...input, engine: chooser() });
  assert.equal(result.source, "pi");
  assert.equal(result.candidateId, "review");
  assert.equal(result.log.pi.status, "success");
  assert.deepEqual(result.log.candidates, candidates);
  assert.equal(replayDecision(result.log).valid, true);
});

test("real PiEngine primary selector exposes only orchestration_choice and chooses the unchanged candidate set", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response("", [
          {
            type: "toolCall",
            id: "decision",
            name: "orchestration_choice",
            arguments: { candidateId: "wait" },
          },
        ]),
        response("已选择等待用户裁决。"),
      ],
      (context) => {
        assert.deepEqual(
          context.tools?.map((tool) => tool.name),
          ["orchestration_choice"],
        );
        const schema = context.tools?.[0]?.parameters as {
          properties: { candidateId: { enum: string[] } };
        };
        assert.deepEqual(schema.properties.candidateId.enum, ["review", "wait"]);
      },
    ),
  });
  const stages: DecisionLog[] = [];
  const result = await selectWorkflowCandidate({
    ...input,
    engine,

    onLog: (log) => {
      stages.push(log);
    },
  });
  assert.equal(result.source, "pi");
  assert.equal(result.candidateId, "wait");
  assert.equal(result.log.jev.status, "skipped");
  assert.equal(result.log.pi.reason, "accepted");
  assert.equal(
    stages.some((log) => log.pi.status === "pending" && !log.final),
    true,
  );
  assert.equal(replayDecision(result.log).valid, true);
});

test("pi cannot select new candidates, pass action payloads or replace a decision", async () => {
  const engine: ConversationEngine = {
    ...unused,
    run: async (request) => {
      assert.equal(request.tools.length, 1);
      const tool = request.tools[0];
      assert.ok(tool);
      await assert.rejects(tool.execute({ candidateId: "delete", reason: "x" }, request.actor), {
        code: "workflow_choice",
      });
      await assert.rejects(
        tool.execute({ candidateId: "wait", reason: "x", command: "rm -rf" }, request.actor),
        { code: "workflow_choice" },
      );
      const accepted = await tool.execute({ candidateId: "wait" }, request.actor);
      assert.deepEqual(accepted, { selected: "wait" });
      await assert.rejects(tool.execute({ candidateId: "review" }, request.actor), {
        code: "workflow_choice",
      });
      return { text: "", messages: [] };
    },
  };
  const result = await selectWorkflowCandidate({ ...input, engine, jev: undefined });
  assert.equal(result.candidateId, undefined);
  assert.equal(result.log.pi.status, "invalid");
  assert.equal(result.deferred, true);
});

test("pi failure or text-only answer never loops or fabricates a selected candidate", async () => {
  for (const throws of [false, true]) {
    let calls = 0;
    const engine: ConversationEngine = {
      ...unused,
      run: async () => {
        calls++;
        if (throws) throw new Error("secret key");
        return { text: '{"candidateId":"review"}', messages: [] };
      },
    };
    const result = await selectWorkflowCandidate({ ...input, engine });
    assert.equal(result.candidateId, undefined);
    assert.equal(result.log.pi.status, throws ? "error" : "invalid");
    assert.equal(result.log.state, "deferred");
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes("secret key"), false);
  }
});

test("cancellation during pi cannot authorize a late choice", async () => {
  const controller = new AbortController();
  await assert.rejects(
    selectWorkflowCandidate({
      ...input,
      signal: controller.signal,
      engine: chooser("wait", () => controller.abort()),
    }),
    { code: "cancelled" },
  );
});

test("revision invalidated during pi cannot commit the returned candidate", async () => {
  let current = true;
  await assert.rejects(
    selectWorkflowCandidate({
      ...input,
      engine: chooser("wait", () => {
        current = false;
      }),
      assertCurrent: () => {
        if (!current) throw new Error("superseded");
      },
    }),
    /superseded/,
  );
});

test("durable log replay validates snapshots and selection while linking existing dispatch receipts", async () => {
  const store = new Store(":memory:");
  try {
    const result = await selectWorkflowCandidate({
      ...input,
      engine: chooser(),
      onLog: (log) => saveDecisionLog(store, log),
    });
    linkDecisionDispatches(store, input.eventId, [
      { operationId: "event_1:dispatch:1", state: "sent", receiptId: "receipt_1" },
    ]);
    const saved = store.get<DecisionLog>("workflow_decisions", input.eventId);
    assert.ok(saved);
    assert.equal(replayDecision(saved).valid, true);
    assert.equal(replayDecision(saved).dispatches[0]?.receiptId, "receipt_1");
    const tampered = structuredClone(saved);
    tampered.snapshot = { stage: "destroy" };
    assert.deepEqual(replayDecision(tampered).errors, ["snapshot_mismatch"]);
    assert.throws(
      () =>
        saveDecisionLog(store, {
          ...saved,
          final: { source: "pi", candidateId: "wait", reason: "changed" },
        }),
      /immutable/,
    );
    assert.equal(result.candidateId, "review");
  } finally {
    store.close();
  }
});
