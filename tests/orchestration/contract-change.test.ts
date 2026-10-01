import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { stableId } from "../../src/core/ids.js";
import type { ActorContext } from "../../src/core/types.js";
import { compileConsensus, consensusDocuments } from "../../src/orchestration/consensus.js";
import {
  authorizeContractChange,
  type ContractChangeDecision,
} from "../../src/orchestration/contract-change.js";
import { addDocumentDelivery } from "../../src/orchestration/document-delivery.js";
import { choosePlan } from "../../src/orchestration/plan-selection.js";
import type { WorkflowPorts } from "../../src/orchestration/runner.js";
import { workflowState } from "../../src/orchestration/state.js";
import { templatePlan } from "../../src/orchestration/templates.js";
import { orchestrationUserMessages } from "../../src/orchestration/user-messages.js";
import { WORKFLOWS } from "../../src/orchestration/workflow.js";
import { associateTaskUserRequest, type TaskUserRevision } from "../../src/tasks/user-request.js";
import { Engine, logger } from "../app/helpers.js";
import { leaderEventPrompt } from "../app/leader-helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function fixture(
  options: {
    consensus?: boolean;
    selection?: "request_pi" | "use_template";
    decision?: "authorized" | "denied" | "unclear" | "invalid" | "error";
    documentDecision?: "authorized" | "forbidden" | "unclear";
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
  let userRevision = "revision";
  const input = (text: string, usage: "input" | "read" | "control" = "input") => {
    const messageId = `revision-${++sequence}`;
    if (usage === "input") userRevision = messageId;
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
  const calls: string[] = [];
  const snapshots: Record<string, unknown>[] = [];
  engine.handler = async (request) => {
    if (request.tools[0]?.name === "orchestration_plan") {
      await request.tools[0].execute(
        { template: "discussion", instructions: {}, deliveryRequirements: [], ...args },
        request.actor,
      );
    } else {
      const body = JSON.parse(leaderEventPrompt(request));
      const snapshot = body.state ?? body;
      const candidates = body.candidates.map((candidate: { id: string }) => candidate.id);
      snapshots.push(snapshot);
      const contract = "requestedChange" in snapshot;
      const selected = contract
        ? options.decision === "denied" || options.decision === "unclear"
          ? options.decision
          : "authorized"
        : candidates.includes("authorized")
          ? (options.documentDecision ?? "authorized")
          : (options.selection ?? "request_pi");
      calls.push(contract ? `contract:${options.decision ?? "authorized"}` : selected);
      if (contract && options.decision === "error") throw new Error("fixture pi failed");
      await request.tools[0]?.execute(
        { candidateId: contract && options.decision === "invalid" ? "illegal" : selected },
        request.actor,
      );
    }
    return { text: "", messages: [] };
  };
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
    revision: () => userRevision,
    baseRevision: () => userRevision,
    userMessages: () => orchestrationUserMessages(h.store, task),
    events: () => [],
    outputs: () => [],
    save() {},
    assertCurrent: () => task,
    reconcile() {},
    notify: async () => {},
    attention: async () => {},
    recoverNotification: async () => {},
    fetch: async () => {
      throw new Error("workflow must not call Jev");
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
      return choosePlan(ports, task, state, {
        ...event,
        // A later authenticated request is a new event/revision, not a replay
        // of the already completed planning inbox for the previous request.
        id: `${event.id}:${userRevision}`,
        userRevision,
      });
    },
    decisions: () => h.store.list<ContractChangeDecision>("workflow_contract_decisions"),
  };
}

test("latest authenticated input can explicitly withdraw consensus after restricted pi authorization while preserving documents", async () => {
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
    const recovered = await h.choose({
      documentDelivery: { paths: ["docs/DESIGN.md"], sourceMessageId, requireConsensus: false },
    });
    assert.deepEqual(
      recovered,
      plan,
      "recovery preserves the independently verified authorization",
    );
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

for (const decision of ["denied", "unclear", "invalid", "error"] as const)
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
      await assert.rejects(
        h.choose({
          documentDelivery: { paths: ["docs/DESIGN.md"], sourceMessageId, requireConsensus: false },
        }),
        { code: "workflow_contract_authorization" },
        "a durable staged draft is not an authorization receipt on recovery",
      );
      assert.deepEqual(h.state.plan, h.previous);
    } finally {
      h.close();
    }
  });

for (const documentDecision of ["forbidden", "unclear"] as const)
  test(`a ${documentDecision} document authorization remains rejected after draft recovery`, async () => {
    const h = await fixture({ documentDecision });
    try {
      h.input("本轮先只读讨论；没有确认允许保存文件。");
      await assert.rejects(h.choose(), { code: "workflow_document_authorization" });
      assert.deepEqual(h.state.plan, h.previous);
      await assert.rejects(
        h.choose(),
        { code: "workflow_document_authorization" },
        "a persisted draft must not bypass independent document authorization",
      );
      assert.deepEqual(h.state.plan, h.previous);
    } finally {
      h.close();
    }
  });

