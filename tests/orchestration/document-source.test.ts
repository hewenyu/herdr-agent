import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { stableId } from "../../src/core/ids.js";
import type { ActorContext } from "../../src/core/types.js";
import { compileConsensus } from "../../src/orchestration/consensus.js";
import type { ContractChangeDecision } from "../../src/orchestration/contract-change.js";
import { addDocumentDelivery } from "../../src/orchestration/document-delivery.js";
import {
  assertDocumentSource,
  prepareDocumentSource,
} from "../../src/orchestration/document-source.js";
import { skippedJev } from "../../src/orchestration/jev.js";
import { WorkflowOrchestrator, type WorkflowPorts } from "../../src/orchestration/runner.js";
import { workflowState } from "../../src/orchestration/state.js";
import { templatePlan } from "../../src/orchestration/templates.js";
import { orchestrationUserMessages } from "../../src/orchestration/user-messages.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { associateTaskUserRequest } from "../../src/tasks/user-request.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function harness() {
  const h = setup();
  h.config.ai.enabled = true;
  const root = join(h.directory, "repo");
  mkdirSync(root);
  writeFileSync(join(root, "app.ts"), "original source\n");
  await h.catalog.save({ name: "document-source", directories: [root], agent: "codex" });
  const task = await h.service.create(actor, {
    ...discussion,
    project: "document-source",
    orchestration: { mode: "workflow" },
  });
  const state = workflowState(h.store, task, "user-revision");
  state.plan.documentDelivery = { paths: ["A.md", "B.md"], userRequest: task.requirements };
  const prepare = async () => {
    state.documentSource = await prepareDocumentSource(h.store, task, state);
    h.store.set(WORKFLOWS, state.taskId, state);
  };
  const check = () => assertDocumentSource(h.store, task, state);
  return { ...h, task, state, root, prepare, check };
}

function authorizedDraft(h: Awaited<ReturnType<typeof harness>>) {
  const draft = structuredClone(h.state);
  draft.plan = templatePlan(h.task);
  draft.plan.version = h.state.plan.version;
  draft.plan.contractChange = {
    sourceMessageId: "withdrawal-input",
    removeDocumentDelivery: true,
    authorizationId: "withdrawal-authorization",
  };
  const decision: ContractChangeDecision = {
    taskId: h.task.id,
    planVersion: draft.plan.version,
    change: { sourceMessageId: "withdrawal-input", removeDocumentDelivery: true },
    decision: "authorized",
    reason: "authorized",
    jev: { ...skippedJev(undefined, "authorized"), status: "success", candidateId: "authorized" },
  };
  h.store.set("workflow_contract_decisions", "withdrawal-authorization", decision);
  return { draft, decision };
}

test("document source baseline permits all authorized documents but rejects source changes across plans", async () => {
  const h = await harness();
  try {
    await h.prepare();
    const original = structuredClone(h.state.documentSource);
    assert.ok(original);
    writeFileSync(join(h.root, "A.md"), "first writer\n");
    writeFileSync(join(h.root, "B.md"), "second writer\n");
    await h.check();
    h.state.plan.version++;
    h.state.nodes = {};
    writeFileSync(join(h.root, "app.ts"), "unauthorized source\n");
    await assert.rejects(h.prepare(), { code: "workflow_document_scope" });
    await assert.rejects(h.check(), { code: "workflow_document_scope" });
    assert.deepEqual(h.state.documentSource, original);
    assert.deepEqual(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.documentSource, original);
    h.state.plan.documentDelivery = undefined;
    await assert.rejects(h.check(), { code: "workflow_document_scope" });
    writeFileSync(join(h.root, "app.ts"), "original source\n");
    await assert.rejects(h.check(), {
      code: "workflow_document_scope",
      message: /文档范围不能移除/,
    });
    h.state.plan.documentDelivery = { paths: original.paths, userRequest: h.task.requirements };
    await h.check();
  } finally {
    h.close();
  }
});

