import assert from "node:assert/strict";
import test from "node:test";
import {
  activationBytes,
  assertMandatoryContextFits,
  boundActivationEnvelope,
  estimateActivationTokens,
  mandatoryOnlyPrompt,
  taskContextEnvelope,
} from "../../src/app/orchestration-context.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { ActorContext, Participant, StoredMessage, Task } from "../../src/core/types.js";
import type { EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { actor, discussion, setup } from "../tasks/helpers.js";
import { Engine, logger } from "./helpers.js";
import { leaderEventPrompt } from "./leader-helpers.js";
import { persistLegacyModelTask } from "./legacy-model-helpers.js";

const TABLE = "task_orchestration_events";
const HARD_TAIL = "HARD_CONSTRAINT_TAIL: 不得部署、不得扩大目录、不得跳过独立评审。";

function tailRevision(repetitions: number): string {
  return `${"背景说明 ".repeat(repetitions)}\n${HARD_TAIL}`;
}

function message(id: string, text: string, createdAt = "2026-09-30T00:00:00.000Z"): StoredMessage {
  return {
    id,
    sessionId: "main-session",
    taskId: "task_ctx",
    role: "user",
    source: "user",
    text,
    createdAt,
    delivery: "delivered",
    deliveryIds: [],
    generation: 0,
  };
}

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_ctx",
    ownerId: "owner",
    sessionId: "s",
    entryChatId: "c",
    kind: "development",
    title: "标题",
    requirements: HARD_TAIL,
    directories: ["/tmp/project"],
    directoryMode: "shared",
    bypass: false,
    status: "running",
    participantIds: ["p1"],
    groupDeleted: false,
    keepGroup: true,
    createGroup: true,
    createRemoteTask: true,
    worktreeReady: false,
    discussion: { mode: "manual", paused: false, rounds: 0, nextParticipant: 0 },
    result: "",
    closeRequested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function sampleParticipants(): Participant[] {
  return [
    {
      id: "p1",
      taskId: "task_ctx",
      name: "codex-1",
      kind: "codex",
      role: "实现并自测；不得改动验收结论",
      status: "idle",
      started: true,
      initialSent: true,
      initialReceipt: "r",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
}

function sampleOutputs(count: number, chars = 900) {
  return Array.from({ length: count }, (_, index) => ({
    entry: {
      id: `out-${index}`,
      role: "assistant" as const,
      text: `第 ${index} 项交付正文。`.repeat(Math.ceil(chars / 9)),
      final: true,
    },
    participantId: "p1",
    sequence: index,
    observedAt: "2026-01-01T00:00:00.000Z",
  }));
}

function envelopeFor(
  userMessages: StoredMessage[],
  options: { outputs?: number; outputChars?: number; event?: Record<string, unknown> } = {},
) {
  return taskContextEnvelope({
    task: sampleTask(),
    participants: sampleParticipants(),
    userMessages,
    mutations: [],
    outputs: sampleOutputs(options.outputs ?? 0, options.outputChars) as never,
    decisions: [],
    event: {
      id: "event",
      trigger: "user_revision",
      outputIds: [],
      ...options.event,
    },
  });
}

function parse<T>(prompt: string): T {
  return JSON.parse(prompt) as T;
}

test("every authenticated revision is complete and marker-visible, including control and escaped text", () => {
  const escaped = `\\\\ {"quote"} \u0000\u001f\u007f ${"😀".repeat(200)}\n${HARD_TAIL}`;
  const revisions = [
    message("r1", tailRevision(500)),
    message("r2", escaped, "2026-09-30T00:00:01.000Z"),
    message("r3", tailRevision(4000), "2026-09-30T00:00:02.000Z"),
  ];
  // 50k model context, exactly the configuration the parent review exercises.
  const budget = 50_000 - 1024 - 4096;
  const envelope = envelopeFor(revisions, { outputs: 12, outputChars: 1200 });
  assertMandatoryContextFits({ engineTokens: 50_000, prompt: mandatoryOnlyPrompt(envelope) });
  const bounded = boundActivationEnvelope(envelope, { tokenBudget: budget });
  assert.ok(
    estimateActivationTokens(bounded.prompt) <= budget,
    "the bounded payload must fit the real model input budget",
  );
  assert.ok(bounded.bytes > 12_288, "complete mandatory input may use out-of-line delivery");
  const parsed = parse<{ userRevisions: Array<{ id: string; text: string }> }>(bounded.prompt);
  assert.equal(parsed.userRevisions.length, 3, "no authenticated revision may be dropped");
  for (const revision of revisions)
    assert.equal(
      parsed.userRevisions.find((entry) => entry.id === revision.id)?.text,
      revision.text,
      `${revision.id} must be verbatim and complete`,
    );
  assert.ok(
    parsed.userRevisions.every((entry) => entry.text.includes("HARD_CONSTRAINT_TAIL")),
    "each revision keeps its own trailing hard constraint",
  );
  assert.ok(!bounded.shed.some((entry) => entry.startsWith("userRevisions")));
});

test("a revision far beyond any prefix length stays complete and only optional rows are shed", () => {
  const text = tailRevision(20_000); // ~160KB: far beyond any silent prefix bound
  const budget = 200_000 - 1024 - 4096;
  const bounded = boundActivationEnvelope(envelopeFor([message("r1", text)]), {
    tokenBudget: budget,
  });
  const parsed = parse<{
    userRevisions: Array<{ text: string }>;
    task: Task;
    participants: Participant[];
  }>(bounded.prompt);
  assert.equal(parsed.userRevisions[0]?.text, text, "the complete revision is delivered");
  assert.equal(parsed.task.requirements, HARD_TAIL);
  assert.equal(parsed.participants[0]?.role, sampleParticipants()[0]?.role);
  assert.match(bounded.prompt, /HARD_CONSTRAINT_TAIL/u);
});

test("many revisions keep every identity and mandatory fact, and shed only optional history", () => {
  const revisions = Array.from({ length: 60 }, (_, index) =>
    message(`r${index}`, `第 ${index} 条修订：不得跳过独立评审。`, `2026-09-30T00:00:${index}Z`),
  );
  const envelope = envelopeFor(revisions, { outputs: 40, outputChars: 3000 });
  // Mandatory core is small (~6KB); the optional history cannot fit this budget,
  // so the envelope must shed optional observations instead of refusing.
  const bounded = boundActivationEnvelope(envelope, { tokenBudget: 12_000 });
  const parsed = parse<{
    userRevisions: Array<{ id: string; text: string }>;
    task: Task;
    participants: Participant[];
    event: { id: string; trigger: string };
  }>(bounded.prompt);
  assert.equal(parsed.userRevisions.length, 60);
  for (const [index, revision] of revisions.entries())
    assert.equal(parsed.userRevisions[index]?.text, revision.text);
  assert.equal(parsed.task.requirements, HARD_TAIL);
  assert.equal(parsed.task.id, "task_ctx");
  assert.equal(parsed.event.id, "event");
  assert.ok(parsed.participants.length >= 1);
  const survivors = Object.keys(parsed);
  for (const mandatory of ["event", "task", "participants", "userRevisions"])
    assert.ok(survivors.includes(mandatory), `${mandatory} is mandatory`);
  const dropped = bounded.shed.filter(
    (entry) => !entry.includes(".text") && !entry.includes(".reason") && !entry.includes(".rows"),
  );
  assert.ok(dropped.length > 0, "optional history was shed to fit the model budget");
  assert.ok(
    dropped.every((entry) =>
      [
        "taskMutations",
        "priorDecisions",
        "authoritativeOutputs",
        "outputIndex",
        "outputIndexNote",
        "reading",
      ].includes(entry),
    ),
    `only optional observation lists may be removed: ${dropped.join(",")}`,
  );
  // Every MANDATORY key is byte-identical to the complete envelope; only
  // optional keys may be shortened or removed.
  const full = parse<Record<string, unknown>>(JSON.stringify(envelope));
  for (const key of ["event", "task", "participants", "userRevisions"])
    assert.deepEqual(
      (parsed as Record<string, unknown>)[key],
      full[key],
      `${key} is mandatory and must be identical to the complete envelope`,
    );
});

test("mandatory-only accounting includes every revision and refuses a truly unfit payload", () => {
  const envelope = envelopeFor([message("r1", HARD_TAIL), message("r2", tailRevision(40000))]);
  const only = parse<{ userRevisions?: Array<{ id: string }> }>(mandatoryOnlyPrompt(envelope));
  assert.equal(only.userRevisions?.length, 2, "user revisions are mandatory authority");
  assert.deepEqual(
    only.userRevisions?.map((entry) => entry.id),
    ["r1", "r2"],
  );
  assert.throws(
    () =>
      assertMandatoryContextFits({ engineTokens: 50_000, prompt: mandatoryOnlyPrompt(envelope) }),
    { code: "orchestration_context_budget", outcome: "not_executed" },
  );
  // The same complete mandatory core fits a larger context.
  assert.doesNotThrow(() =>
    assertMandatoryContextFits({ engineTokens: 200_000, prompt: mandatoryOnlyPrompt(envelope) }),
  );
});

test("optional shedding never needs to refuse when the mandatory core fits", () => {
  const revisions = [message("r1", tailRevision(5000))];
  const envelope = envelopeFor(revisions, { outputs: 30, outputChars: 8000 });
  // Deliberately tight: mandatory core fits, all optional observations do not.
  const mandatory = activationBytes(mandatoryOnlyPrompt(envelope));
  const budget = Math.ceil((mandatory + 600) / 3);
  const bounded = boundActivationEnvelope(envelope, { tokenBudget: budget });
  assert.ok(estimateActivationTokens(bounded.prompt) <= budget);
  const parsed = parse<{
    userRevisions: Array<{ text: string }>;
    task: Task;
    participants: Participant[];
    event: { id: string };
    authoritativeOutputs?: unknown[];
    outputIndex?: unknown[];
  }>(bounded.prompt);
  assert.equal(parsed.userRevisions[0]?.text, revisions[0]?.text);
  assert.equal(parsed.task.requirements, HARD_TAIL);
  assert.equal(parsed.participants[0]?.role, sampleParticipants()[0]?.role);
  assert.equal(parsed.event.id, "event");
  assert.equal(parsed.authoritativeOutputs, undefined, "even the last excerpt row is removable");
  assert.equal(parsed.outputIndex, undefined, "the optional index is removable");
});

test("the current event revision identity travels with the mandatory envelope", () => {
  const envelope = envelopeFor([message("r1", HARD_TAIL)], { event: { userRevision: "rev-7" } });
  const only = parse<{ event: { id: string; userRevision?: string } }>(
    mandatoryOnlyPrompt(envelope),
  );
  assert.equal(only.event.id, "event");
  assert.equal(only.event.userRevision, "rev-7");
});

test("inherited parent requirements stay complete while only parent excerpts are bounded", () => {
  const parentRequirements = `父任务约束：不得扩大授权范围。${"细节 ".repeat(9000)}PARENT_REQ_TAIL`;
  const parent = {
    taskId: "parent-task",
    title: "父任务",
    requirements: parentRequirements,
    result: "父任务已完成的结果不应进入上下文",
    participants: [{ name: "codex-parent", kind: "codex" as const, lastOutput: "P".repeat(5000) }],
  };
  const task = sampleTask({ parentTaskId: "parent-task", parentContext: parent });
  const envelope = taskContextEnvelope({
    task,
    participants: sampleParticipants(),
    userMessages: [message("r1", HARD_TAIL)],
    mutations: [],
    outputs: sampleOutputs(10, 3000) as never,
    decisions: [],
    event: { id: "event", trigger: "ready", outputIds: [] },
  });
  const bounded = boundActivationEnvelope(envelope, { tokenBudget: 44_880 });
  const parsed = parse<{
    task: Task & { parentContext?: { requirements: string; result: string } };
    userRevisions: Array<{ text: string }>;
  }>(bounded.prompt);
  assert.equal(
    parsed.task.parentContext?.requirements,
    parentRequirements,
    "inherited parent requirements are mandatory and complete",
  );
  assert.equal(
    parsed.task.parentContext?.result,
    undefined,
    "the parent result stays out of scope",
  );
  assert.equal(parsed.task.result, undefined, "the child result stays out of scope");
  assert.equal(parsed.userRevisions[0]?.text, HARD_TAIL);
  // The optional inherited-output excerpt is still bounded.
  const parentParticipant = (
    parsed.task.parentContext as unknown as {
      participants: Array<{ lastOutput: string }>;
    }
  ).participants[0];
  assert.ok(activationBytes(parentParticipant?.lastOutput ?? "") <= 600);
  assert.ok((parentParticipant?.lastOutput ?? "").startsWith("P"));
});

async function harness() {
  const h = setup();
  h.config.ai.enabled = true;
  const engine = new Engine();
  const control = new AbortController();
  const task = await h.service.create(actor, {
    ...discussion,
    kind: "development",
    requirements: HARD_TAIL,
    orchestration: { mode: "model" },
  });
  persistLegacyModelTask(h.store, task);
  await h.service.reconcile(task.id);
  const tools = (_actor: ActorContext): RuntimeTool[] => [
    {
      name: "task_detail",
      description: "detail",
      readOnly: true,
      parameters: {},
      execute: async () => ({ section: "requirements" }),
    },
    {
      name: "participant_send",
      description: "send",
      readOnly: false,
      parameters: {},
      execute: async (args, ctx) =>
        h.service.send(ctx, String(args.taskId), String(args.participantId), String(args.text)),
    },
  ];
  const options = {
    store: h.store,
    engine,
    tasks: () => h.service,
    tools,
    signal: control.signal,
    logger,
    retryDelayMs: 0,
    onReply: async () => {},
  };
  const worker = new TaskOrchestrator(options);
  const participants = h.service.records.participants(task);
  const execute = (input: EngineInput, name: string, args: Record<string, unknown>) => {
    const tool = input.tools.find((entry) => entry.name === name);
    assert.ok(tool, name);
    return tool.execute(args, input.actor);
  };
  return { ...h, engine, control, task, participants, worker, options, execute };
}

test("the real TaskOrchestrator delivers the current mandatory tail before it decides", async () => {
  const h = await harness();
  try {
    const original = `${"原任务背景 ".repeat(400)}\nORIGINAL_TAIL: 只允许修改授权目录。`;
    const current = `${"补充背景 ".repeat(900)}\nCURRENT_TAIL: 不得部署到生产环境。`;
    const base = h.service.get(actor, h.task.id);
    h.service.records.save({ ...base, requirements: original });
    let calls = 0;
    h.engine.handler = async (input) => {
      calls++;
      const data = JSON.parse(leaderEventPrompt(input)) as {
        task: { requirements: string };
        userRevisions: Array<{ text: string }>;
      };
      // The model must SEE both mandatory tails before it is allowed to act.
      assert.equal(data.task.requirements, original);
      assert.ok(
        data.userRevisions.some((entry) => entry.text.includes("CURRENT_TAIL")),
        "the current authenticated revision tail is visible before the decision",
      );
      await h.execute(input, "orchestration_decide", { action: "wait", reason: "等待用户确认。" });
      return { text: "", messages: [] };
    };
    // Establish the first event, then add an authenticated revision.
    await h.worker.tick();
    h.store.set("task_user_revisions", "current-revision", {
      taskId: h.task.id,
      source: {
        source: "feishu",
        ownerId: "owner",
        sessionId: "main-session",
        chatId: "entry",
        messageId: "current-revision-message",
        eventId: "current-revision-event",
        text: current,
      },
      at: new Date().toISOString(),
    });
    await h.worker.tick();
    assert.equal(calls, 2, "the revised event is scheduled exactly once");
    assert.ok(
      h.store.list<OrchestrationEvent>(TABLE).some((event) => event.trigger === "user_revision"),
      "a user revision event exists",
    );
    assert.equal(h.service.get(actor, h.task.id).requirements, original);
  } finally {
    h.close();
  }
});

test("the real TaskOrchestrator refuses an unfit mandatory revision typed, before any model call", async () => {
  const h = await harness();
  try {
    h.engine.contextTokens = 7000;
    const base = h.service.get(actor, h.task.id);
    h.service.records.save({
      ...base,
      requirements: "不得删除用户文件；".repeat(4000),
    });
    await h.worker.tick();
    assert.equal(h.engine.calls.length, 0, "no model call on an irreducible mandatory payload");
    const event = h.store.list<OrchestrationEvent>(TABLE)[0];
    assert.equal(event?.error?.code, "orchestration_context_budget");
    assert.equal(event?.error?.outcome, "not_executed");
    assert.equal(event?.state, "attention");
    assert.equal(
      h.service.get(actor, h.task.id).requirements,
      "不得删除用户文件；".repeat(4000),
      "canonical requirements stay verbatim on disk",
    );
  } finally {
    h.close();
  }
});
