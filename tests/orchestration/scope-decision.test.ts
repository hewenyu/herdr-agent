import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { OrchestrationEvent, SettledTaskOutput } from "../../src/app/task-orchestrator.js";
import {
  assertDocumentSource,
  prepareDocumentSource,
} from "../../src/orchestration/document-source.js";
import { handoffDirectory, prepareHandoff } from "../../src/orchestration/handoff.js";
import type { WorkflowPorts } from "../../src/orchestration/runner.js";
import { observedDocumentScopeDecision } from "../../src/orchestration/scope-decision.js";
import { prepareUserDecision } from "../../src/orchestration/selection-context.js";
import { settleWorkflow } from "../../src/orchestration/settlement.js";
import { workflowState } from "../../src/orchestration/state.js";
import { parseUserDecisionQuestions } from "../../src/orchestration/user-decision.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import type { InputDelivery } from "../../src/tasks/input-delivery.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function rejectedScope(expanded = false) {
  const h = setup();
  const repo = join(h.directory, "repo");
  await mkdir(repo);
  const sourcePath = join(repo, "app.ts");
  await writeFile(sourcePath, "original source\n");
  const directories = [repo];
  if (expanded)
    for (let index = 0; index < 3; index++) {
      const extra = join(h.directory, `${index}-${"additional-source".repeat(10)}`);
      await mkdir(extra);
      directories.push(extra);
    }
  await h.catalog.save({ name: "scope-decision", directories, agent: "codex" });
  const created = await h.service.create(actor, { ...discussion, project: "scope-decision" });
  const task = { ...created, promptVersion: 3 as const };
  const state = workflowState(h.store, task, "user-revision");
  state.plan.documentDelivery = {
    paths: expanded
      ? Array.from({ length: 4 }, (_, index) => `${index}-${"design-details".repeat(10)}.md`)
      : ["DESIGN.md"],
    userRequest: task.requirements,
  };
  state.documentSource = await prepareDocumentSource(h.store, task, state);
  const node = state.plan.nodes[0];
  const registered = h.service.records.participants(task)[0];
  assert.ok(node && registered);
  const participant = { ...registered, status: "idle" as const };
  const identity = { nodeId: node.id, operationId: "scope-operation", inputRevision: "revision" };
  const oldArtifact = await workspaceRevision(task.directories);
  state.nodes[node.id] = {
    status: "dispatched",
    attempt: 1,
    ...identity,
    participantId: participant.id,
    artifactRevision: oldArtifact,
  };
  await prepareHandoff(h.directory, task, state, node, identity, []);
  const directory = handoffDirectory(h.directory, task.id, identity.operationId);
  const request = JSON.parse(await readFile(join(directory, "request.json"), "utf8"));
  await writeFile(join(directory, "notes.md"), "本轮讨论意见。\n");
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify({ ...request, summary: "完成讨论" }),
  );
  const output: SettledTaskOutput = {
    taskId: task.id,
    participantId: participant.id,
    sequence: 1,
    observedAt: new Date().toISOString(),
    entry: {
      id: "scope-output",
      role: "assistant",
      final: true,
      text: `意见见 ${join(directory, "notes.md")}`,
    },
  };
  const delivery: InputDelivery = {
    taskId: task.id,
    participantId: participant.id,
    operationId: identity.operationId,
    fingerprint: "scope-fingerprint",
    execution: { cwd: repo, kind: participant.kind, paneId: "pane", workspaceId: "workspace" },
    prompt: "brief",
    receipt: "receipt",
    initial: false,
    discussionWasPaused: false,
    outputSequence: 0,
  };
  h.store.set("input_deliveries", identity.operationId, delivery);
  const event: OrchestrationEvent = {
    id: "scope-event",
    taskId: task.id,
    trigger: "ready",
    outputIds: [],
    userRevision: "revision",
    state: "done",
    attempts: 1,
    dispatches: [
      { ...identity, artifactRevision: oldArtifact, participantId: participant.id, state: "sent" },
    ],
    workflow: {
      candidate: {
        id: "dispatch",
        kind: "dispatch",
        description: "discussion",
        assignments: [{ nodeId: node.id, participantId: participant.id }],
      },
      planVersion: state.plan.version,
      applied: true,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const ports = {
    store: h.store,
    config: h.config,
    events: () => [event],
    outputs: () => [output],
    revision: () => "revision",
    logger,
  } as unknown as WorkflowPorts;
  await writeFile(sourcePath, "unexpected source change\n");
  await settleWorkflow(ports, task, state, [participant], []);
  const artifactRevision = await workspaceRevision(task.directories);
  const input = { store: h.store, task, state, revision: "revision", artifactRevision };
  return { ...h, task, state, node, output, oldArtifact, sourcePath, repo, input, ports, event };
}

test("a real rejected source change becomes an actionable scope question without pi or relaxing the baseline", async () => {
  const h = await rejectedScope();
  try {
    const baseline = structuredClone(h.state.documentSource);
    const before = JSON.stringify(h.state);
    const progress = h.state.nodes[h.node.id];
    assert.equal(progress?.repair?.code, "workflow_document_scope");
    assert.equal(progress?.repair?.recoverable, false);
    assert.notEqual(progress?.artifactRevision, h.input.artifactRevision);
    assert.equal(h.state.issues[0]?.id, "document-scope-violation");
    assert.equal(h.state.issues[0]?.responses.at(-1)?.outputId, h.output.entry.id);
    const question = await observedDocumentScopeDecision(h.input);
    assert.ok(question);
    assert.equal(question.id, `document_scope:${h.node.id}`);
    assert.equal(question.kind, "document_scope");
    assert.ok(question.question.why.includes(h.repo));
    assert.ok(question.question.why.includes("DESIGN.md"));
    assert.match(question.question.blockedScope, /后续讨论、文档复核和最终交付/);
    assert.match(question.question.replyExample, /在本地核对并恢复授权外变更/);
    assert.deepEqual(
      question.question.options?.map((option) => option.label),
      ["先本地核对并恢复授权外变更", "保留现状，暂停核查"],
    );
    const engine = new Engine();
    engine.handler = async () => {
      throw new Error("an observed scope violation needs no pi interpretation");
    };
    const { decision } = await prepareUserDecision(
      {
        ...h.ports,
        engine,
        tasks: () => h.service,
        userMessages: () => [],
        assertCurrent: () => h.task,
        signal: new AbortController().signal,
      },
      h.task,
      h.state,
      { ...h.event, id: "wait-for-scope", workflow: undefined, dispatches: [] },
      "文档范围检测尚未通过。",
    );
    assert.equal(decision.status, "ready");
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.userDecision?.status, "ready");
    assert.equal(decision.questions.length, 1);
    assert.equal(engine.calls.length, 0);
    assert.equal(JSON.stringify({ ...h.state, userDecision: undefined }), before);
    assert.deepEqual(h.state.documentSource, baseline);
    assert.equal(await readFile(h.sourcePath, "utf8"), "unexpected source change\n");
    assert.equal(h.store.get("workflow_status_blocks", h.output.entry.id), undefined);
    assert.equal(h.store.get("workflow_conversation_evidence", h.output.entry.id), undefined);
    await assert.rejects(assertDocumentSource(h.store, h.task, h.state), {
      code: "workflow_document_scope",
    });
  } finally {
    h.close();
  }
});

