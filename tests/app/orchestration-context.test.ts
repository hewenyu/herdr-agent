import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activationBytes,
  boundActivationEnvelope,
  estimateActivationTokens,
  mandatoryOnlyPrompt,
  priorDecisionFacts,
  shrinkText,
  taskContextEnvelope,
} from "../../src/app/orchestration-context.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext, Participant, Task } from "../../src/core/types.js";
import type { EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { actor, discussion, setup } from "../tasks/helpers.js";
import { Engine, logger } from "./helpers.js";
import { leaderEventPrompt } from "./leader-helpers.js";
import { persistLegacyModelTask } from "./legacy-model-helpers.js";

const TABLE = "task_orchestration_events";
const HARD_CONSTRAINT = "不得删除用户文件；只修改授权目录；不得跳过独立评审。";

async function harness() {
  const h = setup();
  h.config.ai.enabled = true;
  const engine = new Engine();
  const control = new AbortController();
  const task = await h.service.create(actor, {
    ...discussion,
    kind: "development",
    requirements: HARD_CONSTRAINT,
    orchestration: { mode: "model" },
  });
  persistLegacyModelTask(h.store, task);
  await h.service.reconcile(task.id);
  const tools = (_actor: ActorContext): RuntimeTool[] => [
    {
      name: "task_get",
      description: "read",
      readOnly: true,
      parameters: {},
      execute: async (_args, ctx) => h.service.get(ctx, task.id),
    },
    {
      name: "task_detail",
      description: "detail",
      readOnly: true,
      parameters: {},
      execute: async (args, ctx) => {
        const target = String(args.taskId ?? ctx.taskId);
        if (target !== task.id) throw new OperationError("task_scope", "跨任务读取被拒绝。");
        return { section: args.section, taskId: target };
      },
    },
    {
      name: "participant_screen",
      description: "screen",
      readOnly: true,
      parameters: {},
      execute: async (args, ctx) => h.service.screen(ctx, task.id, String(args.participantId)),
    },
    {
      name: "participant_send",
      description: "send",
      readOnly: false,
      parameters: {},
      execute: async (args, ctx) =>
        h.service.send(ctx, String(args.taskId), String(args.participantId), String(args.text)),
    },
    {
      name: "task_action",
      description: "forbidden lifecycle authority",
      readOnly: false,
      parameters: {},
      execute: async () => assert.fail("background must never close/complete a task"),
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

function sampleTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_ctx",
    ownerId: "owner",
    sessionId: "s",
    entryChatId: "c",
    kind: "development",
    title: "标题",
    requirements: HARD_CONSTRAINT,
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

function sampleOutputs(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    entry: {
      id: `out-${index}`,
      role: "assistant" as const,
      text: `第 ${index} 项交付正文。`.repeat(24),
      final: true,
    },
    participantId: "p1",
    sequence: index,
    observedAt: "2026-01-01T00:00:00.000Z",
  }));
}

function sampleDecisions(count: number) {
  return priorDecisionFacts(
    Array.from({ length: count }, (_, index) => ({
      id: `ev-${index}`,
      decision: { action: "continue" as const, reason: `第 ${index} 次决定理由。`.repeat(40) },
    })) as never,
  );
}

test("complete mandatory tail survives the bounded envelope for >=34 outputs and decisions", () => {
  const task = sampleTask();
  for (const count of [34, 200, 2000]) {
    const envelope = taskContextEnvelope({
      task,
      participants: sampleParticipants(),
      userMessages: [
        { id: "m1", text: HARD_CONSTRAINT, createdAt: "2026-01-01T00:00:00.000Z" },
      ] as never,
      mutations: [],
      outputs: sampleOutputs(count) as never,
      decisions: sampleDecisions(40),
      event: { id: "ev", trigger: "output", outputIds: ["out-0"] },
    });
    // The model context is the hard ceiling; the inline policy budget is only a
    // delivery choice and never a reason to sever a constraint.
    const bounded = boundActivationEnvelope(envelope, { tokenBudget: 12_000 });
    assert.ok(
      estimateActivationTokens(bounded.prompt) <= 12_000,
      `${count} outputs must fit the model context`,
    );
    // The envelope is complete, parseable JSON, never a severed prefix.
    const parsed = JSON.parse(bounded.prompt) as Record<string, never>;
    assert.equal(
      (parsed.task as unknown as Task).requirements,
      HARD_CONSTRAINT,
      "mandatory requirements are complete",
    );
    assert.equal(
      (parsed.participants as unknown as Participant[])[0]?.role,
      sampleParticipants()[0]?.role,
      "mandatory participant role constraint is complete",
    );
    assert.equal((parsed.event as unknown as { id: string }).id, "ev");
    assert.equal((parsed.task as unknown as Task).id, task.id);
  }
});

test("an over-12KiB complete payload is delivered out-of-line, never truncated or refused", () => {
  const task = sampleTask();
  const envelope = taskContextEnvelope({
    task,
    participants: sampleParticipants(),
    userMessages: [] as never,
    mutations: [],
    outputs: sampleOutputs(34) as never,
    decisions: sampleDecisions(40),
    event: { id: "ev", trigger: "output", outputIds: [] },
  });
  // A big model context: the payload exceeds the 12KiB inline policy budget but
  // is comfortably inside the context, so it must be delivered complete.
  const bounded = boundActivationEnvelope(envelope, { tokenBudget: 128_000 });
  assert.ok(bounded.bytes > 12_288, `payload should exceed the inline budget: ${bounded.bytes}`);
  assert.equal(bounded.inline, false, "an over-budget payload is delivered out-of-line");
  const parsed = JSON.parse(bounded.prompt) as Record<string, never>;
  assert.equal(
    (parsed.task as unknown as Task).requirements,
    HARD_CONSTRAINT,
    "the complete mandatory tail is still present",
  );
  assert.equal((parsed.task as unknown as Task).id, task.id);
  assert.equal(
    (parsed.participants as unknown as Participant[]).length,
    sampleParticipants().length,
  );
});

test("user revisions remain mandatory and are never shed, shortened or dropped", () => {
  const long = `用户原始硬性要求：${"不得跳过独立评审；".repeat(400)}`;
  const envelope = taskContextEnvelope({
    task: sampleTask(),
    participants: sampleParticipants(),
    userMessages: [{ id: "m1", text: long, createdAt: "x" }] as never,
    mutations: [],
    outputs: sampleOutputs(200) as never,
    decisions: sampleDecisions(40),
    event: { id: "ev", trigger: "output", outputIds: [] },
  });
  const bounded = boundActivationEnvelope(envelope, { tokenBudget: 100_000 });
  const parsed = JSON.parse(bounded.prompt) as Record<string, never>;
  const revisions = parsed.userRevisions as unknown as Array<{ text: string }>;
  assert.ok(revisions?.length, "user revisions are present");
  assert.equal(revisions[0]?.text, long, "the authenticated user revision is verbatim");
  assert.ok(
    !bounded.shed.some((entry) => entry.startsWith("userRevisions")),
    `user revisions must never be shed: ${bounded.shed.join(",")}`,
  );
});

test("optional history grows sublinearly and never unbounded with output count", () => {
  const task = sampleTask();
  const sizes = [8, 34, 200, 2000].map((count) => {
    const envelope = taskContextEnvelope({
      task,
      participants: sampleParticipants(),
      userMessages: [] as never,
      mutations: [],
      outputs: sampleOutputs(count) as never,
      decisions: sampleDecisions(40),
      event: { id: "ev", trigger: "output", outputIds: [] },
    });
    const bounded = boundActivationEnvelope(envelope, { tokenBudget: 12_000 });
    assert.ok(estimateActivationTokens(bounded.prompt) <= 12_000);
    return bounded.bytes;
  });
  // A 250x growth in canonical history must not grow the activation linearly.
  assert.ok(
    (sizes.at(-1) as number) - (sizes[0] as number) < 4096,
    `activation growth must stay bounded: ${sizes.join(",")}`,
  );
});

test("shrinkText is UTF-8/control safe and never splits a surrogate pair", () => {
  const nasty = `${"😀".repeat(80)}\u0000\u001f\\"${"\\".repeat(200)}`;
  for (const limit of [4, 8, 32, 128, 4096]) {
    const text = shrinkText(nasty, limit);
    assert.ok(activationBytes(text) <= Math.max(limit, 4), `limit ${limit}`);
    assert.ok(!/[\uD800-\uDBFF]$/.test(text), "never ends on a lone high surrogate");
    assert.ok(!/^[\uDC00-\uDFFF]/.test(text), "never starts on a lone low surrogate");
  }
  assert.equal(shrinkText("短", 100), "短", "already-fitting text is unchanged");
  assert.equal(shrinkText("任意", 0), "");
});

test("mandatory-only envelope is strictly smaller and still carries every constraint", () => {
  const envelope = taskContextEnvelope({
    task: sampleTask(),
    participants: sampleParticipants(),
    userMessages: [{ id: "m1", text: HARD_CONSTRAINT, createdAt: "x" }] as never,
    mutations: [],
    outputs: sampleOutputs(500) as never,
    decisions: sampleDecisions(40),
    event: { id: "ev", trigger: "output", outputIds: [] },
  });
  const only = mandatoryOnlyPrompt(envelope);
  assert.ok(activationBytes(only) < activationBytes(JSON.stringify(envelope)));
  const parsed = JSON.parse(only) as Record<string, never>;
  assert.equal((parsed.task as unknown as Task).requirements, HARD_CONSTRAINT);
  assert.equal(
    (parsed.participants as unknown as Participant[])[0]?.role,
    "实现并自测；不得改动验收结论",
  );
  assert.equal(parsed.outputIndex, undefined, "optional lists are the only thing removed");
  // Envelope sizing uses the same reserve model as the runtime request budget.
  assert.ok(estimateActivationTokens(only) > 0);
});

test("scoped tools expose read-only task_detail bound to the current task and no lifecycle authority", async () => {
  const h = await harness();
  try {
    let calls = 0;
    h.engine.handler = async (input) => {
      calls++;
      const names = input.tools.map((tool) => tool.name).sort();
      assert.ok(names.includes("task_detail"), "task_detail must be available");
      assert.ok(!names.includes("task_action"), "no lifecycle authority in the background");
      const detail = input.tools.find((tool) => tool.name === "task_detail");
      assert.ok(detail);
      assert.equal(detail.readOnly, true);
      // The scoped wrapper pins every read to the current task.
      const page = await detail.execute({ section: "outputs" }, input.actor);
      assert.equal((page as { taskId: string }).taskId, h.task.id);
      await assert.rejects(
        detail.execute({ section: "outputs", taskId: "another-task" }, input.actor),
        /当前任务|只允许|拒绝/,
      );
      await h.execute(input, "participant_send", {
        participantId: h.participants[0]?.id,
        text: "按原始约束继续。",
      });
      await h.execute(input, "orchestration_decide", {
        action: "continue",
        reason: "已安排下一步。",
      });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    assert.equal(calls, 1);
    assert.equal(h.herdr.sends.length, 1);
    // The hard constraint reached the participant input unchanged.
    assert.match(h.herdr.sends[0]?.text ?? "", /不得跳过独立评审/);
  } finally {
    h.close();
  }
});

test("an exact recorded native receipt is reconciled before the legacy Leader call without sending", async () => {
  const h = await harness();
  try {
    const participant = h.participants[0] as Participant;
    assert.ok(participant.execution);
    // Turn 1 establishes the participant; turn 2 performs a NON-initial Leader
    // send, whose native delivery body is the documented receipt envelope.
    h.engine.handler = async (input) => {
      await h.execute(input, "participant_send", {
        participantId: participant.id,
        text: "第一轮初始安排。",
      });
      await h.execute(input, "orchestration_decide", {
        action: "continue",
        reason: "已安排下一步。",
      });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    h.herdr.finish(participant.execution.paneId, "第 1 项交付完成");
    await h.service.reconcile(h.task.id);

    const text = "第二轮安排，沿原始约束继续。";
    h.engine.handler = async (input) => {
      await h.execute(input, "participant_send", { participantId: participant.id, text });
      await h.execute(input, "orchestration_decide", {
        action: "continue",
        reason: "已安排下一步。",
      });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    const sent = h.store
      .list<{ id: string; tool: string; state: string; args: string }>("leader_operations")
      .find(
        (operation) =>
          operation.tool === "participant_send" &&
          (JSON.parse(operation.args) as { text?: string }).text === text,
      );
    assert.ok(sent, "the Leader journal recorded the send");
    // Locate the exact native operation by the recorded dispatch of this send.
    const dispatch = h.store
      .list<OrchestrationEvent>(TABLE)
      .flatMap((event) => event.dispatches)
      .find((entry) => {
        const delivery = h.store.get<{ participantId?: string; prompt?: string }>(
          "input_deliveries",
          entry.operationId,
        );
        return delivery?.participantId === participant.id && delivery.prompt?.includes(text);
      });
    assert.ok(dispatch, "the native dispatch is linked to this send");
    assert.equal(
      h.store.get<{ state: string }>("operations", dispatch.operationId)?.state,
      "done",
      "the native receipt proves the delivery",
    );

    // The crash window: the native effect is proven, but the Leader journal row
    // never settled and still blocks every later activation. The real prepared
    // native delivery body, fingerprint and receipt are left exactly as the
    // operations boundary wrote them, so only the Leader row is damaged.
    h.store.set("leader_operations", sent.id, {
      ...(h.store.get<Record<string, unknown>>("leader_operations", sent.id) ?? {}),
      state: "pending",
      resolution: undefined,
    });

    h.herdr.finish(participant.execution.paneId, "第 2 项交付完成");
    await h.service.reconcile(h.task.id);
    let calls = 0;
    h.engine.handler = async (input) => {
      calls++;
      const data = JSON.parse(leaderEventPrompt(input));
      assert.equal(data.task.requirements, HARD_CONSTRAINT);
      await h.execute(input, "orchestration_decide", {
        action: "wait",
        reason: "等待用户确认下一阶段。",
      });
      return { text: "", messages: [] };
    };
    const before = h.herdr.sends.length;
    await h.worker.tick();

    // Reconciliation closed the proven receipt from the EXACT native record and
    // only the recorded effect; the blocking activation continued, and nothing
    // was re-sent for the already completed operation.
    const resolved = h.store.get<{
      state: string;
      resolution?: { choice: string; decidedBy: string };
      result?: { verified?: boolean };
    }>("leader_operations", sent.id);
    assert.equal(resolved?.state, "complete", "the proven receipt is closed");
    assert.equal(resolved?.resolution?.choice, "treat_done");
    assert.equal(resolved?.resolution?.decidedBy, "evidence");
    assert.equal(resolved?.result?.verified, true, "only the proven native fact is recorded");
    assert.equal(h.herdr.sends.length - before, 0, "reconciliation must not send anything");
    assert.equal(calls, 1, "the new event is scheduled after reconciliation");
  } finally {
    h.close();
  }
});

test("a recorded activation is never inferred again and mandatory constraints are never severed", async () => {
  const h = await harness();
  try {
    let calls = 0;
    h.engine.handler = async (input) => {
      calls++;
      const data = JSON.parse(leaderEventPrompt(input));
      assert.equal(data.task.requirements, HARD_CONSTRAINT);
      await h.execute(input, "orchestration_decide", {
        action: "wait",
        reason: "需要用户确认。",
      });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    const first = calls;
    assert.equal(first, 1);
    const events = h.store.list<OrchestrationEvent>(TABLE);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.state, "done");
    // Re-entering the same event must reuse the durable receipt, not re-infer.
    await h.worker.tick();
    assert.equal(calls, 1, "a recorded activation is not inferred again");
  } finally {
    h.close();
  }
});

test("oversized mandatory constraints fail typed before any model call and stay intact on disk", async () => {
  const h = await harness();
  try {
    h.engine.contextTokens = 7000;
    const task = h.service.get(actor, h.task.id);
    const requirements = `${HARD_CONSTRAINT}不得删除用户文件；`.repeat(3000);
    task.requirements = requirements;
    h.service.records.save(task);
    await h.worker.tick();
    assert.equal(h.engine.calls.length, 0, "no model call on an irreducible payload");
    const event = h.store.list<OrchestrationEvent>(TABLE)[0];
    assert.equal(event?.error?.code, "orchestration_context_budget");
    assert.equal(
      h.service.get(actor, h.task.id).requirements,
      requirements,
      "the canonical requirements are preserved verbatim",
    );
  } finally {
    h.close();
  }
});
