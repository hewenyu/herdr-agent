import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/types.js";
import { addDocumentDelivery } from "../../src/orchestration/document-delivery.js";
import { assertDocumentSource } from "../../src/orchestration/document-source.js";
import { handoffDirectory } from "../../src/orchestration/handoff.js";
import { templatePlan } from "../../src/orchestration/templates.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function harness(documents = false, twoDocuments = false) {
  const h = setup();
  h.config.ai.enabled = true;
  assert.ok(h.config.jev);
  h.config.jev.apiKey = "fixture-only";
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "app.ts"), "// unchanged\n");
  await h.catalog.save({ name: "natural", directories: [repo], agent: "codex" });
  const requirements = documents
    ? `讨论设计并沉淀到 docs/DESIGN.md${twoDocuments ? " 和 docs/OTHER.md" : ""}，不开发业务代码。`
    : "讨论两种方案并给出共同结论。";
  const task = await h.service.create(actor, {
    ...discussion,
    project: "natural",
    requirements,
    orchestration: { mode: "workflow" },
  });
  assert.equal(task.promptVersion, 3);
  await h.service.reconcile(task.id);
  const engine = new Engine();
  let plans = 0;
  engine.handler = async (input) => {
    plans++;
    assert.equal(input.tools[0]?.name, "orchestration_plan");
    const documentDelivery = {
      paths: ["docs/DESIGN.md", ...(twoDocuments ? ["docs/OTHER.md"] : [])],
      userRequest: requirements,
    };
    const split = templatePlan(task);
    if (twoDocuments) {
      split.documentDelivery = documentDelivery;
      addDocumentDelivery(split);
      const document = split.nodes.find((node) => node.id === "document");
      const review = split.nodes.find((node) => node.id === "cross-review");
      assert.ok(document && review);
      document.documentPaths = ["docs/DESIGN.md"];
      split.nodes.splice(split.nodes.indexOf(document) + 1, 0, {
        ...document,
        id: "document-other",
        documentPaths: ["docs/OTHER.md"],
        dependsOn: ["document"],
      });
      review.dependsOn = ["document-other"];
    }
    await input.tools[0]?.execute(
      {
        template: "discussion",
        instructions: {},
        deliveryRequirements: [],
        documentDelivery,
        ...(twoDocuments ? { nodes: split.nodes } : {}),
      },
      input.actor,
    );
    return { text: "", messages: [] };
  };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const ids = Object.keys(body.questions.action.criteria);
    const choice = ids.includes("use_template")
      ? documents
        ? "request_pi"
        : "use_template"
      : ids.includes("authorized")
        ? "authorized"
        : (ids.find((id) => id.startsWith("deliver:")) ??
          ids.find((id) => id.startsWith("dispatch:")) ??
          ids[0]);
    return new Response(
      JSON.stringify({
        model: "jev-fixture",
        answers: {
          action: {
            type: "choice",
            choice,
            confidence: 0.99,
            probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
          },
        },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    );
  };
  const replies: string[] = [];
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
    fetch,
    onReply: async (_task: unknown, text: string) => {
      replies.push(text);
    },
  };
  const worker = new TaskOrchestrator(options);
  const state = () => h.store.get<WorkflowState>(WORKFLOWS, task.id) as WorkflowState;
  const finish = async (id: string, extra: Record<string, unknown> = {}) => {
    const progress = state().nodes[id];
    assert.ok(
      progress?.operationId && progress.participantId && progress.inputRevision,
      JSON.stringify(
        { id, state: state(), events: h.store.list("task_orchestration_events") },
        null,
        2,
      ),
    );
    const participant = h.service.records
      .participants(task)
      .find((entry) => entry.id === progress.participantId);
    assert.ok(participant?.execution);
    const directory = handoffDirectory(h.config.stateDir, task.id, progress.operationId);
    const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8"));
    writeFileSync(join(directory, "notes.md"), `# ${id}\n我已读取上一轮材料并回应具体观点。`);
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify({ ...request, summary: `${id} 已完成`, ...extra }),
    );
    if (id === "report")
      writeFileSync(
        join(directory, "report.md"),
        state()
          .plan.deliveryRequirements.map((title) => `## ${title}\n\n实际结论与已核验文件。`)
          .join("\n\n"),
      );
    h.herdr.finish(
      participant.execution.paneId,
      `我接受这项修改，详细意见见 ${join(directory, "notes.md")}，请下一位复核。`,
    );
    await h.service.reconcile(task.id);
  };
  return { ...h, task, repo, worker, state, finish, replies, options, plans: () => plans };
}