test("new document authorization cannot hide preexisting changes and directory changes fail closed", async () => {
  const h = await harness();
  try {
    await h.prepare();
    const original = structuredClone(h.state.documentSource);
    writeFileSync(join(h.root, "A.md"), "approved document\n");
    h.state.plan.documentDelivery = {
      paths: ["A.md", "B.md", "C.md"],
      userRequest: h.task.requirements,
    };
    writeFileSync(join(h.root, "C.md"), "previously unauthorized\n");
    await assert.rejects(h.prepare(), { code: "workflow_document_scope" });
    assert.deepEqual(h.state.documentSource, original);
    unlinkSync(join(h.root, "C.md"));
    await h.prepare();
    assert.deepEqual(h.state.documentSource?.paths, ["A.md", "B.md", "C.md"]);
    writeFileSync(join(h.root, "C.md"), "now authorized\n");
    await h.check();
    writeFileSync(join(h.root, "B.md"), "original authorization retained\n");
    await h.check();
    const other = join(h.directory, "other");
    mkdirSync(other);
    writeFileSync(join(other, "app.ts"), "original source\n");
    h.task.directories = [other];
    await assert.rejects(h.prepare(), { code: "workflow_document_scope", message: /目录已变化/ });
    await assert.rejects(h.check(), { code: "workflow_document_scope", message: /目录已变化/ });
  } finally {
    h.close();
  }
});

test("replanning cannot replace or remove an already written document from the source exclusions", async () => {
  const h = await harness();
  try {
    await h.prepare();
    const original = structuredClone(h.state.documentSource);
    assert.ok(original);
    writeFileSync(join(h.root, "B.md"), "document authored under the original plan\n");
    for (const paths of [["A.md", "C.md"], ["A.md"], undefined]) {
      h.state.plan.documentDelivery = paths
        ? { paths, userRequest: h.task.requirements }
        : undefined;
      await assert.rejects(h.prepare(), {
        code: "workflow_document_scope",
        message: /恢复原计划.*新建任务/,
      });
      await assert.rejects(h.check(), {
        code: "workflow_document_scope",
        message: /文档范围不能移除/,
      });
      assert.deepEqual(h.state.documentSource, original);
      assert.deepEqual(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.documentSource, original);
      assert.deepEqual(
        h.state.plan.documentDelivery?.paths,
        paths,
        "the guard must not silently reauthorize removed paths",
      );
    }
    h.task.promptVersion = 2;
    h.task.kind = "development";
    await assert.rejects(h.check(), {
      code: "workflow_document_scope",
      message: /文档范围不能移除/,
    });
    h.state.plan.documentDelivery = { paths: original.paths, userRequest: h.task.requirements };
    await h.prepare();
    await h.check();
    assert.deepEqual(h.state.documentSource, original);
  } finally {
    h.close();
  }
});

test("tasks without document capability do not require missing historical document evidence", async () => {
  const h = await harness();
  try {
    h.state.plan.documentDelivery = undefined;
    h.store.set("task_orchestration_events", "missing-archive", {
      taskId: h.task.id,
      workflow: { planVersion: 1 },
      dispatches: [{ nodeId: "old-node" }],
    });
    h.task.promptVersion = 2;
    await h.check();
    h.task.promptVersion = 3;
    h.task.kind = "development";
    await h.check();
    h.task.kind = "discussion";
    await assert.rejects(h.check(), { code: "workflow_document_scope" });
  } finally {
    h.close();
  }
});

test("read-only plan preparation returns a baseline without persisting and additions preserve its source", async () => {
  const h = await harness();
  try {
    h.state.plan.documentDelivery = undefined;
    const prepared = await prepareDocumentSource(h.store, h.task, h.state);
    assert.deepEqual(prepared.paths, []);
    assert.equal(h.state.documentSource, undefined);
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.documentSource, undefined);
    await h.prepare();
    const original = structuredClone(h.state.documentSource);
    h.state.plan.documentDelivery = { paths: ["A.md"], userRequest: h.task.requirements };
    writeFileSync(join(h.root, "app.ts"), "earlier read-only node changed source\n");
    await assert.rejects(h.prepare(), { code: "workflow_document_scope" });
    assert.deepEqual(h.state.documentSource, original);
    writeFileSync(join(h.root, "app.ts"), "original source\n");
    await h.prepare();
    assert.deepEqual(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.documentSource?.paths, [
      "A.md",
    ]);
    await h.check();
  } finally {
    h.close();
  }
});

