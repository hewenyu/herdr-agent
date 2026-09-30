import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  type OrchestrationEvent,
  type SettledTaskOutput,
  TaskOrchestrator,
} from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import { workflowCandidates } from "../../src/orchestration/candidates.js";
import type { DecisionLog } from "../../src/orchestration/decision-log.js";
import { handoffDirectory } from "../../src/orchestration/handoff.js";
import {
  WORKFLOW_RECOVERY,
  type WorkflowRecoveryMaterial,
} from "../../src/orchestration/receipt-recovery.js";
import type { WorkflowPorts } from "../../src/orchestration/runner.js";
import { receiptRepairRule } from "../../src/orchestration/selection-context.js";
import { settleWorkflow } from "../../src/orchestration/settlement.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function harness() {
  const h = setup();
  h.config.ai.enabled = true;
  assert.ok(h.config.jev);
  h.config.jev.apiKey = "fixture-only";
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "source stays unchanged");
  await h.catalog.save({ name: "repair", directories: [repo], agent: "codex" });
  const task = await h.service.create(actor, {
    ...discussion,
    project: "repair",
    requirements: "双方轮流讨论小说阅读器设计。",
    orchestration: { mode: "workflow" },
  });
  await h.service.reconcile(task.id);
  const engine = new Engine();
  engine.handler = async (input) => {
    assert.equal(input.tools[0]?.name, "orchestration_choice");
    const ids: string[] = JSON.parse(input.prompt).candidates.map(
      (candidate: { id: string }) => candidate.id,
    );
    calls.push(ids);
    const choice = ids.includes("use_template") ? "use_template" : ids[0];
    await input.tools[0]?.execute({ candidateId: choice }, input.actor);
    return { text: "", messages: [] };
  };
  const calls: string[][] = [];
  const replies: string[] = [];
  const options = {
    store: h.store,
    config: h.config,
    projects: h.catalog,
    engine,
    tasks: () => h.service,
    tools: () => [],
    logger,
    signal: new AbortController().signal,
    retryDelayMs: 0,

    onReply: async (_task: unknown, text: string) => {
      replies.push(text);
    },
  };
  const worker = new TaskOrchestrator(options);
  const state = () => h.store.get<WorkflowState>(WORKFLOWS, task.id) as WorkflowState;
  const events = () => h.store.list<OrchestrationEvent>("task_orchestration_events");
  const finish = async (nodeId: string, malformed = false) => {
    const progress = state().nodes[nodeId];
    assert.ok(progress?.operationId);
    const participant = h.service.records
      .participants(task)
      .find((p) => p.id === progress.participantId);
    assert.ok(participant?.execution);
    const directory = handoffDirectory(h.config.stateDir, task.id, progress.operationId);
    const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8"));
    writeFileSync(
      join(directory, "notes.md"),
      "已读取对方初稿。我建议将翻页原型提前，并同意本地优先。需要对方回应。\n",
    );
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify({
        ...request,
        summary: "已完成实质评审",
        artifactRefs: [join(directory, "notes.md")],
      }),
    );
    h.herdr.finish(
      participant.execution.paneId,
      malformed ? "完成评审，详见本轮 notes.md。" : `已回应对方，见 ${join(directory, "notes.md")}`,
    );
    await h.service.reconcile(task.id);
    return { directory, operationId: progress.operationId };
  };
  await worker.tick();
  await worker.tick();
  await finish("opening-1");
  await worker.tick();
  return { ...h, task, repo, worker, options, state, events, finish, calls, replies, engine };
}

