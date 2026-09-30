import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { Task } from "../../src/core/types.js";
import { implementationParticipants } from "../../src/orchestration/authorship.js";
import { type WorkflowCandidate, workflowCandidates } from "../../src/orchestration/candidates.js";
import { reportContract } from "../../src/orchestration/report.js";
import { invalidateFrom, mergeStatus, workflowState } from "../../src/orchestration/state.js";
import { templatePlan } from "../../src/orchestration/templates.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function harness(settings: { writableAnalysis?: boolean } = {}) {
  const h = setup();
  h.config.ai.enabled = true;
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "app.txt"), "initial source");
  await h.catalog.save({ name: "authors", directories: [repo], agent: "codex" });
  const task = await h.service.create(actor, {
    ...discussion,
    kind: "development",
    project: "authors",
    requirements: "实现改动，完成独立验证与评审。",
    orchestration: { mode: "workflow" },
  });
  // Exercise persisted v2 workflows; v3 integration has its own end-to-end suite.
  task.promptVersion = 2;
  h.service.records.save(task);
  await h.service.reconcile(task.id);
  const [first, second] = task.participantIds;
  assert.ok(first && second);
  const selection = { implementer: first };
  const plan = templatePlan(task);
  if (settings.writableAnalysis) {
    const analysis = plan.nodes.find((node) => node.id === "analysis");
    assert.ok(analysis);
    analysis.access = "write";
    analysis.instruction = "分析并写入复现代码，随后由另一位参与者实现。";
  }
  const engine = new Engine();
  engine.handler = async (input) => {
    if (
      input.tools[0]?.name === "orchestration_choice" &&
      JSON.parse(input.prompt).candidates.some(
        (candidate: { id: string }) => candidate.id === "use_template",
      )
    ) {
      await input.tools[0].execute({ candidateId: "request_pi" }, input.actor);
      return { text: "", messages: [] };
    }
    const tool = input.tools[0];
    assert.ok(tool);
    if (tool.name === "orchestration_plan")
      await tool.execute(
        {
          template: "development",
          instructions: {},
          deliveryRequirements: [],
          ...(settings.writableAnalysis ? { nodes: plan.nodes } : {}),
        },
        input.actor,
      );
    else {
      const candidates = JSON.parse(input.prompt).candidates as WorkflowCandidate[];
      const selected =
        candidates.find((candidate) => candidate.kind === "deliver") ??
        candidates.find(
          (candidate) =>
            candidate.kind === "rework" && candidate.assignments?.[0]?.participantId === second,
        ) ??
        candidates.find(
          (candidate) =>
            candidate.assignments?.[0]?.nodeId === "implement" &&
            candidate.assignments[0].participantId === selection.implementer,
        ) ??
        candidates[0];
      assert.ok(selected);
      await tool.execute({ candidateId: selected.id }, input.actor);
    }
    return { text: "", messages: [] };
  };
  const controller = new AbortController();
  const replies: string[] = [];
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
    onReply: async (_task: Task, text: string) => {
      replies.push(text);
    },
  };
  const worker = new TaskOrchestrator(options);
  const currentTask = () => h.service.records.get(actor, task.id);
  const state = () => {
    const current = h.store.get<WorkflowState>(WORKFLOWS, task.id);
    assert.ok(current);
    return current;
  };
  const finish = async (nodeId: string, override: Record<string, unknown> = {}, raw?: string) => {
    const current = state();
    const progress = current.nodes[nodeId];
    assert.ok(progress?.operationId && progress.participantId && progress.inputRevision);
    const participant = h.service.records
      .participants(currentTask())
      .find((entry) => entry.id === progress.participantId);
    assert.ok(participant?.execution);
    const block = {
      protocolVersion: 1,
      nodeId,
      operationId: progress.operationId,
      inputRevision: progress.inputRevision,
      status: "completed",
      summary: `${nodeId} 的实际工作结果`,
      issues: [],
      artifactRefs: [],
      evidence: [],
      blockers: [],
      ...(nodeId === "report"
        ? {
            reportSections: Object.fromEntries(
              current.plan.deliveryRequirements.map((section) => [section, `${section} 的结论。`]),
            ),
          }
        : {}),
      ...override,
    };
    h.herdr.finish(
      participant.execution.paneId,
      raw ?? `工作结果\n\n\`\`\`myrix-status\n${JSON.stringify(block)}\n\`\`\``,
    );
    await h.service.reconcile(task.id);
  };
  const reworkWithSecondAuthor = async () => {
    await worker.tick();
    await worker.tick();
    await finish("analysis");
    await worker.tick();
    assert.equal(state().nodes.implement?.participantId, first);
    writeFileSync(join(repo, "app.txt"), "initial implementation by A");
    await finish("implement", { status: "needs_work", blockers: ["需要另一位实现者补充修复。"] });
    await worker.tick();
    assert.equal(state().nodes.implement?.participantId, second);
    writeFileSync(join(repo, "app.txt"), "initial implementation by A with B's fixes");
    await finish("implement");
    await worker.tick();
  };
  return {
    ...h,
    repo,
    task,
    first,
    second,
    selection,
    controller,
    options,
    worker,
    replies,
    currentTask,
    state,
    finish,
    reworkWithSecondAuthor,
  };
}

