import assert from "node:assert/strict";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { Task, TaskKind } from "../../src/core/types.js";
import type { WorkflowCandidate } from "../../src/orchestration/candidates.js";
import {
  WORKFLOWS,
  type WorkflowPlan,
  type WorkflowState,
} from "../../src/orchestration/workflow.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function harness(
  stallRounds = 3,
  settings: {
    kind?: TaskKind;
    requirements?: string;
    verify?: string[];
    validation?: WorkflowPlan["validation"];
    requiredArtifacts?: string[];
  } = {},
) {
  const h = setup();
  h.config.ai.enabled = true;
  assert.ok(h.config.jev);
  h.config.jev.stallRounds = stallRounds;
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "source.txt"), "immutable source");
  await h.catalog.save({
    name: "recovery",
    directories: [repo],
    agent: "codex",
    ...(settings.verify ? { verify: settings.verify } : {}),
  });
  const engine = new Engine();
  const selection = {
    choose: (candidates: WorkflowCandidate[]) =>
      candidates.find((entry) => entry.kind === "deliver") ?? candidates[0],
  };
  let plans = 0;
  engine.handler = async (input) => {
    const tool = input.tools[0];
    assert.ok(tool);
    if (tool.name === "orchestration_plan") {
      plans++;
      await tool.execute(
        {
          template: settings.kind === "development" ? "development" : "discussion",
          instructions: {
            [settings.kind === "development" ? "review" : "cross-review"]:
              `第 ${plans} 版独立核对任务书。`,
          },
          deliveryRequirements: [`第 ${plans} 版补充验收项`],
          ...(settings.validation ? { validation: settings.validation } : {}),
          ...(settings.requiredArtifacts ? { requiredArtifacts: settings.requiredArtifacts } : {}),
        },
        input.actor,
      );
    } else {
      assert.equal(tool.name, "orchestration_decide");
      const candidates = JSON.parse(input.prompt).candidates as WorkflowCandidate[];
      const selected = selection.choose(candidates);
      assert.ok(selected);
      await tool.execute(
        { candidateId: selected.id, reason: "按恢复测试合法候选推进。" },
        input.actor,
      );
    }
    return { text: "", messages: [] };
  };
  const task = await h.service.create(actor, {
    ...discussion,
    kind: settings.kind ?? discussion.kind,
    requirements: settings.requirements ?? discussion.requirements,
    project: "recovery",
    orchestration: { mode: "workflow" },
  });
  await h.service.reconcile(task.id);
  const controller = new AbortController();
  const replies: Array<{ text: string; eventId: string }> = [];
  const options = {
    store: h.store,
    engine,
    tasks: () => h.service,
    tools: () => [],
    signal: controller.signal,
    logger,
    config: h.config,
    projects: h.catalog,
    retryDelayMs: 0,
    onReply: async (_task: Task, text: string, eventId: string) => {
      replies.push({ text, eventId });
    },
  };
  const worker = new TaskOrchestrator(options);
  const state = () => {
    const current = h.store.get<WorkflowState>(WORKFLOWS, task.id);
    assert.ok(current);
    return current;
  };
  const emit = (nodeId: string, overrides: Record<string, unknown> = {}, raw?: string) => {
    const current = state();
    const progress = current.nodes[nodeId];
    assert.ok(progress?.operationId && progress.participantId && progress.inputRevision, nodeId);
    const participant = h.service.records
      .participants(task)
      .find((entry) => entry.id === progress.participantId);
    assert.ok(participant?.execution);
    const block = {
      protocolVersion: 1,
      nodeId,
      operationId: progress.operationId,
      inputRevision: progress.inputRevision,
      status: "completed",
      summary: `${nodeId} 的真实结果`,
      issues: [],
      evidence: [],
      artifactRefs: [],
      blockers: [],
      ...(nodeId === "report"
        ? {
            reportSections: Object.fromEntries(
              current.plan.deliveryRequirements.map((section) => [
                section,
                `${section}：依据完整参与者输出形成结论。`,
              ]),
            ),
          }
        : {}),
      ...overrides,
    };
    h.herdr.finish(
      participant.execution.paneId,
      raw ?? `参与者正文。\n\n\`\`\`myrix-status\n${JSON.stringify(block)}\n\`\`\``,
    );
  };
  const finish = async (nodeId: string, overrides: Record<string, unknown> = {}, raw?: string) => {
    emit(nodeId, overrides, raw);
    await h.service.reconcile(task.id);
  };
  const events = () =>
    h.store
      .list<OrchestrationEvent>("task_orchestration_events")
      .filter((event) => event.taskId === task.id);
  return {
    ...h,
    repo,
    task,
    engine,
    worker,
    controller,
    options,
    replies,
    selection,
    state,
    emit,
    finish,
    events,
  };
}

