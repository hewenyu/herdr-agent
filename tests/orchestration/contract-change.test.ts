import assert from "node:assert/strict";
import test from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { stableId } from "../../src/core/ids.js";
import type { ActorContext } from "../../src/core/types.js";
import { compileConsensus } from "../../src/orchestration/consensus.js";
import type { ContractChangeDecision } from "../../src/orchestration/contract-change.js";
import { addDocumentDelivery } from "../../src/orchestration/document-delivery.js";
import { choosePlan } from "../../src/orchestration/plan-selection.js";
import type { WorkflowPorts } from "../../src/orchestration/runner.js";
import { workflowState } from "../../src/orchestration/state.js";
import { orchestrationUserMessages } from "../../src/orchestration/user-messages.js";
import { WORKFLOWS } from "../../src/orchestration/workflow.js";
import { associateTaskUserRequest, type TaskUserRevision } from "../../src/tasks/user-request.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function fixture(
  options: {
    consensus?: boolean;
    selection?: "request_pi" | "use_template";
    decision?: "authorized" | "denied" | "unclear" | "low-confidence" | "error";
  } = {},
) {
  const h = setup();
  h.config.ai.enabled = true;
  assert.ok(h.config.jev);
  h.config.jev.apiKey = "fixture-only";
  const original = "把方案保存到 docs/DESIGN.md，双方认可后再交付。";
  const task = await h.service.create(actor, {
    ...discussion,
    orchestration: { mode: "workflow" },
    requirements: original,
  });
  task.userRequest = {
    source: "feishu",
    ownerId: actor.ownerId,
    chatId: actor.chatId,
    sessionId: actor.sessionId,
    messageId: "original",
    eventId: "original",
    text: original,
  };
  h.service.records.save(task);
  const state = workflowState(h.store, task, "original-revision");
  state.plan.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: original };
  addDocumentDelivery(state.plan);
  if (options.consensus !== false) compileConsensus(state.plan, task.participantIds);
  state.plan.version = 2;
  state.planning = "needed";
  h.store.set(WORKFLOWS, task.id, state);
  const previous = structuredClone(state.plan);
  let sequence = 0;
  const input = (text: string, usage: "input" | "read" | "control" = "input") => {
    const messageId = `revision-${++sequence}`;
    const who: ActorContext = { ...actor, source: "feishu", chatType: "private", messageId };
    h.store.set<InboxRecord>("inbox", `message:${messageId}`, {
      id: `message:${messageId}`,
      type: "message",
      actor: who,
      state: "done",
      lane: "owner",
      sequence,
      createdAt: new Date(sequence * 1000).toISOString(),
      payload: {
        source: "feishu",
        chatType: "private",
        eventId: messageId,
        messageId,
        ownerId: who.ownerId,
        chatId: who.chatId,
        text,
        mentionedBot: false,
      },
    });
    associateTaskUserRequest(h.store, who, task, usage);
    const id = stableId(task.id, messageId);
    const revision = h.store.get<TaskUserRevision>("task_user_revisions", id);
    assert.ok(revision);
    h.store.set("task_user_revisions", id, {
      ...revision,
      at: new Date(sequence * 1000).toISOString(),
    });
    return id;
  };
  let args: Record<string, unknown> = {};
  const engine = new Engine();
  engine.handler = async (request) => {
    await request.tools[0]?.execute(
      { template: "discussion", instructions: {}, deliveryRequirements: [], ...args },
      request.actor,
    );
    return { text: "", messages: [] };
  };
  const calls: string[] = [];
  const snapshots: Record<string, unknown>[] = [];
  const ports: WorkflowPorts = {
    store: h.store,
    config: h.config,
    engine,
    tasks: () => h.service,
    tools: () => [],
    logger,
    signal: new AbortController().signal,
    current: () => task,
    foregroundPending: () => false,
    revision: () => "revision",
    baseRevision: () => "revision",
    userMessages: () => orchestrationUserMessages(h.store, task),
    events: () => [],
    outputs: () => [],
    save() {},
    assertCurrent: () => task,
    reconcile() {},
    notify: async () => {},
    attention: async () => {},
    recoverNotification: async () => {},
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const candidates = Object.keys(body.questions.action.criteria);
      snapshots.push(body.state);
      const contract = "requestedChange" in body.state;
      const selected = contract
        ? options.decision === "denied" || options.decision === "unclear"
          ? options.decision
          : "authorized"
        : candidates.includes("authorized")
          ? "authorized"
          : (options.selection ?? "request_pi");
      calls.push(contract ? `contract:${options.decision ?? "authorized"}` : selected);
      if (contract && options.decision === "error")
        return new Response("unavailable", { status: 503 });
      assert.ok(candidates.includes(selected));
      return Response.json({
        model: "jev-fixture",
        answers: {
          action: {
            type: "choice",
            choice: selected,
            confidence: contract && options.decision === "low-confidence" ? 0.5 : 0.99,
            probabilities: Object.fromEntries(
              candidates.map((id) => [id, id === selected ? 1 : 0]),
            ),
          },
        },
        usage: { input_tokens: 10, output_tokens: 1 },
      });
    },
  };
  const event: OrchestrationEvent = {
    id: "plan-event",
    taskId: task.id,
    trigger: "user_revision",
    outputIds: [],
    userRevision: "revision",
    state: "processing",
    attempts: 1,
    dispatches: [],
    createdAt: "2026-09-29T00:00:00Z",
    updatedAt: "2026-09-29T00:00:00Z",
  };
  return {
    ...h,
    task,
    state,
    previous,
    input,
    engine,
    calls,
    snapshots,
    choose(proposed: Record<string, unknown> = {}) {
      args = proposed;
      return choosePlan(ports, task, state, event);
    },
    decisions: () => h.store.list<ContractChangeDecision>("workflow_contract_decisions"),
  };
}