for (const legacy of ["issue", "dispatch", "readonly-dispatch"] as const)
  test(`legacy ${legacy} cannot initialize a baseline from a potentially contaminated tree`, async () => {
    const h = await harness();
    try {
      if (legacy === "issue")
        h.state.issues.push({
          id: "document-scope-violation",
          description: "old violation",
          status: "resolved",
          blocking: true,
          evidenceRefs: [],
          raisedBy: "myrix",
          responses: [],
        });
      else
        h.store.set("task_orchestration_events", "old-event", {
          taskId: h.task.id,
          dispatches: [
            legacy === "dispatch"
              ? { sourceRevision: "old-source-revision" }
              : { nodeId: "opening-1" },
          ],
        });
      h.state.nodes = {};
      await assert.rejects(h.prepare(), { code: "workflow_document_scope" });
      assert.equal(h.state.documentSource, undefined);
      h.state.plan.documentDelivery = undefined;
      await assert.rejects(h.check(), { code: "workflow_document_scope" });
    } finally {
      h.close();
    }
  });

test("authorized total withdrawal prepares a read-only baseline without mutating accepted state", async () => {
  const h = await harness();
  try {
    await h.prepare();
    writeFileSync(join(h.root, "A.md"), "accepted document\n");
    const previous = structuredClone(h.state.documentSource);
    const { draft } = authorizedDraft(h);
    const prepared = await prepareDocumentSource(h.store, h.task, draft);
    assert.deepEqual(prepared.paths, []);
    assert.deepEqual(
      prepared.readonlyDocuments?.map(({ path }) => path),
      ["A.md", "B.md"],
    );
    assert.equal(prepared.readonlyDocuments?.find(({ path }) => path === "B.md")?.hash, null);
    assert.deepEqual(draft.documentSource, previous);
    assert.deepEqual(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.documentSource, previous);
    draft.documentSource = prepared;
    h.store.set(WORKFLOWS, h.task.id, draft);
    await assertDocumentSource(h.store, h.task, draft);
    assert.deepEqual(await prepareDocumentSource(h.store, h.task, draft), prepared);
    writeFileSync(join(h.root, "A.md"), "changed after withdrawal\n");
    await assert.rejects(assertDocumentSource(h.store, h.task, draft), {
      code: "workflow_document_scope",
    });
  } finally {
    h.close();
  }
});

for (const invalid of [
  "no-marker",
  "missing-decision",
  "foreign-task",
  "old-decision-version",
  "advanced-current-version",
  "different-source",
  "different-flags",
  "denied",
  "unverified-decision",
  "replaced-baseline",
  "partial-removal",
  "retained-writer",
  "unrevoked-consensus",
] as const)
  test(`document withdrawal rejects ${invalid} without replacing the source baseline`, async () => {
    const h = await harness();
    try {
      await h.prepare();
      const baseline = structuredClone(h.state.documentSource);
      const { draft, decision } = authorizedDraft(h);
      assert.ok(draft.plan.contractChange && draft.documentSource);
      if (invalid === "no-marker") draft.plan.contractChange.authorizationId = undefined;
      if (invalid === "foreign-task") decision.taskId = "another-task";
      if (invalid === "old-decision-version") decision.planVersion--;
      if (invalid === "advanced-current-version") h.state.plan.version++;
      if (invalid === "different-source") decision.change.sourceMessageId = "different-input";
      if (invalid === "different-flags") decision.change.removeConsensus = true;
      if (invalid === "denied") decision.decision = "denied";
      if (invalid === "unverified-decision") decision.jev.status = "skipped";
      if (invalid === "replaced-baseline") draft.documentSource.paths = ["A.md"];
      if (invalid === "partial-removal")
        draft.plan.documentDelivery = { paths: ["A.md"], userRequest: h.task.requirements };
      if (invalid === "retained-writer") {
        const first = draft.plan.nodes[0];
        assert.ok(first);
        first.access = "write";
        first.documentPaths = ["A.md"];
      }
      if (invalid === "unrevoked-consensus")
        h.state.plan.consensus = { participantIds: h.task.participantIds };
      h.store.set(WORKFLOWS, h.task.id, h.state);
      h.store.set("workflow_contract_decisions", "withdrawal-authorization", decision);
      if (invalid === "missing-decision")
        h.store.delete("workflow_contract_decisions", "withdrawal-authorization");
      await assert.rejects(prepareDocumentSource(h.store, h.task, draft), {
        code: "workflow_document_scope",
      });
      assert.deepEqual(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.documentSource, baseline);
    } finally {
      h.close();
    }
  });

