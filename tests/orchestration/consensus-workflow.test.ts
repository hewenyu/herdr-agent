import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { handoffDirectory } from "../../src/orchestration/handoff.js";
import type { StatusBlock } from "../../src/orchestration/status-block.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { Engine, logger } from "../app/helpers.js";
import { chooseLeaderAction, leaderEventPrompt } from "../app/leader-helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

const documentPath = "docs/DESIGN.md";
const documentText = "# 一致设计\n\n使用有界队列隔离调度和发送；重试保留同一操作标识。\n";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function harness(ignoredDocument = false) {
  const h = setup();
  h.config.ai.enabled = true;
  assert.ok(h.config.jev);
  h.config.jev.apiKey = "fixture-only";
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "app.ts"), "// unchanged\n");
  if (ignoredDocument) {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, ".gitignore"), "docs/\n");
    execFileSync("git", ["-C", repo, "add", ".gitignore", "app.ts"]);
  }
  await h.catalog.save({ name: "consensus", directories: [repo], agent: "codex" });
  const requirements = "讨论调度方案并保存 docs/DESIGN.md；双方都认可同版最终文档后再交付。";
  const task = await h.service.create(actor, {
    ...discussion,
    project: "consensus",
    requirements,
    orchestration: { mode: "workflow" },
  });
  // The fixture supplies the already-authenticated ingress source; creation provenance has its own tests.
  task.userRequest = {
    source: "web",
    ownerId: actor.ownerId,
    sessionId: actor.sessionId,
    chatId: actor.chatId,
    messageId: "original-consensus-request",
    eventId: "original-consensus-request",
    text: requirements,
  };
  h.service.records.save(task);
  await h.service.reconcile(task.id);
  const engine = new Engine();
  const choices: string[] = [];
  engine.handler = async (request) => {
    if (
      await chooseLeaderAction(request, (ids) => {
        const selected =
          ids.find((id) => id.startsWith("deliver:")) ??
          ids.find((id) => id.startsWith("dispatch:")) ??
          ids.find((id) => id.startsWith("resolve:")) ??
          ids.find((id) => id.startsWith("rework:")) ??
          ids[0];
        assert.ok(selected);
        choices.push(selected);
        return selected;
      })
    )
      return { text: "", messages: [] };
    assert.equal(
      request.tools[0]?.name,
      "orchestration_choice",
      "fixed consensus never invokes a graph planner",
    );
    const ids: string[] = JSON.parse(leaderEventPrompt(request)).candidates.map(
      (candidate: { id: string }) => candidate.id,
    );
    const selected = ids.includes("use_consensus_document_template")
      ? "use_consensus_document_template"
      : ids.includes("authorized")
        ? "authorized"
        : (ids.find((id) => id.startsWith("deliver:")) ??
          ids.find((id) => id.startsWith("dispatch:")) ??
          ids.find((id) => id.startsWith("resolve:")) ??
          ids.find((id) => id.startsWith("rework:")) ??
          ids[0]);
    assert.ok(selected);
    choices.push(selected);
    await request.tools[0]?.execute({ candidateId: selected }, request.actor);
    return { text: "", messages: [] };
  };
  const replies: Array<{ text: string; eventId: string }> = [];
  const options = {
    store: h.store,
    engine,
    tasks: () => h.service,
    tools: () => [],
    config: h.config,
    projects: h.catalog,
    logger,
    signal: new AbortController().signal,
    retryDelayMs: 0,
    onReply: async (_task: unknown, text: string, eventId: string) => {
      replies.push({ text, eventId });
    },
  };
  const worker = new TaskOrchestrator(options);
  const state = () => {
    const value = h.store.get<WorkflowState>(WORKFLOWS, task.id);
    assert.ok(value);
    return value;
  };
  const events = () =>
    h.store
      .list<OrchestrationEvent>("task_orchestration_events")
      .filter((event) => event.taskId === task.id);
  const deliveries = () =>
    replies.filter((reply) =>
      events().some((event) => event.id === reply.eventId && event.decision?.action === "deliver"),
    );
  const request = (nodeId: string) => {
    const progress = state().nodes[nodeId];
    assert.ok(
      progress?.operationId && progress.participantId && progress.inputRevision,
      JSON.stringify({ nodeId, state: state(), events: events() }),
    );
    const directory = handoffDirectory(h.config.stateDir, task.id, progress.operationId);
    const block = JSON.parse(readFileSync(join(directory, "request.json"), "utf8")) as StatusBlock;
    return { progress, directory, block };
  };
  const finish = async (
    nodeId: string,
    extra: Partial<StatusBlock> = {},
    keepEmptyResponses = false,
  ) => {
    const { progress, directory, block } = request(nodeId);
    const participant = h.service.records
      .participants(task)
      .find((entry) => entry.id === progress.participantId);
    assert.ok(participant?.execution);
    const responses = block.responses?.map(({ outputId, comment }) => {
      assert.equal(comment, "", "request templates never prefill an accepted response");
      const notes = readFileSync(
        join(task.boardDirectory as string, "outputs", `${outputId}.notes.md`),
        "utf8",
      );
      assert.match(notes, /有界队列/);
      return {
        outputId,
        comment: keepEmptyResponses ? "" : "接受有界队列隔离，补充操作标识幂等约束。",
      };
    });
    const currentDocument = nodeId.startsWith("opening-")
      ? undefined
      : readFileSync(join(repo, documentPath), "utf8");
    writeFileSync(
      join(directory, "notes.md"),
      `# ${nodeId}\n\n已核对有界队列及操作标识幂等约束。\n`,
    );
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify({
        ...block,
        summary: `${nodeId}：已核对有界队列和幂等约束。`,
        responses,
        ...(currentDocument ? { artifactRefs: [documentPath] } : {}),
        ...(block.consensus
          ? { consensus: { approved: true, documents: block.consensus.documents } }
          : {}),
        ...extra,
      }),
    );
    if (nodeId === "report")
      writeFileSync(
        join(directory, "report.md"),
        state()
          .plan.deliveryRequirements.map(
            (title) => `## ${title}\n\n双方已核对有界队列和幂等约束，认可同版文档。`,
          )
          .join("\n\n"),
      );
    h.herdr.finish(
      participant.execution.paneId,
      `已回应前序意见并核对有界队列，详细材料见 ${join(directory, "notes.md")}。`,
    );
    await h.service.reconcile(task.id);
  };
  const toFirstConfirmation = async () => {
    await worker.tick();
    assert.deepEqual(choices.slice(0, 2), ["use_consensus_document_template", "authorized"]);
    assert.equal(engine.calls.length, 2);
    assert.deepEqual(state().plan.consensus?.participantIds, task.participantIds);
    await worker.tick();
    assert.equal(state().nodes["opening-1"]?.status, "dispatched");
    assert.equal(state().nodes["opening-2"]?.status, "pending");
    await finish("opening-1");
    await worker.tick();
    assert.equal(state().nodes["opening-2"]?.status, "dispatched");
    await finish("opening-2");
    await worker.tick();
    assert.equal(state().nodes.document?.status, "dispatched");
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, documentPath), documentText);
    await finish("document");
    await worker.tick();
    assert.notEqual(
      state().nodes.document?.participantId,
      state().nodes["cross-review"]?.participantId,
    );
    await finish("cross-review");
    await worker.tick();
    assert.equal(state().nodes["confirm-1"]?.status, "dispatched");
    assert.equal(state().nodes["confirm-1"]?.participantId, task.participantIds[0]);
    assert.equal(state().nodes.report?.status, "pending");
    assert.equal(deliveries().length, 0);
  };
  const confirmBoth = async () => {
    await toFirstConfirmation();
    await finish("confirm-1");
    await worker.tick();
    assert.equal(state().nodes["confirm-2"]?.participantId, task.participantIds[1]);
    assert.equal(state().consensusApprovals?.length, 1);
    assert.equal(state().nodes.report?.status, "pending");
    await finish("confirm-2");
    await worker.tick();
    assert.equal(state().consensusApprovals?.length, 2);
    assert.equal(state().nodes.report?.status, "dispatched");
  };
  return {
    ...h,
    task,
    repo,
    worker,
    options,
    state,
    events,
    request,
    finish,
    replies,
    deliveries,
    engine,
    toFirstConfirmation,
    confirmBoth,
  };
}