test("latest authenticated input can explicitly withdraw consensus after Jev authorization while preserving documents", async () => {
  const h = await fixture();
  try {
    const sourceMessageId = h.input("取消双方认可门槛，保留独立复核并保存 docs/DESIGN.md 后交付。");
    const plan = await h.choose({
      documentDelivery: { paths: ["docs/DESIGN.md"], sourceMessageId, requireConsensus: false },
    });
    assert.equal(plan.consensus, undefined);
    assert.equal(
      plan.nodes.some((node) => node.consensus),
      false,
    );
    assert.deepEqual(plan.documentDelivery?.paths, ["docs/DESIGN.md"]);
    assert.ok(plan.nodes.some((node) => node.documentPaths?.length));
    assert.equal(plan.contractChange?.removeConsensus, true);
    assert.ok(plan.contractChange?.authorizationId);
    assert.equal(h.decisions()[0]?.decision, "authorized");
    assert.deepEqual(h.calls, ["request_pi", "contract:authorized", "authorized"]);
    assert.deepEqual(h.state.plan, h.previous, "a draft cannot rewrite the accepted previous plan");
  } finally {
    h.close();
  }
});

for (const consensus of [false, true])
  test(`explicit authorized document withdrawal removes write nodes and required files (old consensus=${consensus})`, async () => {
    const h = await fixture({ consensus });
    try {
      const sourceMessageId = h.input("不要再写项目文档，也取消双方认可门槛，只提供只读讨论结果。");
      const plan = await h.choose({
        contractChange: {
          sourceMessageId,
          removeDocumentDelivery: true,
          ...(consensus ? { removeConsensus: true } : {}),
        },
      });
      assert.equal(plan.documentDelivery, undefined);
      assert.equal(plan.consensus, undefined);
      assert.equal(
        plan.nodes.some(
          (node) => node.access === "write" || node.documentPaths?.length || node.consensus,
        ),
        false,
      );
      assert.equal(plan.requiredArtifacts?.includes("docs/DESIGN.md") ?? false, false);
      assert.deepEqual(
        h.calls,
        ["request_pi", "contract:authorized"],
        "revoked writing is not reauthorized or restored",
      );
      assert.equal(h.decisions()[0]?.decision, "authorized");
    } finally {
      h.close();
    }
  });

for (const selection of ["request_pi", "use_template"] as const)
  test(`omitted revocation preserves accepted document and consensus contracts through ${selection}`, async () => {
    const h = await fixture({ selection });
    try {
      h.input("继续细化原来的设计要求。");
      const plan = await h.choose();
      assert.deepEqual(plan.documentDelivery, h.previous.documentDelivery);
      assert.deepEqual(plan.consensus, h.previous.consensus);
      assert.equal(plan.contractChange, undefined);
      assert.equal(plan.nodes.filter((node) => node.consensus).length, 2);
      assert.deepEqual(h.decisions(), []);
      const template = h.snapshots[0]?.template as typeof plan;
      assert.deepEqual(
        template.consensus,
        h.previous.consensus,
        "selection sees obligations that use_template preserves",
      );
      assert.deepEqual(template.documentDelivery, h.previous.documentDelivery);
    } finally {
      h.close();
    }
  });

