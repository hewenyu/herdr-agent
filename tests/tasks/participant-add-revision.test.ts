import assert from "node:assert/strict";
import test from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import { TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { ActorContext, Task, UserRequestSource } from "../../src/core/types.js";
import type { EngineInput } from "../../src/runtime/types.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "./helpers.js";

const original = "给这个任务新增一位 Codex，独立检查现有结论并继续交付；不要修改文件。";
const privateActor: ActorContext = {
  ...actor,
  source: "feishu",
  chatType: "private",
  messageId: "add-from-main-entry",
};

function ingress(h: ReturnType<typeof setup>, who = privateActor): void {
  h.store.set<InboxRecord>("inbox", `message:${who.messageId}`, {
    id: `message:${who.messageId}`,
    type: "message",
    actor: who,
    payload: {
      source: "feishu",
      eventId: `event:${who.messageId}`,
      messageId: who.messageId,
      ownerId: who.ownerId,
      chatId: who.chatId,
      chatType: "private",
      text: original,
      mentionedBot: false,
    },
    lane: `${who.ownerId}:${who.chatId}`,
    state: "done",
    sequence: 1,
    createdAt: new Date().toISOString(),
  });
}

function revisions(h: ReturnType<typeof setup>) {
  return h.store.entries<{ taskId: string; source: UserRequestSource; at: string }>(
    "task_user_revisions",
  );
}

async function execute(input: EngineInput, name: string, args: Record<string, unknown>) {
  const tool = input.tools.find((entry) => entry.name === name);
  assert.ok(tool);
  return tool.execute(args, input.actor);
}

test("adding a participant from the main private chat wakes a model task with no fresh output", async () => {
  const h = setup();
  h.config.ai.enabled = true;
  try {
    const task = await h.service.create(actor, {
      ...discussion,
      orchestration: { mode: "model" },
      participants: [{ kind: "claude" }],
    });
    await h.service.reconcile(task.id);
    const first = h.service.get(actor, task.id).participants[0];
    assert.ok(first?.execution);
    const engine = new Engine();
    let calls = 0;
    let addedId = "";
    engine.handler = async (input) => {
      const data = JSON.parse(input.prompt);
      if (calls === 0) {
        await execute(input, "participant_send", { participantId: first.id, text: "完成原始讨论" });
      } else if (calls === 1) {
        await execute(input, "orchestration_decide", {
          action: "deliver",
          reason: "已有结论，等待用户验收。",
          outputId: data.authoritativeOutputs[0].entry.id,
        });
      } else {
        assert.equal(data.event.trigger, "user_revision");
        assert.equal(data.event.outputIds.length, 0, "existing output has already been consumed");
        assert.ok(data.userRevisions.some((entry: { text: string }) => entry.text === original));
        await execute(input, "participant_send", { participantId: addedId, text: original });
      }
      calls++;
      return { text: "", messages: [] };
    };
    const worker = new TaskOrchestrator({
      store: h.store,
      engine,
      tasks: () => h.service,
      signal: new AbortController().signal,
      logger,
      tools: () => [
        {
          name: "participant_send",
          description: "send",
          readOnly: false,
          parameters: {},
          execute: async (args, ctx) =>
            h.service.send(ctx, task.id, String(args.participantId), String(args.text)),
        },
      ],
    });
    await worker.tick();
    h.herdr.finish(first.execution.paneId, "初始结论");
    await h.service.reconcile(task.id);
    await worker.tick();
    await worker.tick();
    assert.equal(calls, 2);
    assert.equal(h.service.get(actor, task.id).participants[0]?.initialSent, true);
    ingress(h);
    assert.equal(privateActor.taskId, undefined);
    const added = await h.service.addParticipant(privateActor, task.id, {
      kind: "codex",
      name: "独立检查者",
    });
    addedId = added.id;
    await h.service.reconcile(task.id);
    await worker.tick();
    assert.equal(calls, 3);
    assert.equal(h.herdr.sends.length, 2);
    assert.equal(
      h.herdr.sends[1]?.pane,
      h.service.get(actor, task.id).participants[1]?.execution?.paneId,
    );
    assert.equal(revisions(h)[0]?.[1].source.text, original);
  } finally {
    h.close();
  }
});

test("participant-add retries preserve and repair the authorized revision without duplicates", async () => {
  const h = setup();
  h.config.ai.enabled = true;
  try {
    const task = await h.service.create(actor, { ...discussion, orchestration: { mode: "model" } });
    ingress(h);
    const input = { kind: "codex" as const, name: "追加检查者" };
    const first = await h.service.addParticipant(privateActor, task.id, input);
    const saved = revisions(h);
    assert.equal(saved.length, 1);
    assert.equal((await h.service.addParticipant(privateActor, task.id, input)).id, first.id);
    assert.deepEqual(revisions(h), saved);
    assert.equal(h.service.get(actor, task.id).participants.length, 3);
    h.store.delete("task_user_revisions", saved[0]?.[0] as string);
    assert.equal((await h.service.addParticipant(privateActor, task.id, input)).id, first.id);
    assert.equal(revisions(h).length, 1);
    assert.equal(revisions(h)[0]?.[1].source.text, original);
    assert.equal(h.service.get(actor, task.id).participants.length, 3);
  } finally {
    h.close();
  }
});

test("invalid or rolled-back participant additions do not add user revisions", async () => {
  const h = setup();
  h.config.ai.enabled = true;
  try {
    const task = await h.service.create(actor, { ...discussion, orchestration: { mode: "model" } });
    ingress(h);
    await assert.rejects(
      h.service.addParticipant(privateActor, task.id, { kind: "invalid" as "codex" }),
      { code: "participant_kind" },
    );
    assert.equal(revisions(h).length, 0);
    const save = h.service.records.save.bind(h.service.records);
    h.service.records.save = () => {
      throw new Error("persistence failure");
    };
    await assert.rejects(
      h.service.addParticipant(privateActor, task.id, { kind: "codex" }),
      /persistence failure/,
    );
    h.service.records.save = save;
    assert.equal(revisions(h).length, 0);
    assert.equal(h.service.get(actor, task.id).participants.length, 2);
    const completed = h.store.get<Task>("tasks", task.id);
    assert.ok(completed);
    completed.status = "completed";
    h.store.set("tasks", task.id, completed);
    await assert.rejects(h.service.addParticipant(privateActor, task.id, { kind: "codex" }), {
      code: "task_ended",
    });
    assert.equal(revisions(h).length, 0);
  } finally {
    h.close();
  }
});