test("rework, restart and a new plan retain both authors and require a third independent reviewer", async () => {
  const h = await harness();
  try {
    await h.reworkWithSecondAuthor();
    assert.deepEqual([...implementationParticipants(h.state())].sort(), [h.first, h.second].sort());
    const third = h.currentTask().participantIds.find((id) => id !== h.first && id !== h.second);
    assert.ok(third, "both existing participants implemented, so the workflow needs a third");
    assert.equal(h.state().nodes.validate?.status, "pending");
    await h.service.reconcile(h.task.id);
    const candidates = workflowCandidates(
      h.currentTask(),
      h.state(),
      h.service.records.participants(h.currentTask()),
      [],
      false,
    );
    assert.deepEqual(
      candidates
        .flatMap((candidate) => candidate.assignments ?? [])
        .map((item) => item.participantId),
      [third],
    );
    const invalidated = h.state();
    invalidateFrom(invalidated, "implement");
    assert.deepEqual(
      [...implementationParticipants(invalidated)].sort(),
      [h.first, h.second].sort(),
    );

    // The new version has only B as its current implementer; A must remain an author.
    await h.service.action({ ...actor, messageId: "replan-authors" }, h.task.id, "resume");
    const restarted = new TaskOrchestrator(h.options);
    h.selection.implementer = h.second;
    await restarted.tick();
    assert.equal(h.state().plan.version, 2);
    assert.deepEqual([...implementationParticipants(h.state())].sort(), [h.first, h.second].sort());
    await restarted.tick();
    await h.finish("analysis");
    await restarted.tick();
    assert.equal(h.state().nodes.implement?.participantId, h.second);
    await h.finish("implement");
    await restarted.tick();
    assert.equal(h.state().nodes.validate?.participantId, third);
    await h.finish("validate", {
      evidence: [{ command: "node regression.test", result: "passed", description: "第三人复核" }],
    });
    await restarted.tick();
    assert.equal(h.state().nodes.review?.participantId, third);
    await h.finish("review");
    await restarted.tick();
    await h.finish("report");
    await restarted.tick();
    assert.equal(h.replies.length, 1);
    assert.equal(
      h.state().evidence.find((item) => item.source === "agent_review")?.participantId,
      third,
    );
    assert.deepEqual(reportContract(h.state(), await workspaceRevision([h.repo]), []), []);
  } finally {
    h.controller.abort();
    h.close();
  }
});

test("a former author's forced reviewer receipt stays self-report and cannot satisfy delivery", async () => {
  const h = await harness();
  try {
    await h.reworkWithSecondAuthor();
    const state = h.state();
    const validation = state.plan.nodes.find((node) => node.id === "validate");
    assert.ok(validation);
    const revision = await workspaceRevision([h.repo]);
    state.nodes.validate = {
      status: "dispatched",
      attempt: 1,
      participantId: h.first,
      operationId: "legacy-author-review",
      inputRevision: "legacy-revision",
      artifactRevision: revision,
    };
    mergeStatus(
      state,
      validation,
      {
        protocolVersion: 1,
        nodeId: "validate",
        operationId: "legacy-author-review",
        inputRevision: "legacy-revision",
        status: "completed",
        summary: "此前实现者自行宣称验证通过。",
        issues: [],
        artifactRefs: [],
        blockers: [],
        evidence: [{ command: "node self-check", result: "passed", description: "作者自检" }],
      },
      "legacy-author-output",
      revision,
    );
    assert.equal(state.nodes.validate.status, "blocked");
    assert.equal(state.evidence.at(-1)?.source, "self_report");
    assert.ok(reportContract(state, revision, []).some((reason) => reason.includes("独立")));

    // Even old persisted evidence that was mislabelled by an earlier version is insufficient.
    const evidence = state.evidence.at(-1);
    assert.ok(evidence);
    evidence.source = "agent_review";
    for (const progress of Object.values(state.nodes)) {
      progress.status = "completed";
      progress.artifactRevision = revision;
    }
    state.report = {
      id: "legacy-report",
      outputId: "legacy-report-output",
      path: "/not-read-by-report-contract",
      hash: "legacy-hash",
      artifactRevision: revision,
    };
    assert.ok(reportContract(state, revision, []).some((reason) => reason.includes("独立")));
  } finally {
    h.controller.abort();
    h.close();
  }
});