for (const identity of ["original", "older-input", "read", "control", "forged"])
  test(`contract withdrawal cannot use ${identity} as the latest input authority`, async () => {
    const h = await fixture();
    try {
      const old = h.input("之前考虑取消共同认可。");
      h.input("继续保留双方认可门槛。");
      const passive =
        identity === "read" || identity === "control"
          ? h.input("只查询现有任务，请不要修改。", identity)
          : undefined;
      const sourceMessageId =
        identity === "original"
          ? "original"
          : identity === "older-input"
            ? old
            : (passive ?? "assistant-invented");
      await assert.rejects(
        h.choose({
          documentDelivery: { paths: ["docs/DESIGN.md"], sourceMessageId, requireConsensus: false },
        }),
        {
          code: ["original", "older-input"].includes(identity)
            ? "workflow_contract_authorization"
            : "workflow_scope",
        },
      );
      assert.deepEqual(
        h.calls,
        ["request_pi"],
        "invalid sources never reach authorization or native work",
      );
      assert.deepEqual(h.state.plan, h.previous);
      if (["original", "older-input"].includes(identity)) {
        assert.equal(h.decisions()[0]?.decision, "denied");
        assert.equal(h.decisions()[0]?.reason, "not_latest_task_input");
      }
    } finally {
      h.close();
    }
  });

for (const decision of ["denied", "unclear", "low-confidence", "error"] as const)
  test(`a ${decision} authorization cannot downgrade the contract`, async () => {
    const h = await fixture({ decision });
    try {
      const sourceMessageId = h.input("讨论是否需要取消双方认可门槛，先保持原约定。");
      await assert.rejects(
        h.choose({
          documentDelivery: { paths: ["docs/DESIGN.md"], sourceMessageId, requireConsensus: false },
        }),
        { code: "workflow_contract_authorization" },
      );
      assert.deepEqual(h.state.plan, h.previous);
      assert.equal(h.decisions()[0]?.decision, "denied");
      assert.deepEqual(h.calls, ["request_pi", `contract:${decision}`]);
    } finally {
      h.close();
    }
  });

test("a missing Jev configuration cannot accept a withdrawal even if pi proposes it", async () => {
  const h = await fixture();
  try {
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "";
    const sourceMessageId = h.input("取消双方认可门槛，保存文档后交付。");
    await assert.rejects(
      h.choose({
        documentDelivery: { paths: ["docs/DESIGN.md"], sourceMessageId, requireConsensus: false },
      }),
      { code: "workflow_contract_authorization" },
    );
    assert.equal(h.decisions()[0]?.jev.status, "skipped");
    assert.equal(h.decisions()[0]?.decision, "denied");
    assert.deepEqual(h.state.plan, h.previous);
  } finally {
    h.close();
  }
});

test("runtime contract fields reject string booleans and contradictory document removal", async () => {
  const h = await fixture();
  try {
    const sourceMessageId = h.input("取消所有文档与共同认可要求。");
    for (const proposed of [
      {
        documentDelivery: { paths: ["docs/DESIGN.md"], sourceMessageId, requireConsensus: "false" },
      },
      { contractChange: { sourceMessageId, removeDocumentDelivery: true } },
      {
        contractChange: { sourceMessageId, removeConsensus: true, removeDocumentDelivery: true },
        requiredArtifacts: ["docs/DESIGN.md"],
      },
    ])
      await assert.rejects(h.choose(proposed), { code: "workflow_contract" });
    assert.deepEqual(h.state.plan, h.previous);
  } finally {
    h.close();
  }
});

test("latest revocation authority follows inbox order rather than a timestamp or hash tie-break", async () => {
  const h = await fixture();
  try {
    const older = h.input("先保留共同认可。");
    const latest = h.input("现在取消共同认可，保留 docs/DESIGN.md。");
    const oldRevision = h.store.get<TaskUserRevision>("task_user_revisions", older);
    assert.ok(oldRevision);
    h.store.set("task_user_revisions", older, { ...oldRevision, at: "2099-01-01T00:00:00Z" });
    const plan = await h.choose({
      documentDelivery: {
        paths: ["docs/DESIGN.md"],
        sourceMessageId: latest,
        requireConsensus: false,
      },
    });
    assert.equal(plan.consensus, undefined);
    assert.equal(h.decisions()[0]?.change.sourceMessageId, latest);
  } finally {
    h.close();
  }
});