for (const documents of [false, true])
  test(`v3 discussion naturally hands off, verifies artifacts and survives restart (documents=${documents})`, async () => {
    const h = await harness(documents);
    try {
      await h.worker.tick();
      assert.equal(h.plans(), documents ? 1 : 0, "pi only plans when Jev requests help");
      await h.worker.tick();
      assert.equal(h.herdr.sends.length, 1, "first speaker only");
      assert.doesNotMatch(h.herdr.sends[0]?.text ?? "", /myrix-status|protocolVersion|operationId/);
      await h.finish("opening-1");
      await h.worker.tick();
      assert.equal(h.herdr.sends.length, 2);
      await h.finish("opening-2");
      await h.worker.tick();
      if (documents) {
        assert.equal(h.state().nodes.document?.status, "dispatched");
        mkdirSync(join(h.repo, "docs"));
        writeFileSync(join(h.repo, "docs/DESIGN.md"), "# 双方设计\n待对方复核的实际文档\n");
        await h.finish("document", { artifactRefs: ["docs/DESIGN.md"] });
        await h.worker.tick();
        assert.notEqual(
          h.state().nodes.document?.participantId,
          h.state().nodes["cross-review"]?.participantId,
        );
      }
      await h.finish("cross-review", documents ? { artifactRefs: ["docs/DESIGN.md"] } : {});
      await h.worker.tick();
      await h.finish("report", documents ? { artifactRefs: ["docs/DESIGN.md"] } : {});
      await h.worker.tick();
      assert.equal(
        h.state().phase,
        "awaiting_acceptance",
        JSON.stringify(
          { state: h.state(), events: h.store.list("task_orchestration_events") },
          null,
          2,
        ),
      );
      assert.equal(h.replies.length, 1);
      assert.equal(readFileSync(join(h.repo, "app.ts"), "utf8"), "// unchanged\n");
      if (documents) assert.match(readFileSync(join(h.repo, "docs/DESIGN.md"), "utf8"), /实际文档/);
      const sends = h.herdr.sends.length;
      await new TaskOrchestrator(h.options).tick();
      assert.equal(h.herdr.sends.length, sends);
      assert.equal(h.replies.length, 1);
      assert.ok(h.store.list("workflow_conversation_evidence").length >= 4);
    } finally {
      h.close();
    }
  });

test("v3 document writer cannot certify unrelated source modifications", async () => {
  const h = await harness(true);
  try {
    await h.worker.tick();
    await h.worker.tick();
    await h.finish("opening-1");
    await h.worker.tick();
    await h.finish("opening-2");
    await h.worker.tick();
    mkdirSync(join(h.repo, "docs"));
    writeFileSync(join(h.repo, "docs/DESIGN.md"), "# Design");
    writeFileSync(join(h.repo, "app.ts"), "// unauthorized change");
    await h.finish("document", { artifactRefs: ["docs/DESIGN.md"] });
    await h.worker.tick();
    assert.equal(h.replies.length, 1, "send one actionable blocker, never a completion");
    assert.match(h.replies[0] ?? "", /授权文档之外/);
    assert.equal(h.state().stall.awaitingUser, true);
    assert.ok(
      h.store
        .list<OrchestrationEvent>("task_orchestration_events")
        .every((event) => event.decision?.action !== "deliver"),
    );
    assert.notEqual(h.state().nodes.document?.status, "completed");
  } finally {
    h.close();
  }
});