test("legacy state restores authors from prior dispatches and downgrades their obsolete review proof", async () => {
  const h = await harness();
  try {
    await h.reworkWithSecondAuthor();
    const legacy = h.state();
    const revision = await workspaceRevision([h.repo]);
    delete legacy.implementationParticipants;
    invalidateFrom(legacy, "implement");
    legacy.plan.version++;
    for (const node of legacy.plan.nodes) {
      if (node.id === "implement") node.id = "implementation-next";
      node.dependsOn = node.dependsOn.map((id) =>
        id === "implement" ? "implementation-next" : id,
      );
    }
    assert.ok(legacy.nodes.implement);
    legacy.nodes["implementation-next"] = legacy.nodes.implement;
    delete legacy.nodes.implement;
    legacy.evidence.push({
      id: "legacy-misclassified-evidence",
      source: "agent_review",
      description: "旧版本把原实现者误当独立评审。",
      participantId: h.first,
      artifactRevision: revision,
      command: "node old-check",
      result: "passed",
    });
    legacy.report = {
      id: "legacy-report",
      outputId: "legacy-report-output",
      path: "/not-read-during-migration",
      hash: "old-hash",
      artifactRevision: revision,
    };
    h.store.set(WORKFLOWS, h.task.id, legacy);
    const restored = workflowState(h.store, h.currentTask(), legacy.userRevision);
    assert.deepEqual([...implementationParticipants(restored)].sort(), [h.first, h.second].sort());
    assert.equal(restored.evidence.at(-1)?.source, "self_report");
    assert.equal(restored.report, undefined);
    const reread = h.store.get<WorkflowState>(WORKFLOWS, h.task.id);
    assert.ok(reread);
    assert.deepEqual([...implementationParticipants(reread)].sort(), [h.first, h.second].sort());
    assert.equal(reread.evidence.at(-1)?.source, "self_report");
    assert.ok(
      h.store
        .list<OrchestrationEvent>("task_orchestration_events")
        .filter((event) => event.taskId === h.task.id)
        .flatMap((event) => event.dispatches)
        .some((dispatch) => dispatch.nodeId === "implement" && dispatch.participantId === h.first),
      "the original author remains recoverable after node progress is invalidated",
    );
  } finally {
    h.controller.abort();
    h.close();
  }
});

test("restart refuses an already-selected reviewer who previously implemented the task", async () => {
  const h = await harness();
  const save = h.store.set.bind(h.store);
  const recovery = new AbortController();
  try {
    await h.reworkWithSecondAuthor();
    await h.service.reconcile(h.task.id);
    let selected: OrchestrationEvent | undefined;
    h.store.set = (namespace, key, value) => {
      save(namespace, key, value);
      if (namespace !== "task_orchestration_events" || selected) return;
      const event = value as OrchestrationEvent;
      if (
        event.workflow?.candidate.kind !== "dispatch" ||
        event.workflow.candidate.assignments?.[0]?.nodeId !== "validate" ||
        event.dispatches.length
      )
        return;
      selected = structuredClone(event);
      h.controller.abort();
    };
    const sends = h.herdr.sends.length;
    await h.worker.tick();
    h.store.set = save;
    assert.ok(selected?.workflow?.candidate.assignments?.[0]);
    assert.equal(h.herdr.sends.length, sends);
    selected.workflow.candidate.assignments[0].participantId = h.first;
    selected.workflow.candidate.id = `dispatch:validate:${h.first}`;
    assert.ok(selected.decision);
    selected.decision.candidateId = selected.workflow.candidate.id;
    save("task_orchestration_events", selected.id, selected);

    const restarted = new TaskOrchestrator({ ...h.options, signal: recovery.signal });
    for (let attempt = 0; attempt < 3; attempt++) await restarted.tick();
    assert.equal(h.herdr.sends.length, sends, "the stale selection cannot bypass author checks");
    const refused = h.store.get<OrchestrationEvent>("task_orchestration_events", selected.id);
    assert.equal(refused?.error?.code, "workflow_review_author");
    assert.equal(refused?.state, "attention");
    assert.notEqual(h.state().nodes.validate?.participantId, h.first);
  } finally {
    h.store.set = save;
    h.controller.abort();
    recovery.abort();
    h.close();
  }
});