for (const mutation of ["source", "directory", "document-type", "between-checks"] as const)
  test(`authorized withdrawal cannot reset ${mutation} changes outside the old scope`, async () => {
    const h = await harness();
    try {
      await h.prepare();
      const { draft } = authorizedDraft(h);
      const previous = structuredClone(h.state.documentSource);
      if (mutation === "source") writeFileSync(join(h.root, "app.ts"), "unauthorized source\n");
      if (mutation === "directory") {
        const other = join(h.directory, "other");
        mkdirSync(other);
        writeFileSync(join(other, "app.ts"), "original source\n");
        h.task.directories = [other];
      }
      if (mutation === "document-type") symlinkSync(join(h.root, "app.ts"), join(h.root, "A.md"));
      if (mutation === "between-checks") {
        let checks = 0;
        const get = h.store.get.bind(h.store);
        Object.assign(h.store, {
          get(namespace: string, key: string) {
            if (namespace === "workflow_contract_decisions" && ++checks === 2)
              writeFileSync(join(h.root, "app.ts"), "source changed while preparing\n");
            return get(namespace, key);
          },
        });
      }
      await assert.rejects(prepareDocumentSource(h.store, h.task, draft), {
        code: "workflow_document_scope",
      });
      assert.deepEqual(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.documentSource, previous);
    } finally {
      h.close();
    }
  });

for (const mutation of ["content", "deletion", "creation"] as const)
  test(`withdrawn Git-ignored documents reject ${mutation} and cannot be reauthorized over a changed snapshot`, async () => {
    const h = await harness();
    try {
      execFileSync("git", ["init", "-q", h.root]);
      writeFileSync(join(h.root, ".gitignore"), "*.md\n");
      await h.prepare();
      writeFileSync(join(h.root, "A.md"), "approved ignored document\n");
      const { draft } = authorizedDraft(h);
      draft.documentSource = await prepareDocumentSource(h.store, h.task, draft);
      h.store.set(WORKFLOWS, h.task.id, draft);
      const snapshot = structuredClone(draft.documentSource);
      const revision = await workspaceRevision(h.task.directories);
      if (mutation === "content") writeFileSync(join(h.root, "A.md"), "changed ignored document\n");
      if (mutation === "deletion") unlinkSync(join(h.root, "A.md"));
      if (mutation === "creation") writeFileSync(join(h.root, "B.md"), "new ignored document\n");
      assert.equal(await workspaceRevision(h.task.directories), revision);
      await assert.rejects(assertDocumentSource(h.store, h.task, draft), {
        code: "workflow_document_scope",
      });
      const reauthorized = structuredClone(draft);
      reauthorized.plan.documentDelivery = {
        paths: ["A.md", "B.md"],
        userRequest: h.task.requirements,
      };
      await assert.rejects(prepareDocumentSource(h.store, h.task, reauthorized), {
        code: "workflow_document_scope",
      });
      assert.deepEqual(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.documentSource, snapshot);
      writeFileSync(join(h.root, "A.md"), "approved ignored document\n");
      if (mutation === "creation") unlinkSync(join(h.root, "B.md"));
      const prepared = await prepareDocumentSource(h.store, h.task, reauthorized);
      assert.deepEqual(prepared.readonlyDocuments, []);
      reauthorized.documentSource = prepared;
      h.store.set(WORKFLOWS, h.task.id, reauthorized);
      writeFileSync(join(h.root, "A.md"), "authorized new document content\n");
      await assertDocumentSource(h.store, h.task, reauthorized);
    } finally {
      h.close();
    }
  });