test("fixed consensus workflow collects both native confirmations and delivers once across restart", async () => {
  const h = await harness();
  try {
    await h.confirmBoth();
    const approvals = h.state().consensusApprovals;
    assert.deepEqual(
      approvals?.map((entry) => entry.participantId),
      h.task.participantIds,
    );
    assert.ok(approvals?.every((entry) => entry.documents[0]?.hash === digest(documentText)));
    await h.finish("report");
    await h.worker.tick();
    assert.equal(h.state().phase, "awaiting_acceptance");
    assert.equal(h.replies.length, 1);
    assert.equal(h.deliveries().length, 1);
    assert.ok(
      h.engine.calls.every(
        (input) => !input.tools.some((tool) => tool.name === "orchestration_plan"),
      ),
      "the fixed consensus graph is never replanned by the model",
    );
    assert.ok(
      h.engine.calls.some(
        (input) =>
          input.sessionId.startsWith("task-leader:") &&
          input.tools.some((tool) => tool.name === "workflow_status"),
      ),
      "the durable Leader still chooses legal actions on the fixed graph",
    );
    assert.match(h.replies[0]?.text ?? "", /同版文档/);
    assert.doesNotMatch(
      h.replies[0]?.text ?? "",
      /myrix-status|protocolVersion|"operationId"|"approved"/,
    );
    assert.equal(readFileSync(join(h.repo, "app.ts"), "utf8"), "// unchanged\n");
    assert.ok(h.herdr.sends.every((send) => !/myrix-status|"protocolVersion"/.test(send.text)));
    const sends = h.herdr.sends.length;
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.herdr.sends.length, sends);
    assert.equal(h.deliveries().length, 1);
  } finally {
    h.close();
  }
});