const openIssue = {
  id: "design-choice",
  description: "两个方案的权衡仍待裁决",
  status: "open",
  blocking: false,
  evidenceRefs: [],
};

test("persisting a rework dispatch atomically invalidates the old report before native input and survives restart", async () => {
  const h = await harness();
  const originalSet = h.store.set.bind(h.store);
  try {
    await h.worker.tick();
    await h.worker.tick();
    await h.finish("opening-1");
    await h.finish("opening-2");
    await h.worker.tick();
    await h.finish("cross-review");
    await h.worker.tick();
    await h.finish("report", { issues: [openIssue] });
    let oldReportId: string | undefined;
    h.selection.choose = (candidates) => {
      oldReportId = h.state().report?.id;
      return candidates.find((candidate) => candidate.kind === "rework") ?? candidates[0];
    };
    let crash: { event: OrchestrationEvent; state: WorkflowState } | undefined;
    // Stop exactly after the durable dispatch commit, before tasks.send can cross its effect boundary.
    h.store.set = (namespace, key, value) => {
      originalSet(namespace, key, value);
      if (namespace !== "task_orchestration_events" || crash) return;
      const event = value as OrchestrationEvent;
      if (event.workflow?.candidate.kind !== "rework" || !event.dispatches.length) return;
      crash = { event: structuredClone(event), state: h.state() };
      h.controller.abort();
    };
    const sentBefore = h.herdr.sends.length;
    await h.worker.tick();
    h.store.set = originalSet;
    assert.ok(crash);
    assert.ok(oldReportId);
    assert.equal(h.herdr.sends.length, sentBefore);
    assert.equal(
      crash.state.report,
      undefined,
      "old report must already be invalid at the dispatch commit boundary",
    );
    assert.equal(crash.state.nodes.report?.status, "pending");
    assert.equal(crash.state.nodes["cross-review"]?.status, "pending");
    // A process exit does not persist the graceful cancellation handler's later mutations.
    originalSet("task_orchestration_events", crash.event.id, crash.event);
    originalSet(WORKFLOWS, h.task.id, crash.state);
    const restarted = new TaskOrchestrator({ ...h.options, signal: new AbortController().signal });
    await restarted.tick();
    assert.equal(
      h.herdr.sends.length,
      sentBefore + 1,
      "only the saved unfinished dispatch is sent",
    );
    await h.finish("cross-review", { issues: [{ ...openIssue, status: "resolved" }] });
    await restarted.tick();
    assert.equal(h.state().report, undefined);
    assert.equal(
      h.state().nodes.report?.status,
      "dispatched",
      "the report must be regenerated even without changing source bytes",
    );
    assert.equal(
      h.events().some((event) => event.decision?.action === "deliver"),
      false,
    );
  } finally {
    h.store.set = originalSet;
    h.controller.abort();
    h.close();
  }
});

test("late foreign output cannot hide the current valid reply or consume another stall round", async () => {
  const h = await harness();
  try {
    await h.worker.tick();
    await h.worker.tick();
    h.emit("opening-1", { issues: [openIssue], summary: "当前委派有效回复" });
    h.emit("opening-1", { operationId: "previous-operation", summary: "迟到旧回复" });
    await h.service.reconcile(h.task.id);
    await h.worker.tick();
    assert.equal(h.state().nodes["opening-1"]?.status, "completed");
    assert.equal(h.state().nodes["opening-1"]?.summary, "当前委派有效回复");
    assert.equal(h.state().batches.length, 0, "partial parallel batches are not completed rounds");
    await h.finish("opening-2");
    await h.worker.tick();
    assert.equal(h.state().batches.length, 1);
    assert.equal(h.state().stall.unchanged, 0);
    assert.equal(
      h.state().consumedOutputs.length,
      2,
      "foreign reply stays durable but is not merged",
    );
    assert.equal(h.store.list("task_settled_outputs").length, 3);
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.state().batches.length, 1);
  } finally {
    h.controller.abort();
    h.close();
  }
});