for (const contaminated of [false, true])
  test(`runner accepts an authorized total withdrawal only after validating the original source (contaminated=${contaminated})`, async () => {
    const h = await harness();
    try {
      assert.ok(h.config.jev);
      h.config.jev.apiKey = "fixture-only";
      h.task.requirements = "保存 A.md 和 B.md，双方认可后交付。";
      h.service.records.save(h.task);
      assert.ok(h.state.plan.documentDelivery);
      h.state.plan.documentDelivery.userRequest = h.task.requirements;
      addDocumentDelivery(h.state.plan);
      compileConsensus(h.state.plan, h.task.participantIds);
      h.state.planning = "ready";
      await h.prepare();
      const originalBaseline = structuredClone(h.state.documentSource);
      writeFileSync(join(h.root, "A.md"), "previously authorized A\n");
      writeFileSync(join(h.root, "B.md"), "previously authorized B\n");
      if (contaminated) writeFileSync(join(h.root, "app.ts"), "unauthorized code change\n");
      const who: ActorContext = {
        ...actor,
        source: "feishu",
        chatType: "private",
        messageId: "withdraw-documents",
      };
      h.store.set<InboxRecord>("inbox", `message:${who.messageId}`, {
        id: `message:${who.messageId}`,
        type: "message",
        actor: who,
        payload: {
          source: "feishu",
          chatType: "private",
          eventId: who.messageId,
          messageId: who.messageId,
          ownerId: who.ownerId,
          chatId: who.chatId,
          text: "取消全部项目文档交付和双方认可，之后只做只读讨论。",
          mentionedBot: false,
        },
        lane: "owner",
        state: "done",
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
      associateTaskUserRequest(h.store, who, h.task, "input");
      const sourceMessageId = stableId(h.task.id, who.messageId);
      const engine = new Engine();
      engine.handler = async (input) => {
        const tool = input.tools.find((candidate) => candidate.name === "orchestration_plan");
        assert.ok(tool);
        await tool.execute(
          {
            template: "discussion",
            instructions: {},
            deliveryRequirements: [],
            contractChange: {
              sourceMessageId,
              removeDocumentDelivery: true,
              removeConsensus: true,
            },
          },
          input.actor,
        );
        return { text: "", messages: [] };
      };
      const events = () => h.store.list<OrchestrationEvent>("task_orchestration_events");
      const current = () => h.service.records.get(actor, h.task.id);
      const ports: WorkflowPorts = {
        store: h.store,
        config: h.config,
        engine,
        tasks: () => h.service,
        tools: () => [],
        logger,
        signal: new AbortController().signal,
        current,
        foregroundPending: () => false,
        revision: () => "withdrawal-revision",
        baseRevision: () => "withdrawal-revision",
        userMessages: () => orchestrationUserMessages(h.store, h.task),
        events,
        outputs: () => [],
        save: (event) => h.store.set("task_orchestration_events", event.id, event),
        assertCurrent: current,
        reconcile() {},
        notify: async () => {},
        attention: async () => {},
        recoverNotification: async () => {},
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          const candidates = Object.keys(body.questions.action.criteria);
          const selected = candidates.includes("authorized") ? "authorized" : "request_pi";
          return Response.json({
            model: "fixture",
            answers: {
              action: {
                type: "choice",
                choice: selected,
                confidence: 0.99,
                probabilities: Object.fromEntries(
                  candidates.map((id) => [id, id === selected ? 1 : 0]),
                ),
              },
            },
            usage: { input_tokens: 10, output_tokens: 1 },
          });
        },
      };
      await new WorkflowOrchestrator(ports).process(h.task);
      const accepted = h.store.get<WorkflowState>(WORKFLOWS, h.task.id);
      assert.ok(accepted);
      const decision = h.store.list<ContractChangeDecision>("workflow_contract_decisions")[0];
      assert.equal(
        decision?.decision,
        "authorized",
        "choosePlan genuinely authorizes the latest user request",
      );
      assert.equal(decision?.planVersion, 2);
      if (contaminated) {
        assert.equal(accepted.planning, "needed");
        assert.deepEqual(accepted.documentSource, originalBaseline);
        assert.ok(accepted.plan.documentDelivery);
        assert.equal(events()[0]?.state, "attention");
        assert.equal(events()[0]?.error?.code, "workflow_document_scope");
        assert.equal(h.store.get("workflow_plans", `${h.task.id}:2`), undefined);
      } else {
        assert.equal(accepted.planning, "ready", JSON.stringify(events()));
        assert.equal(accepted.plan.documentDelivery, undefined);
        assert.equal(accepted.plan.consensus, undefined);
        assert.deepEqual(accepted.documentSource?.paths, []);
        assert.equal(accepted.documentSource?.readonlyDocuments?.length, 2);
        assert.equal(
          accepted.plan.nodes.some((node) => node.access === "write" || node.documentPaths?.length),
          false,
        );
        assert.equal(events()[0]?.state, "done");
        assert.ok(h.store.get("workflow_plans", `${h.task.id}:2`));
        await assertDocumentSource(h.store, h.task, accepted);
        writeFileSync(join(h.root, "A.md"), "no longer authorized\n");
        await assert.rejects(assertDocumentSource(h.store, h.task, accepted), {
          code: "workflow_document_scope",
        });
      }
      assert.equal(h.herdr.sends.length, 0);
    } finally {
      h.close();
    }
  });