test("a missing Jev configuration still authorizes a withdrawal through restricted pi", async () => {
  const h = await fixture();
  try {
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "";
    const sourceMessageId = h.input("取消双方认可门槛，保存文档后交付。");
    const plan = await h.choose({
      documentDelivery: { paths: ["docs/DESIGN.md"], sourceMessageId, requireConsensus: false },
    });
    assert.equal(plan.consensus, undefined);
    assert.equal(h.decisions()[0]?.pi.status, "success");
    assert.equal(h.decisions()[0]?.decision, "authorized");
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

for (const consensus of [false, true])
  test(`adding another document preserves every existing path, artifact and writer until authorized total withdrawal (consensus=${consensus})`, async () => {
    const h = await fixture({ consensus });
    try {
      const sourceMessageId = h.input("在原有设计文档之外，再增加 docs/B.md 说明部署方案。");
      const plan = await h.choose({ documentDelivery: { paths: ["docs/B.md"], sourceMessageId } });
      const paths = ["docs/DESIGN.md", "docs/B.md"];
      assert.deepEqual(plan.documentDelivery?.paths, paths);
      assert.deepEqual(plan.requiredArtifacts, paths);
      assert.deepEqual(
        plan.nodes.flatMap((node) => node.documentPaths ?? []),
        paths,
      );
      assert.deepEqual(plan.consensus, h.previous.consensus);
      assert.equal(plan.nodes.filter((node) => node.consensus).length, consensus ? 2 : 0);
      const authorization = h.snapshots.find((snapshot) => "proposed" in snapshot);
      assert.deepEqual(
        (authorization?.proposed as { paths: string[] }).paths,
        paths,
        "document authorization checks the entire inherited and added scope",
      );
      assert.deepEqual(h.state.plan, h.previous);
      const directory = h.task.directories[0];
      assert.ok(directory);
      mkdirSync(join(directory, "docs"), { recursive: true });
      for (const path of paths) writeFileSync(join(directory, path), `# ${path}\n`);
      const observed = await consensusDocuments(h.task, { ...h.state, plan });
      assert.deepEqual(
        observed.map((document) => document.path),
        paths,
        "participant confirmations bind both current files after the expansion",
      );
      assert.ok(observed.every((document) => document.hash.length === 64));

      // Exercise a later accepted plan, rather than cancelling only the original one-file contract.
      h.state.plan = plan;
      h.state.plan.version++;
      const cancellationSource = h.input(
        "取消所有项目文档交付和双方认可要求，只保留只读讨论报告。",
      );
      const cancelled = await h.choose({
        contractChange: {
          sourceMessageId: cancellationSource,
          removeDocumentDelivery: true,
          ...(consensus ? { removeConsensus: true } : {}),
        },
      });
      assert.equal(cancelled.documentDelivery, undefined);
      assert.equal(cancelled.consensus, undefined);
      assert.equal(
        cancelled.nodes.some((node) => node.access === "write" || node.documentPaths?.length),
        false,
      );
      assert.equal(
        cancelled.requiredArtifacts?.some((path) => paths.includes(path)) ?? false,
        false,
      );
      assert.equal(h.decisions().at(-1)?.decision, "authorized");
    } finally {
      h.close();
    }
  });

test("custom document nodes must retain responsibility for inherited paths without silently gaining write scope", async () => {
  const h = await fixture();
  try {
    const sourceMessageId = h.input("在现有设计文档之外，再增加 docs/B.md。");
    const custom = templatePlan(h.task);
    custom.documentDelivery = { paths: ["docs/B.md"], userRequest: "新增文档" };
    addDocumentDelivery(custom);
    const writer = custom.nodes.find((node) => node.documentPaths?.length);
    assert.ok(writer);
    const proposal = {
      documentDelivery: { paths: ["docs/B.md"], sourceMessageId },
      nodes: custom.nodes,
    };
    await assert.rejects(h.choose(proposal), { code: "workflow_plan" });
    assert.deepEqual(
      writer.documentPaths,
      ["docs/B.md"],
      "a custom node is not granted the omitted path automatically",
    );
    assert.deepEqual(h.state.plan, h.previous);

    writer.documentPaths = ["docs/DESIGN.md", "docs/B.md"];
    writer.instruction = "维护原有 docs/DESIGN.md，并补充 docs/B.md。";
    const corrected = await h.choose(proposal);
    assert.deepEqual(corrected.documentDelivery?.paths, writer.documentPaths);
    assert.deepEqual(corrected.requiredArtifacts, writer.documentPaths);
    assert.deepEqual(
      corrected.nodes.find((node) => node.id === writer.id)?.documentPaths,
      writer.documentPaths,
    );
    assert.deepEqual(corrected.consensus, h.previous.consensus);
  } finally {
    h.close();
  }
});

test("the centralized acceptance boundary rejects a partial path drop even if contract compilation was bypassed", async () => {
  const h = await fixture();
  try {
    const draft = structuredClone(h.previous);
    assert.ok(draft.documentDelivery);
    draft.documentDelivery.paths = ["docs/B.md"];
    await assert.rejects(
      authorizeContractChange({
        store: h.store,
        id: "bypassed-plan",
        task: h.task,
        previous: h.previous,
        plan: draft,
        userMessages: [],
        engine: h.engine,
        actor,
        assertCurrent() {},
      }),
      { code: "workflow_contract" },
    );
    assert.deepEqual(h.state.plan, h.previous);
  } finally {
    h.close();
  }
});