test("malformed status only requests correction and does not count an effective batch", async () => {
  const h = await harness(1);
  try {
    await h.worker.tick();
    await h.worker.tick();
    await h.finish("opening-1", { issues: [openIssue] });
    await h.finish("opening-2");
    await h.worker.tick();
    const before = h.state();
    await h.finish("cross-review", {}, "尚未提供协议\n```myrix-status\n{invalid}\n```");
    await h.worker.tick();
    assert.equal(
      h.state().nodes["cross-review"]?.status,
      "dispatched",
      "request a corrected status through ordinary rework",
    );
    assert.deepEqual(h.state().batches, before.batches);
    assert.equal(h.state().stall.unchanged, before.stall.unchanged);
    assert.equal(h.state().stall.awaitingUser, false);
    assert.equal(
      h.events().some((event) => event.decision?.action === "deliver"),
      false,
    );
  } finally {
    h.controller.abort();
    h.close();
  }
});

test("replanning freezes a new version and retains the original task instructions and contract", async () => {
  const h = await harness();
  try {
    await h.worker.tick();
    const first = h.store.get<{ plan: WorkflowPlan; reason: string; userRevision: string }>(
      "workflow_plans",
      `${h.task.id}:1`,
    );
    assert.ok(first);
    await h.service.action({ ...actor, messageId: "pause-for-replan" }, h.task.id, "pause");
    await h.service.action({ ...actor, messageId: "resume-for-replan" }, h.task.id, "resume");
    await h.worker.tick();
    const second = h.store.get<{ plan: WorkflowPlan; reason: string; userRevision: string }>(
      "workflow_plans",
      `${h.task.id}:2`,
    );
    assert.ok(second);
    assert.deepEqual(h.store.get("workflow_plans", `${h.task.id}:1`), first);
    assert.notEqual(second.userRevision, first.userRevision);
    assert.notEqual(
      second.plan.nodes.find((node) => node.id === "cross-review")?.instruction,
      first.plan.nodes.find((node) => node.id === "cross-review")?.instruction,
    );
    assert.deepEqual(first.plan.deliveryRequirements.at(-1), "第 1 版补充验收项");
    assert.deepEqual(second.plan.deliveryRequirements.at(-1), "第 2 版补充验收项");
    assert.ok(second.reason.trim());
    assert.equal(h.herdr.sends.length, 0, "planning itself does not dispatch participants");
  } finally {
    h.controller.abort();
    h.close();
  }
});

test("unchanged open issues request user arbitration once instead of delivering or closing", async () => {
  const h = await harness(2);
  try {
    await h.worker.tick();
    await h.worker.tick();
    await h.finish("opening-1", { issues: [openIssue] });
    await h.finish("opening-2");
    await h.worker.tick();
    await h.finish("cross-review", { issues: [openIssue] });
    await h.worker.tick();
    await h.finish("report", { issues: [openIssue] });
    await h.worker.tick();
    assert.equal(h.state().stall.awaitingUser, true);
    assert.equal(h.state().stall.unchanged, 2);
    assert.equal(h.events().filter((event) => event.decision?.action === "wait").length, 1);
    assert.equal(
      h.events().some((event) => event.decision?.action === "deliver"),
      false,
    );
    assert.equal(h.replies.length, 1);
    assert.match(h.replies[0]?.text ?? "", /用户裁决/);
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.replies.length, 1);
    assert.equal(h.state().stall.unchanged, 2);
    assert.equal(h.herdr.closes, 0);
    assert.notEqual(h.service.records.get(actor, h.task.id).status, "completed");
  } finally {
    h.controller.abort();
    h.close();
  }
});