test("restoring obsolete author review proof retires an unsent delivery into attention once", async () => {
  const h = await harness();
  const save = h.store.set.bind(h.store);
  const recovery = new AbortController();
  try {
    await h.reworkWithSecondAuthor();
    await h.service.reconcile(h.task.id);
    await h.worker.tick();
    await h.finish("validate", {
      evidence: [{ command: "node regression.test", result: "passed", description: "旧核验记录" }],
    });
    await h.worker.tick();
    await h.finish("review");
    await h.worker.tick();
    await h.finish("report");
    let delivery: OrchestrationEvent | undefined;
    h.store.set = (namespace, key, value) => {
      save(namespace, key, value);
      if (namespace !== "task_orchestration_events" || delivery) return;
      const event = value as OrchestrationEvent;
      if (event.decision?.action !== "deliver" || event.state !== "done" || event.notified) return;
      delivery = structuredClone(event);
      h.controller.abort();
    };
    await h.worker.tick();
    h.store.set = save;
    assert.ok(delivery);
    assert.equal(h.replies.length, 0, "the delivery was persisted before any notification");
    const legacy = h.state();
    assert.ok(legacy.report);
    const reportText = readFileSync(legacy.report.path, "utf8");
    delete legacy.implementationParticipants;
    const oldProof = legacy.evidence.find((item) => item.source === "agent_review");
    assert.ok(oldProof && legacy.nodes.validate);
    oldProof.participantId = h.first;
    legacy.nodes.validate.participantId = h.first;
    save(WORKFLOWS, h.task.id, legacy);
    save("task_orchestration_events", delivery.id, delivery);

    const errors: string[] = [];
    const restarted = new TaskOrchestrator({
      ...h.options,
      signal: recovery.signal,
      logger: { ...logger, error: (message: string) => errors.push(message) },
    });
    await restarted.tick();
    const retired = h.store.get<OrchestrationEvent>("task_orchestration_events", delivery.id);
    assert.equal(retired?.state, "attention");
    assert.equal(retired?.error?.code, "workflow_report");
    assert.equal(h.service.get(actor, h.task.id).status, "attention");
    assert.equal(h.state().report, undefined);
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0], retired.error.message, "only the attention notice may be sent");
    assert.notEqual(h.replies[0], reportText);
    for (let poll = 0; poll < 3; poll++) await restarted.tick();
    assert.equal(h.replies.length, 1, "neither the stale report nor another notice is replayed");
    assert.deepEqual(errors, [], "recovery must not repeatedly throw while replaying delivery");
  } finally {
    h.store.set = save;
    h.controller.abort();
    recovery.abort();
    h.close();
  }
});

test("a custom writable analyst is an author during dispatch and after historical plan recovery", async () => {
  const h = await harness({ writableAnalysis: true });
  try {
    h.selection.implementer = h.second;
    await h.worker.tick();
    await h.worker.tick();
    const analysis = h.state().plan.nodes.find((node) => node.id === "analysis");
    assert.equal(analysis?.role, "analyst");
    assert.equal(analysis?.phase, "planning");
    assert.equal(analysis?.access, "write");
    assert.equal(h.state().nodes.analysis?.participantId, h.first);
    assert.ok(
      implementationParticipants(h.state()).has(h.first),
      "authorization to write counts before a possibly incomplete status receipt",
    );
    writeFileSync(join(h.repo, "app.txt"), "reproduction code written by analyst A");
    await h.finish("analysis");
    await h.worker.tick();
    assert.equal(h.state().nodes.implement?.participantId, h.second);
    writeFileSync(join(h.repo, "app.txt"), "analyst A's reproduction with B's implementation");
    await h.finish("implement");
    await h.worker.tick();
    assert.deepEqual([...implementationParticipants(h.state())].sort(), [h.first, h.second].sort());
    const third = h.currentTask().participantIds.find((id) => id !== h.first && id !== h.second);
    assert.ok(third, "a different role label cannot make either writer an independent reviewer");
    await h.service.reconcile(h.task.id);
    const candidates = workflowCandidates(
      h.currentTask(),
      h.state(),
      h.service.records.participants(h.currentTask()),
      [],
      false,
    );
    assert.deepEqual(
      candidates
        .flatMap((candidate) => candidate.assignments ?? [])
        .map((assignment) => assignment.participantId),
      [third],
    );

    const legacy = h.state();
    delete legacy.implementationParticipants;
    invalidateFrom(legacy, "analysis");
    legacy.plan.version++;
    for (const node of legacy.plan.nodes) {
      if (node.id === "analysis") node.id = "new-analysis";
      node.dependsOn = node.dependsOn.map((id) => (id === "analysis" ? "new-analysis" : id));
    }
    assert.ok(legacy.nodes.analysis);
    legacy.nodes["new-analysis"] = legacy.nodes.analysis;
    delete legacy.nodes.analysis;
    h.store.set(WORKFLOWS, h.task.id, legacy);
    const restored = workflowState(h.store, h.currentTask(), legacy.userRevision);
    assert.deepEqual(
      [...implementationParticipants(restored)].sort(),
      [h.first, h.second].sort(),
      "the archived analyst/write node must recover A even after its current identity is gone",
    );
  } finally {
    h.controller.abort();
    h.close();
  }
});