test("repeated document scope violations remain one recoverable issue across user resumes", async () => {
  const h = await harness(true);
  const issueId = "document-scope-violation";
  const startDocument = async () => {
    await h.worker.tick();
    await h.worker.tick();
    await h.finish("opening-1");
    await h.worker.tick();
    await h.finish("opening-2");
    await h.worker.tick();
    assert.equal(h.state().nodes.document?.status, "dispatched");
  };
  try {
    const violationOutputs: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) {
        writeFileSync(join(h.repo, "app.ts"), "// unchanged\n");
        await h.service.action(
          { ...actor, messageId: `resume-document-${attempt}` },
          h.task.id,
          "resume",
        );
      }
      await startDocument();
      mkdirSync(join(h.repo, "docs"), { recursive: true });
      writeFileSync(join(h.repo, "docs/DESIGN.md"), `# Design ${attempt}\n`);
      writeFileSync(join(h.repo, "app.ts"), `// unauthorized change ${attempt}\n`);
      await h.finish("document", { artifactRefs: ["docs/DESIGN.md"] });
      await h.worker.tick();
      const state = h.state();
      assert.equal(state.stall.awaitingUser, true);
      assert.equal(state.issues.filter((issue) => issue.id === issueId).length, 1);
      const outputId = state.nodes.document?.outputId;
      assert.ok(outputId);
      violationOutputs.push(outputId);
      assert.deepEqual(state.issues[0]?.evidenceRefs, violationOutputs);
      assert.deepEqual(
        state.issues[0]?.responses.map((response) => response.outputId),
        violationOutputs,
      );
    }

    // Old releases could persist a resolved first entry followed by another open entry.
    const historical = h.state();
    const original = historical.issues[0];
    assert.ok(original);
    const responses = original.responses;
    historical.issues = [
      {
        ...original,
        status: "resolved",
        evidenceRefs: violationOutputs.slice(0, 1),
        responses: responses.slice(0, 1),
      },
      {
        ...original,
        status: "open",
        evidenceRefs: violationOutputs.slice(1),
        responses: responses.slice(1),
      },
    ];
    h.store.set(WORKFLOWS, h.task.id, historical);
    const sends = h.herdr.sends.length;
    const replies = h.replies.length;
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.state().issues.length, 1, "merge must persist without a new output");
    assert.equal(h.state().issues[0]?.status, "open");
    assert.deepEqual(h.state().issues[0]?.evidenceRefs, violationOutputs);
    assert.deepEqual(h.state().issues[0]?.responses, responses);
    assert.equal(h.state().stall.awaitingUser, true, "deduplication cannot authorize resuming");
    assert.equal(h.herdr.sends.length, sends);
    assert.equal(h.replies.length, replies);

    // The user repairs the unauthorized change before authorizing another plan.
    writeFileSync(join(h.repo, "app.ts"), "// unchanged\n");
    await h.service.action(
      { ...actor, messageId: "resume-document-compliant" },
      h.task.id,
      "resume",
    );
    await startDocument();
    writeFileSync(join(h.repo, "docs/DESIGN.md"), "# Reviewed design\n");
    await h.finish("document", { artifactRefs: ["docs/DESIGN.md"] });
    await h.worker.tick();
    assert.notEqual(
      h.state().nodes.document?.participantId,
      h.state().nodes["cross-review"]?.participantId,
    );
    await h.finish("cross-review", {
      artifactRefs: ["docs/DESIGN.md"],
      issues: [
        {
          id: issueId,
          description: "已独立核对源码恢复且当前仅修改授权设计文档。",
          status: "resolved",
          blocking: true,
          evidenceRefs: [...violationOutputs, "docs/DESIGN.md"],
        },
      ],
    });
    await h.worker.tick();
    await h.finish("report", { artifactRefs: ["docs/DESIGN.md"] });
    await h.worker.tick();
    assert.equal(h.state().phase, "awaiting_acceptance");
    assert.equal(h.state().stall.awaitingUser, false);
    assert.equal(h.state().issues.length, 1);
    assert.equal(h.state().issues[0]?.status, "resolved");
    assert.deepEqual(h.state().issues[0]?.responses.slice(0, 2), responses);
    assert.equal(h.replies.length, replies + 1, "the recovered task delivers one final report");
  } finally {
    h.close();
  }
});

