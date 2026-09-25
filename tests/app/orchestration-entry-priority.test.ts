import assert from "node:assert/strict";
import test from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { ActorContext, Task } from "../../src/core/types.js";
import type { EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { actor, discussion, setup } from "../tasks/helpers.js";
import { deferred, Engine, logger } from "./helpers.js";

async function harness() {
  const h = setup();
  h.config.ai.enabled = true;
  const created = await h.service.create(actor, {
    ...discussion,
    participants: [{ kind: "codex" }],
    orchestration: { mode: "model" },
  });
  await h.service.reconcile(created.id);
  const task = h.service.get(actor, created.id);
  assert.ok(task.chatId);
  assert.notEqual(task.chatId, task.entryChatId, "the task has a separate group");
  const participant = task.participants[0];
  assert.ok(participant?.execution);
  const engine = new Engine();
  const send = async (input: EngineInput) => {
    const tool = input.tools.find((entry) => entry.name === "participant_send");
    assert.ok(tool);
    await tool.execute({ participantId: participant.id, text: "继续已授权的讨论。" }, input.actor);
    return { text: "", messages: [] };
  };
  engine.handler = send;
  const tools: RuntimeTool[] = [
    {
      name: "participant_send",
      description: "delegate",
      readOnly: false,
      parameters: {},
      execute: async (args, ctx) =>
        h.service.send(ctx, task.id, String(args.participantId), String(args.text)),
    },
  ];
  const worker = new TaskOrchestrator({
    store: h.store,
    tasks: () => h.service,
    tools: () => tools,
    engine,
    signal: new AbortController().signal,
    logger,
    retryDelayMs: 0,
  });
  return { ...h, task, participant, engine, send, worker };
}

function ingress(
  task: Task,
  state: "queued" | "processing",
  options: { ownerId?: string; chatId?: string; bound?: boolean } = {},
): InboxRecord {
  const ownerId = options.ownerId ?? task.ownerId;
  const chatId = options.chatId ?? task.entryChatId;
  const messageId = `entry:${ownerId}:${chatId}`;
  const binding: ActorContext = {
    source: "feishu",
    chatType: "private",
    ownerId,
    chatId,
    sessionId: "main-private-session",
    messageId,
  };
  return {
    id: `message:${messageId}`,
    type: "message",
    payload: {
      source: "feishu",
      eventId: `event:${messageId}`,
      messageId,
      ownerId,
      chatId,
      chatType: "private",
      text: "先核对我的补充要求，再继续。",
      mentionedBot: false,
    },
    ...(options.bound ? { actor: binding } : {}),
    lane: `${ownerId}:${chatId}`,
    state,
    sequence: 1,
    createdAt: new Date().toISOString(),
  };
}

for (const state of ["queued", "processing"] as const)
  test(`${state} main-entry input blocks group task planning and native work until handled`, async () => {
    const h = await harness();
    try {
      const record = ingress(h.task, state, { bound: state === "processing" });
      assert.equal(record.actor?.taskId, undefined);
      h.store.set("inbox", record.id, record);
      await h.worker.tick();
      assert.equal(h.engine.calls.length, 0);
      assert.equal(h.herdr.sends.length, 0);
      h.store.set("inbox", record.id, { ...record, state: "done" });
      await h.worker.tick();
      assert.equal(h.engine.calls.length, 1);
      assert.equal(h.herdr.sends.length, 1);
      assert.equal(h.herdr.sends[0]?.pane, h.participant.execution?.paneId);
    } finally {
      h.close();
    }
  });

test("main-entry input arriving during model planning blocks the final native send and resumes after handling", async () => {
  const h = await harness();
  const entered = deferred();
  const release = deferred();
  try {
    h.engine.handler = async (input) => {
      entered.resolve();
      await release.promise;
      return h.send(input);
    };
    const run = h.worker.tick();
    await entered.promise;
    const record = ingress(h.task, "queued", { bound: true });
    h.store.set("inbox", record.id, record);
    release.resolve();
    await run;
    assert.equal(h.herdr.sends.length, 0);
    const event = h.store.list<OrchestrationEvent>("task_orchestration_events")[0];
    assert.equal(event?.state, "pending");
    assert.equal(event?.attempts, 0, "foreground priority does not consume failure retries");
    await h.worker.tick();
    assert.equal(h.engine.calls.length, 1);
    h.store.set("inbox", record.id, { ...record, state: "done" });
    await h.worker.tick();
    assert.equal(h.engine.calls.length, 2);
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    release.resolve();
    h.close();
  }
});

test("another owner's entry message and the same owner's unrelated chat do not block a task", async () => {
  const h = await harness();
  try {
    for (const record of [
      ingress(h.task, "queued", { ownerId: "other", bound: true }),
      ingress(h.task, "processing", { chatId: "unrelated-private-chat", bound: true }),
    ])
      h.store.set("inbox", record.id, record);
    await h.worker.tick();
    assert.equal(h.engine.calls.length, 1);
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    h.close();
  }
});