for (const receipt of ["completed", "malformed", "foreign", "resume", "legacy-blocked"] as const)
  test(`a reviewer who changes artifacts is remembered before its ${receipt} status is parsed`, async () => {
    const h = await harness();
    try {
      await h.worker.tick();
      await h.worker.tick();
      await h.finish("analysis");
      await h.worker.tick();
      writeFileSync(join(h.repo, "app.txt"), "implementation by A");
      await h.finish("implement");
      await h.worker.tick();
      assert.equal(h.state().nodes.validate?.participantId, h.second);
      assert.equal(implementationParticipants(h.state()).has(h.second), false);
      writeFileSync(join(h.repo, "app.txt"), "implementation by A rewritten by reviewer B");
      await h.finish(
        "validate",
        {
          evidence: [{ command: "node review", result: "passed", description: "reviewer-rewrite" }],
          ...(receipt === "foreign" ? { operationId: "foreign-previous-operation" } : {}),
        },
        receipt === "malformed" || receipt === "legacy-blocked"
          ? "没有合法状态块，但已修改仓库。"
          : undefined,
      );
      if (receipt === "resume")
        await h.service.action(
          { ...actor, messageId: "resume-before-settle" },
          h.task.id,
          "resume",
        );
      if (receipt === "legacy-blocked") {
        const legacy = h.state();
        assert.ok(legacy.nodes.validate);
        legacy.nodes.validate.status = "blocked";
        delete legacy.implementationParticipants;
        h.store.set(WORKFLOWS, h.task.id, legacy);
      }
      await h.worker.tick();
      assert.deepEqual(
        [...implementationParticipants(h.state())].sort(),
        [h.first, h.second].sort(),
      );
      assert.notEqual(h.state().nodes.validate?.status, "completed");
      assert.equal(
        h
          .state()
          .evidence.some(
            (item) => item.participantId === h.second && item.source === "agent_review",
          ),
        false,
      );
      if (receipt === "resume") assert.equal(h.state().plan.version, 2);
      const retryState = h.state();
      assert.ok(retryState.nodes.validate);
      retryState.nodes.validate.status = "blocked";
      const retryCandidates = workflowCandidates(
        h.currentTask(),
        retryState,
        h.service.records.participants(h.currentTask()),
        [],
        false,
      );
      assert.equal(
        retryCandidates.some((candidate) =>
          candidate.assignments?.some(
            (assignment) =>
              assignment.nodeId === "validate" &&
              [h.first, h.second].includes(assignment.participantId),
          ),
        ),
        false,
        "neither earlier writer may be selected for another validation attempt",
      );
      assert.ok(
        reportContract(h.state(), await workspaceRevision([h.repo]), []).some((reason) =>
          reason.includes("独立"),
        ),
      );
      // A foreign receipt must stay unmerged; only the writer attribution is recoverable.
      if (receipt === "foreign") return;
      const restarted = new TaskOrchestrator(h.options);
      for (let step = 0; step < 16; step++) {
        const validation = h.state().nodes.validate;
        if (validation?.status === "dispatched") break;
        for (const [nodeId, progress] of Object.entries(h.state().nodes))
          if (progress.status === "dispatched") await h.finish(nodeId);
        await h.service.reconcile(h.task.id);
        await restarted.tick();
      }
      const next = h.state().nodes.validate;
      assert.equal(next?.status, "dispatched", "a fresh independent review must remain possible");
      assert.ok(next.participantId);
      assert.notEqual(next.participantId, h.first);
      assert.notEqual(next.participantId, h.second);
      assert.ok(h.currentTask().participantIds.includes(next.participantId));
      await h.finish("validate", {
        evidence: [
          { command: "node regression.test", result: "passed", description: "新的独立核验" },
        ],
      });
      await restarted.tick();
      assert.equal(
        h.state().evidence.find((item) => item.description === "新的独立核验")?.source,
        "agent_review",
      );
    } finally {
      h.controller.abort();
      h.close();
    }
  });