test("a rejected Claude handoff is repaired once through the existing dispatch chain without Jev or pi", async () => {
  const h = await harness();
  try {
    const initial = await h.finish("opening-2", true);
    const calls = h.calls.length;
    await h.worker.tick();
    const progress = h.state().nodes["opening-2"];
    assert.equal(progress?.status, "dispatched");
    assert.notEqual(progress.operationId, initial.operationId);
    assert.equal(h.calls.length, calls, "a known protocol repair is deterministic");
    assert.equal(
      h.engine.calls.length,
      calls,
      "repair adds no pi call beyond prior planning choices",
    );
    const repairEvent = h.events().find((event) => event.decision?.reason === "receipt_repair");
    assert.equal(repairEvent?.decision?.source, "rule");
    assert.equal(repairEvent?.dispatches.length, 1);
    assert.equal(repairEvent?.dispatches[0]?.state, "sent");
    const material = h.store.list<WorkflowRecoveryMaterial>(WORKFLOW_RECOVERY)[0];
    assert.equal(material?.validation, "unverified");
    assert.match(material?.notes ?? "", /翻页原型提前/);
    assert.equal(
      h.store.get("workflow_conversation_evidence", material?.outputId ?? ""),
      undefined,
    );
    const log = h.store.get<DecisionLog>("workflow_decisions", repairEvent?.selectionLogId ?? "");
    assert.match(JSON.stringify(log?.snapshot), /unverified.*翻页原型提前/s);
    const directory = handoffDirectory(
      h.config.stateDir,
      h.task.id,
      progress.operationId as string,
    );
    assert.match(readFileSync(join(directory, "brief.md"), "utf8"), /修复|修正/);
    assert.match(readFileSync(join(directory, "prior-notes.md"), "utf8"), /翻页原型提前/);
    const count = h.herdr.sends.length;
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.herdr.sends.length, count, "worker restart does not repeat a live dispatch");
    await h.finish("opening-2");
    await h.worker.tick();
    assert.equal(h.state().nodes["opening-2"]?.status, "completed");
    assert.equal(h.state().nodes["opening-2"]?.repair, undefined);
    assert.equal(h.state().assistanceWait, undefined);
    assert.equal(h.replies.length, 0);
  } finally {
    h.close();
  }
});

test("the same invalid handoff after targeted repair stops with a concrete internal diagnostic", async () => {
  const h = await harness();
  try {
    await h.finish("opening-2", true);
    await h.worker.tick();
    await h.finish("opening-2", true);
    await h.worker.tick();
    assert.equal(h.state().nodes["opening-2"]?.repair?.repeated, 2);
    const failed = h.events().find((event) => event.error?.code === "workflow_receipt_no_progress");
    assert.equal(failed?.state, "attention");
    assert.match(h.replies[0] ?? "", /交接回执连续出现相同错误/);
    assert.match(h.replies[0] ?? "", /无需补交业务需求/);
    const sends = h.herdr.sends.length;
    const calls = h.calls.length;
    for (let i = 0; i < 3; i++) await new TaskOrchestrator(h.options).tick();
    assert.equal(h.herdr.sends.length, sends);
    assert.equal(h.calls.length, calls);
    assert.equal(h.replies.length, 1);
  } finally {
    h.close();
  }
});

test("an old blocked receipt and assistance wait are recovered after upgrade without accepting the old output", async () => {
  const h = await harness();
  try {
    await h.finish("opening-2", true);
    const s = h.state();
    const progress = s.nodes["opening-2"];
    assert.ok(progress?.operationId && progress.participantId);
    const originalOperation = progress.operationId;
    const output = h.store
      .list<SettledTaskOutput>("task_settled_outputs")
      .find((entry) => entry.participantId === progress.participantId);
    assert.ok(output);
    // This is the persisted shape produced by v0.3.22 after rejecting a receipt.
    progress.status = "blocked";
    progress.outputId = output.entry.id;
    progress.error = "参与者交接缺少本轮材料位置，不能将无归属输出视为完成。";
    s.consumedOutputs.push(output.entry.id);
    s.assistanceWait = {
      eventId: "old-deferred",
      fingerprint: "old-policy",
      reason: "等待新的判断依据",
    };
    h.store.set(WORKFLOWS, h.task.id, s);
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.state().nodes["opening-2"]?.status, "dispatched");
    assert.notEqual(h.state().nodes["opening-2"]?.operationId, originalOperation);
    assert.equal(h.store.get("workflow_status_blocks", output.entry.id), undefined);
    assert.ok(h.state().consumedOutputs.includes(output.entry.id));
    assert.equal(h.state().assistanceWait, undefined);
  } finally {
    h.close();
  }
});

async function rejectedCrossReview(h: Awaited<ReturnType<typeof harness>>) {
  await h.finish("opening-2");
  await h.worker.tick();
  const progress = h.state().nodes["cross-review"];
  assert.ok(progress?.operationId && progress.participantId);
  const event = h
    .events()
    .find((entry) =>
      entry.dispatches.some((dispatch) => dispatch.operationId === progress.operationId),
    );
  assert.ok(event);
  await h.finish("cross-review", true);
  await settleWorkflow(
    {
      ...h.options,
      events: () => h.events(),
      outputs: () => h.store.list<SettledTaskOutput>("task_settled_outputs"),
      revision: () => event.userRevision,
    } as unknown as WorkflowPorts,
    h.task,
    h.state(),
    h.service.records.participants(h.task),
    [],
  );
  const rejected = h.state().nodes["cross-review"];
  assert.equal(rejected?.status, "blocked");
  assert.ok(rejected?.repair?.recoverable);
  return { progress: rejected, event };
}