test("resume cannot wash a document scope violation into a new source baseline", async () => {
  const h = await harness(true);
  const begin = async () => {
    await h.worker.tick();
    await h.worker.tick();
    await h.finish("opening-1");
    await h.worker.tick();
    await h.finish("opening-2");
    await h.worker.tick();
  };
  try {
    await begin();
    const baseline = h.state().documentSource;
    assert.ok(baseline);
    mkdirSync(join(h.repo, "docs"));
    writeFileSync(join(h.repo, "docs/DESIGN.md"), "# Design\n");
    writeFileSync(join(h.repo, "app.ts"), "// unauthorized change\n");
    await h.finish("document", { artifactRefs: ["docs/DESIGN.md"] });
    await h.worker.tick();
    const sends = h.herdr.sends.length;
    await h.service.action(
      { ...actor, messageId: "resume-without-restoring" },
      h.task.id,
      "resume",
    );
    await h.worker.tick();
    await h.worker.tick();
    assert.equal(
      h.herdr.sends.length,
      sends,
      "dirty source prevents even the resumed opening from being sent",
    );
    assert.deepEqual(h.state().documentSource, baseline);
    assert.ok(
      h.store
        .list<OrchestrationEvent>("task_orchestration_events")
        .some(
          (event) => event.state === "attention" && event.error?.code === "workflow_document_scope",
        ),
    );
    const replies = h.replies.length;
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.herdr.sends.length, sends);
    assert.equal(h.replies.length, replies, "restart must not repeat the blocked notification");
    const claimedResolved = h.state();
    for (const issue of claimedResolved.issues) issue.status = "resolved";
    await assert.rejects(assertDocumentSource(h.store, h.task, claimedResolved), {
      code: "workflow_document_scope",
    });
    assert.ok(
      h.store
        .list<OrchestrationEvent>("task_orchestration_events")
        .every((event) => event.decision?.action !== "deliver"),
    );

    writeFileSync(join(h.repo, "app.ts"), "// unchanged\n");
    await h.service.action({ ...actor, messageId: "resume-after-restoring" }, h.task.id, "resume");
    await begin();
    assert.equal(h.state().nodes.document?.status, "dispatched");
    assert.deepEqual(h.state().documentSource, baseline);
    writeFileSync(join(h.repo, "docs/DESIGN.md"), "# Reviewed design\n");
    await h.finish("document", { artifactRefs: ["docs/DESIGN.md"] });
    await h.worker.tick();
    await h.finish("cross-review", {
      artifactRefs: ["docs/DESIGN.md"],
      issues: [
        {
          id: "document-scope-violation",
          description: "已复核源码恢复。",
          status: "resolved",
          blocking: true,
          evidenceRefs: ["docs/DESIGN.md"],
        },
      ],
    });
    await h.worker.tick();
    await h.finish("report", { artifactRefs: ["docs/DESIGN.md"] });
    await h.worker.tick();
    assert.equal(h.state().phase, "awaiting_acceptance");
    assert.deepEqual(h.state().documentSource, baseline);
  } finally {
    h.close();
  }
});

test("frozen document dispatch retains its narrower scope across restart", async () => {
  const h = await harness(true, true);
  const controller = new AbortController();
  const worker = new TaskOrchestrator({ ...h.options, signal: controller.signal });
  const save = h.store.set.bind(h.store);
  let frozen: OrchestrationEvent | undefined;
  try {
    await worker.tick();
    await worker.tick();
    await h.finish("opening-1");
    await worker.tick();
    await h.finish("opening-2");
    const sends = h.herdr.sends.length;
    h.store.set = (namespace, key, value) => {
      save(namespace, key, value);
      if (namespace !== "task_orchestration_events" || frozen) return;
      const event = value as OrchestrationEvent;
      if (!event.dispatches.some((dispatch) => dispatch.nodeId === "document")) return;
      frozen = structuredClone(event);
      controller.abort();
    };
    await worker.tick();
    h.store.set = save;
    assert.ok(frozen);
    const sourceRevision = frozen.dispatches[0]?.sourceRevision;
    assert.ok(sourceRevision);
    assert.equal(h.herdr.sends.length, sends);
    mkdirSync(join(h.repo, "docs"));
    writeFileSync(
      join(h.repo, "docs/OTHER.md"),
      "# Another node's document changed while waiting\n",
    );
    await assertDocumentSource(h.store, h.task, h.state());
    await new TaskOrchestrator(h.options).tick();
    const refused = h.store.get<OrchestrationEvent>("task_orchestration_events", frozen.id);
    assert.equal(refused?.state, "attention");
    assert.equal(refused?.error?.code, "workflow_document_scope");
    assert.equal(refused?.dispatches[0]?.sourceRevision, sourceRevision);
    assert.equal(
      h.herdr.sends.length,
      sends,
      "the broad document authorization cannot rewrite a frozen node's narrower baseline",
    );
  } finally {
    h.store.set = save;
    controller.abort();
    h.close();
  }
});