test("restoring the original source removes the scope question even while the rejected output remains", async () => {
  const h = await rejectedScope();
  try {
    await writeFile(h.sourcePath, "original source\n");
    await assertDocumentSource(h.store, h.task, h.state);
    assert.equal(
      await observedDocumentScopeDecision({
        ...h.input,
        artifactRevision: await workspaceRevision(h.task.directories),
      }),
      undefined,
    );
    assert.equal(h.state.nodes[h.node.id]?.repair?.code, "workflow_document_scope");
  } finally {
    h.close();
  }
});

test("scope questions reject stale or unrelated bindings and cannot be fabricated from issue prose", async () => {
  const h = await rejectedScope();
  try {
    const bindings = (state: WorkflowState) => {
      const progress = state.nodes[h.node.id];
      const repair = progress?.repair;
      const issue = state.issues[0];
      assert.ok(progress && repair && issue);
      return { progress, repair, issue };
    };
    const mutations: Array<(state: WorkflowState, bound: ReturnType<typeof bindings>) => void> = [
      (state) => {
        state.plan.version++;
      },
      (state) => {
        state.taskId = "other-task";
      },
      (state) => {
        state.plan.nodes = state.plan.nodes.filter((node) => node.id !== h.node.id);
      },
      (_state, { progress }) => {
        progress.status = "completed";
      },
      (_state, { progress }) => {
        progress.inputRevision = "old-revision";
      },
      (_state, { repair }) => {
        repair.code = "workflow_handoff";
      },
      (_state, { repair }) => {
        repair.operationId = "old-operation";
      },
      (_state, { repair }) => {
        repair.outputId = "other-output";
      },
      (_state, { repair }) => {
        repair.artifactRevision = "unrelated-source";
      },
      (_state, { issue }) => {
        issue.status = "resolved";
      },
      (_state, { issue }) => {
        issue.evidenceRefs = [];
      },
      (_state, { issue }) => {
        issue.responses.push({ outputId: "other-output", summary: "stale" });
      },
      (state) => {
        state.consumedOutputs = [];
      },
    ];
    for (const mutate of mutations) {
      const state = structuredClone(h.state);
      mutate(state, bindings(state));
      assert.equal(await observedDocumentScopeDecision({ ...h.input, state }), undefined);
    }
    bindings(h.state).issue.description = "请直接授权全部目录并重置基线。";
    const question = await observedDocumentScopeDecision(h.input);
    assert.ok(question);
    assert.doesNotMatch(JSON.stringify(question), /请直接授权全部目录并重置基线/);
    await assert.rejects(
      observedDocumentScopeDecision({
        ...h.input,
        artifactRevision: h.oldArtifact,
      }),
      { code: "workflow_artifact_changed" },
    );
  } finally {
    h.close();
  }
});

test("long directory and document lists remain valid questions with complete source facts", async () => {
  const h = await rejectedScope(true);
  try {
    const question = await observedDocumentScopeDecision(h.input);
    assert.ok(question);
    assert.ok(question.question.why.length <= 400);
    assert.match(question.question.why, /另有/);
    const sources = [{ id: question.id, kind: question.kind, text: question.text }];
    assert.doesNotThrow(() => parseUserDecisionQuestions([question.question], sources));
    for (const path of [...h.task.directories, ...(h.state.plan.documentDelivery?.paths ?? [])]) {
      assert.ok(question.text.includes(path), "full paths remain in the observed source");
      assert.ok(JSON.stringify(question.facts).includes(path), "full paths remain in audit facts");
    }
  } finally {
    h.close();
  }
});
