import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { ActorContext, Task } from "../../src/core/types.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { activeTaskOperation } from "../../src/tasks/operation-scope.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, createPersistedTask, discussion, setup } from "./helpers.js";

function request(h: ReturnType<typeof setup>, id = "restart"): ActorContext {
  const who: ActorContext = { ...actor, source: "feishu", chatType: "private", messageId: id };
  h.store.set<InboxRecord>("inbox", `message:${id}`, {
    id: `message:${id}`,
    type: "message",
    actor: who,
    payload: {
      ...who,
      source: "feishu",
      chatType: "private",
      eventId: id,
      text: "重新拉起 Codex 和 Claude，核对现有文件后继续讨论",
      mentionedBot: false,
    },
    lane: "owner",
    state: "done",
    sequence: 1,
    createdAt: new Date().toISOString(),
  });
  return who;
}

async function prepare(h: ReturnType<typeof setup>) {
  h.config.ai.enabled = true;
  const task = await createPersistedTask(h, actor, discussion, {
    orchestration: { mode: "model" },
  });
  await h.service.reconcile(task.id);
  return task;
}

test("explicit replacement keeps unknown input audit and actually unblocks a model task's new opening", async () => {
  const h = setup();
  try {
    const task = await prepare(h);
    h.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    await assert.rejects(h.service.send(actor, task.id, task.participantIds[0], "旧输入"), {
      code: "delivery_unconfirmed",
    });
    const pendingOperation = h.store
      .entries<OperationReceipt>("operations")
      .find(([, receipt]) => receipt.state === "uncertain");
    assert.ok(pendingOperation);
    const [operationId, original] = pendingOperation;
    const firstId = task.participantIds[0];
    assert.ok(firstId);
    h.store.set<OrchestrationEvent>("task_orchestration_events", "old-event", {
      id: "old-event",
      taskId: task.id,
      trigger: "ready",
      userRevision: "old",
      outputIds: [],
      state: "attention",
      attempts: 1,
      dispatches: [{ operationId, participantId: firstId, state: "uncertain" }],
      error: { code: "orchestration_delivery_unknown", message: "未知", outcome: "unknown" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    h.herdr.agents.clear();
    const who = request(h);
    const result = await h.service.restartParticipants(who, task.id, task.participantIds);
    const retired = h.store.get<OperationReceipt>("operations", operationId);
    assert.ok(retired);
    assert.equal(retired.state, "uncertain");
    assert.equal(retired.fingerprint, original.fingerprint);
    assert.equal(retired.retiredByRestart, result.id);
    assert.equal(activeTaskOperation(h.store, task, operationId, retired), false);
    assert.match(await readFile(result.materialPath, "utf8"), /不要重放旧命令/);
    assert.equal(
      h.store.get<OrchestrationEvent>("task_orchestration_events", "old-event")?.dispatches[0]
        ?.state,
      "uncertain",
    );
    assert.equal(
      h.store.get<OrchestrationEvent>("task_orchestration_events", "old-event")?.state,
      "superseded",
    );
    await h.service.restartParticipants(who, task.id, task.participantIds);
    assert.equal(h.herdr.closes, 2, "same request never closes twice or adds a second replacement");
    h.herdr.delivery = { status: "delivered", acked: true, verified: true, attempts: 1 };
    await h.service.reconcile(task.id);
    const current = h.service.get(actor, task.id);
    const active = current.participants.filter((p) => p.status !== "removed");
    assert.equal(active.length, 2);
    assert.ok(active.every((p) => p.started && !p.initialSent));
    const engine = new Engine();
    engine.handler = async (input) => {
      const send = input.tools.find((tool) => tool.name === "participant_send");
      const first = active[0];
      assert.ok(send && first);
      await send.execute({ participantId: first.id, text: "读取恢复材料后继续初稿" }, input.actor);
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
          execute: (args, ctx) =>
            h.service.send(ctx, task.id, String(args.participantId), String(args.text)),
        },
      ],
    });
    await worker.tick();
    assert.equal(h.herdr.sends.length, 2, "old unknown input was not retried");
    assert.equal(h.herdr.sends[1]?.pane, active[0]?.execution?.paneId);
    assert.ok(h.herdr.sends[1]?.text.includes(result.materialPath));
    assert.equal(
      h.service.get(actor, task.id).participants.find((p) => p.id === active[0]?.id)?.initialSent,
      true,
    );
  } finally {
    h.close();
  }
});

test("a crash after closing but before replacement commit resumes closure receipts without duplicate resources", async () => {
  const h = setup();
  try {
    const task = await prepare(h);
    const who = request(h);
    const save = h.service.records.saveParticipant.bind(h.service.records);
    h.service.records.saveParticipant = () => {
      throw new Error("commit failed");
    };
    await assert.rejects(
      h.service.restartParticipants(who, task.id, task.participantIds),
      /commit failed/,
    );
    assert.equal(h.herdr.closes, 2);
    assert.equal(h.service.get(actor, task.id).participantIds.length, 2);
    h.service.records.saveParticipant = save;
    await h.service.restartParticipants(who, task.id, task.participantIds);
    assert.equal(h.herdr.closes, 2);
    assert.equal(
      h.service.get(actor, task.id).participants.filter((p) => p.status !== "removed").length,
      2,
    );
    await h.service.reconcile(task.id);
    assert.equal(h.herdr.starts, 4);
  } finally {
    h.close();
  }
});

test("restart refuses unrelated unknown effects, ended tasks and non-user invocations before closing", async () => {
  const h = setup();
  try {
    const task = await prepare(h);
    const who = request(h);
    await assert.rejects(
      h.service.restartParticipants({ ...who, source: "system" }, task.id, task.participantIds),
      { code: "restart_source" },
    );
    h.store.set("operations", `${task.id}:remote-write`, {
      id: `${task.id}:remote-write`,
      fingerprint: "remote",
      state: "uncertain",
      updatedAt: "now",
    });
    await assert.rejects(h.service.restartParticipants(who, task.id, task.participantIds), {
      code: "restart_effect_unknown",
    });
    assert.equal(h.herdr.closes, 0);
    h.store.set<Task>("tasks", task.id, { ...h.service.get(actor, task.id), status: "destroyed" });
    await assert.rejects(h.service.restartParticipants(who, task.id, task.participantIds), {
      code: "task_ended",
    });
    assert.equal(h.herdr.closes, 0);
  } finally {
    h.close();
  }
});