test("an explicit user prohibition skips configured commands, retains independent review and delivers an honest not-run report", async () => {
  const h = await harness(3, {
    kind: "development",
    requirements: "修改文案；不要运行测试或验证命令，只做独立只读复核。",
    verify: ["node -e \"require('node:fs').writeFileSync('SHOULD_NOT_RUN', 'started')\""],
    validation: {
      mode: "not_run",
      reason: "用户要求此次仅作独立只读复核。",
      userConstraint: "不要运行测试或验证命令",
    },
  });
  try {
    await h.worker.tick();
    assert.equal(h.state().plan.validation?.mode, "not_run");
    assert.equal(h.state().plan.nodes.find((node) => node.id === "validate")?.access, "read");
    await h.worker.tick();
    await h.finish("analysis");
    await h.worker.tick();
    assert.doesNotMatch(h.herdr.sends.at(-1)?.text ?? "", /仅作只读复核，验证证据/);
    await h.finish("implement");
    await h.worker.tick();
    const current = h.state();
    assert.equal(current.nodes.validate?.status, "dispatched");
    assert.notEqual(current.nodes.validate?.participantId, current.nodes.implement?.participantId);
    assert.match(h.herdr.sends.at(-1)?.text ?? "", /不得执行验证命令/);
    await h.finish("validate", {
      evidence: [{ description: "按用户要求未运行；已独立阅读变更。", result: "not_run" }],
    });
    await h.worker.tick();
    await h.finish("review");
    await h.worker.tick();
    await h.finish("report");
    await h.worker.tick();
    assert.equal(existsSync(join(h.repo, "SHOULD_NOT_RUN")), false);
    assert.equal(h.store.list("verification_runs").length, 0);
    assert.equal(
      h.events().some((event) => event.workflow?.candidate.kind === "verify"),
      false,
    );
    assert.equal(
      h.state().evidence.some((entry) => entry.source === "configured_command"),
      false,
    );
    assert.equal(
      h.state().evidence.some((entry) => entry.result === "passed"),
      false,
    );
    assert.equal(h.replies.length, 1);
    assert.match(h.replies[0]?.text ?? "", /验证未运行/);
    assert.match(h.replies[0]?.text ?? "", /不要运行测试或验证命令/);
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.replies.length, 1);
    assert.equal(h.state().phase, "awaiting_acceptance");
  } finally {
    h.controller.abort();
    h.close();
  }
});

for (const change of ["deleted", "modified"])
  test(`a required artifact ${change} after selection cannot be delivered using its saved hash`, async () => {
    const requiredArtifacts: string[] = [];
    const h = await harness(3, { requiredArtifacts });
    try {
      assert.ok(h.task.boardDirectory);
      const artifact = join(h.task.boardDirectory, "recommendation.md");
      requiredArtifacts.push(artifact);
      writeFileSync(artifact, "已独立核对的方案。\n");
      await h.worker.tick();
      await h.worker.tick();
      await h.finish("opening-1", { artifactRefs: [artifact], issues: [openIssue] });
      await h.finish("opening-2");
      await h.worker.tick();
      await h.finish("cross-review");
      await h.worker.tick();
      assert.match(h.herdr.sends.at(-1)?.text ?? "", /必需交付文件/);
      await h.finish("report");
      let changed = false;
      h.selection.choose = (candidates) => {
        const candidate = candidates.find((entry) => entry.kind === "deliver");
        assert.ok(candidate, "declared current artifact initially satisfies the contract");
        // This task-owned output is outside source cwd: only artifact revalidation can catch it.
        if (change === "deleted") unlinkSync(artifact);
        else writeFileSync(artifact, "核对后被替换的内容。\n");
        changed = true;
        return candidate;
      };
      await h.worker.tick();
      assert.equal(changed, true);
      const delivery = h.events().find((event) => event.decision?.action === "deliver");
      assert.ok(delivery?.error);
      assert.equal(
        h.replies.some((reply) => reply.eventId === delivery.id),
        false,
      );
      assert.equal(Boolean(delivery.workflow?.applied), false);
      assert.notEqual(delivery.state, "done");
      await new TaskOrchestrator(h.options).tick();
      assert.equal(
        h.replies.some((reply) => reply.eventId === delivery.id),
        false,
      );
      assert.notEqual(h.state().phase, "awaiting_acceptance");
      assert.notEqual(h.service.records.get(actor, h.task.id).status, "completed");
    } finally {
      h.controller.abort();
      h.close();
    }
  });