test("a participant's explicit refusal retains the disagreement and cannot become a delivered consensus", async () => {
  const h = await harness();
  try {
    await h.toFirstConfirmation();
    const { block } = h.request("confirm-1");
    await h.finish("confirm-1", {
      status: "needs_work",
      consensus: { approved: false, documents: block.consensus?.documents ?? [] },
      issues: [
        {
          id: "queue-bound",
          description: "有界队列满载策略尚未达成一致。",
          status: "open",
          blocking: false,
          evidenceRefs: [documentPath],
        },
      ],
    });
    await h.worker.tick();
    assert.ok(
      h.state().issues.some((issue) => issue.id === "queue-bound" && issue.status === "open"),
    );
    assert.equal(h.state().consensusApprovals?.length ?? 0, 0);
    assert.equal(h.state().nodes.report?.status, "pending");
    assert.equal(h.state().report, undefined);
    assert.equal(h.deliveries().length, 0);
    assert.ok(!h.events().some((event) => event.decision?.action === "deliver"));
  } finally {
    h.close();
  }
});

test("a changed ignored document cannot reuse earlier approvals even with an unchanged workspace revision", async () => {
  const h = await harness(true);
  try {
    await h.confirmBoth();
    const revision = await workspaceRevision(h.task.directories);
    writeFileSync(join(h.repo, documentPath), "# 未经双方认可的新版本\n改用无界队列。\n");
    assert.equal(await workspaceRevision(h.task.directories), revision);
    await h.finish("report");
    await h.worker.tick();
    assert.equal(h.state().report, undefined);
    assert.notEqual(h.state().phase, "awaiting_acceptance");
    assert.equal(h.deliveries().length, 0);
    assert.ok(!h.events().some((event) => event.decision?.action === "deliver"));
  } finally {
    h.close();
  }
});

test("copying an empty response template does not advance the next speaker into document delivery", async () => {
  const h = await harness();
  try {
    await h.worker.tick();
    await h.worker.tick();
    await h.finish("opening-1");
    await h.worker.tick();
    await h.finish("opening-2", {}, true);
    await h.worker.tick();
    assert.notEqual(h.state().nodes["opening-2"]?.status, "completed");
    assert.equal(h.state().nodes.document?.status, "pending");
    assert.equal(h.deliveries().length, 0);
    assert.equal(h.state().report, undefined);
  } finally {
    h.close();
  }
});