for (const mutation of ["source contamination", "removed document scope"] as const)
  test(`delivery replay refuses ${mutation} and retires the report to attention once`, async () => {
    const h = await harness(true);
    const reply = h.options.onReply;
    try {
      await h.worker.tick();
      await h.worker.tick();
      await h.finish("opening-1");
      await h.worker.tick();
      await h.finish("opening-2");
      await h.worker.tick();
      mkdirSync(join(h.repo, "docs"));
      writeFileSync(join(h.repo, "docs/DESIGN.md"), "# Design\n");
      await h.finish("document", { artifactRefs: ["docs/DESIGN.md"] });
      await h.worker.tick();
      await h.finish("cross-review", { artifactRefs: ["docs/DESIGN.md"] });
      await h.worker.tick();
      await h.finish("report", { artifactRefs: ["docs/DESIGN.md"] });
      h.options.onReply = async () => {
        throw new OperationError("offline", "fixture transport unavailable");
      };
      await h.worker.tick();
      const delivery = h.store
        .list<OrchestrationEvent>("task_orchestration_events")
        .find((event) => event.decision?.action === "deliver");
      assert.ok(delivery);
      assert.equal(delivery.state, "done");
      assert.equal(delivery.notified, undefined);
      assert.equal(h.replies.length, 0);

      if (mutation === "source contamination")
        writeFileSync(join(h.repo, "app.ts"), "// changed before actual delivery\n");
      else {
        const changed = h.state();
        changed.plan.documentDelivery = undefined;
        h.store.set(WORKFLOWS, h.task.id, changed);
      }
      const errors: string[] = [];
      const restarted = new TaskOrchestrator({
        ...h.options,
        onReply: reply,
        logger: {
          ...logger,
          error: (message: string) => {
            errors.push(message);
          },
        },
      });
      await restarted.tick();
      const retired = h.store.get<OrchestrationEvent>("task_orchestration_events", delivery.id);
      assert.equal(retired?.state, "attention");
      assert.equal(retired?.error?.code, "workflow_document_scope");
      assert.equal(h.replies.length, 1);
      assert.match(
        h.replies[0] ?? "",
        mutation === "source contamination" ? /授权文档之外/ : /文档范围不能移除/,
      );
      for (let tick = 0; tick < 3; tick++) await restarted.tick();
      assert.equal(h.replies.length, 1);
      assert.deepEqual(errors, []);
    } finally {
      h.close();
    }
  });

for (const stage of ["planning", "selection"] as const)
  test(`v3 ${stage} evidence waits survive ticks/restarts without consuming retries and resume on new evidence`, async () => {
    const h = await harness();
    let calls = 0;
    let release = false;
    const options = {
      ...h.options,
      fetch: (async (url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        const ids = Object.keys(body.questions.action.criteria);
        const planning = ids.includes("use_template");
        if (release || (stage === "selection" && planning)) return h.options.fetch(url, init);
        const assistance = ids.includes("wait_for_evidence");
        const choice = assistance ? "wait_for_evidence" : ids[0];
        return new Response(
          JSON.stringify({
            model: "jev-fixture",
            answers: {
              action: {
                type: "choice",
                choice,
                confidence: assistance ? 0.99 : 0.5,
                probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
              },
            },
            usage: { input_tokens: 10, output_tokens: 1 },
          }),
        );
      }) as typeof globalThis.fetch,
    };
    const worker = new TaskOrchestrator(options);
    try {
      await worker.tick();
      if (stage === "selection") {
        const state = h.state();
        const second = state.plan.nodes.find((node) => node.id === "opening-2");
        assert.ok(second);
        second.dependsOn = [];
        h.store.set(WORKFLOWS, h.task.id, state);
        await worker.tick();
      }
      const waiting = h.state().assistanceWait;
      assert.ok(waiting);
      const firstCalls = calls;
      const event = () =>
        h.store.get<OrchestrationEvent>("task_orchestration_events", waiting.eventId);
      assert.equal(event()?.attempts, 0);
      assert.equal(event()?.state, "pending");
      for (let tick = 0; tick < 5; tick++) await worker.tick();
      await new TaskOrchestrator(options).tick();
      assert.equal(calls, firstCalls, "unchanged evidence must never repeat Jev calls");
      assert.equal(event()?.attempts, 0);
      assert.equal(h.herdr.sends.length, 0);
      assert.equal(h.replies.length, 0);
      assert.deepEqual(h.state().assistanceWait, waiting);

      writeFileSync(join(h.repo, "new-evidence.md"), "New external evidence\n");
      await worker.tick();
      assert.equal(calls, firstCalls + 2, "changed evidence permits one fresh assessment");
      assert.notEqual(h.state().assistanceWait?.fingerprint, waiting.fingerprint);
      if (stage === "planning")
        assert.equal(
          h.store.list("workflow_planning_decisions").length,
          2,
          "wait audits are retained",
        );
      await worker.tick();
      assert.equal(calls, firstCalls + 2);

      release = true;
      const current = h.store.get<Task>("tasks", h.task.id);
      assert.ok(current);
      h.service.records.save({
        ...current,
        requirements: `${current.requirements}\n用户补充了判断依据。`,
      });
      await worker.tick();
      assert.equal(h.state().assistanceWait, undefined);
      assert.equal(h.state().planning, "ready");
      await worker.tick();
      assert.equal(h.herdr.sends.length, 1);
      assert.ok(
        h.store
          .list<OrchestrationEvent>("task_orchestration_events")
          .every((entry) => entry.state !== "attention"),
      );
    } finally {
      h.close();
    }
  });