for (const reassigned of [false, true]) {
  test(`ordinary rework at the same revision ${reassigned ? "changes" : "retains"} the participant without inheriting receipt-only work`, async () => {
    const h = await harness();
    try {
      const rejected = await rejectedCrossReview(h);
      const participants = h.service.records.participants(h.task);
      const target = participants.find(
        (participant) => (participant.id !== rejected.progress.participantId) === reassigned,
      );
      assert.ok(target);
      const state = h.state();
      const artifactRevision = await workspaceRevision(h.task.directories);
      const candidate = workflowCandidates(h.task, state, participants, [], false).find(
        (entry) =>
          entry.kind === "rework" &&
          entry.assignments?.[0]?.nodeId === "cross-review" &&
          entry.assignments[0].participantId === target.id,
      );
      assert.ok(candidate);
      const event: OrchestrationEvent = {
        ...rejected.event,
        id: `ordinary-rework-${target.id}`,
        state: "pending",
        attempts: 0,
        dispatches: [],
        decision: { action: "continue", source: "pi", reason: "按当前材料重新进行实质评审" },
        workflow: { candidate, planVersion: state.plan.version, artifactRevision },
      };
      h.store.set("task_orchestration_events", event.id, event);
      await new TaskOrchestrator(h.options).tick();
      const dispatched = h.state().nodes["cross-review"];
      assert.ok(dispatched?.operationId);
      assert.equal(dispatched.status, "dispatched");
      assert.equal(dispatched.participantId, target.id);
      assert.equal(dispatched.repair, undefined);
      assert.equal(dispatched.artifactRevision, artifactRevision);
      const directory = handoffDirectory(h.config.stateDir, h.task.id, dispatched.operationId);
      assert.doesNotMatch(
        readFileSync(join(directory, "brief.md"), "utf8"),
        /本次仅修复交接与回执|prior-notes/,
      );
      assert.equal(existsSync(join(directory, "prior-notes.md")), false);
      await h.finish("cross-review", true);
      await new TaskOrchestrator(h.options).tick();
      const next = h.state().nodes["cross-review"];
      assert.equal(next?.repair?.repeated, 1, "a new business review begins a new repair streak");
      assert.equal(next?.participantId, target.id);
      assert.equal(
        next?.status,
        "dispatched",
        "the new rejected output can be repaired by its own author",
      );
      assert.equal(h.replies.length, 0);
    } finally {
      h.close();
    }
  });
}

test("legacy inherited repair cannot select another participant as the original receipt author", async () => {
  const h = await harness();
  try {
    const { progress, event } = await rejectedCrossReview(h);
    const state = h.state();
    const other = h.service.records
      .participants(h.task)
      .find((participant) => participant.id !== progress.participantId);
    assert.ok(other);
    const node = state.nodes["cross-review"];
    assert.ok(node);
    node.participantId = other.id;
    const candidates = workflowCandidates(
      h.task,
      state,
      h.service.records.participants(h.task),
      [],
      false,
    );
    assert.equal(
      receiptRepairRule(
        h.store,
        state,
        candidates,
        event.userRevision,
        await workspaceRevision(h.task.directories),
      ),
      undefined,
    );
  } finally {
    h.close();
  }
});

test("a rule-selected receipt repair survives an unexecuted send and restart without losing its original author", async () => {
  const h = await harness();
  try {
    await h.finish("opening-2", true);
    const send = h.service.send.bind(h.service);
    h.service.send = async () => {
      throw new OperationError("fixture_send_failed", "crashed before entering task send");
    };
    await h.worker.tick();
    const failed = h.state().nodes["opening-2"];
    assert.ok(failed?.repair && failed.operationId);
    const original = failed.repair;
    h.service.send = send;
    await new TaskOrchestrator(h.options).tick();
    const retried = h.state().nodes["opening-2"];
    assert.equal(retried?.operationId, failed.operationId);
    assert.equal(retried?.repair?.snapshotId, original.snapshotId);
    assert.equal(retried?.repair?.repeated, 1);
    const event = h
      .events()
      .find((entry) =>
        entry.dispatches.some((dispatch) => dispatch.operationId === failed.operationId),
      );
    assert.equal(event?.dispatches[0]?.state, "sent");
    const directory = handoffDirectory(h.config.stateDir, h.task.id, failed.operationId);
    assert.ok(existsSync(join(directory, "prior-notes.md")));
    await h.finish("opening-2");
    await h.worker.tick();
    assert.equal(h.state().nodes["opening-2"]?.status, "completed");
  } finally {
    h.close();
  }
});
