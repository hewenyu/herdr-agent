import assert from "node:assert/strict";
import { test } from "node:test";
import { stableId } from "../../src/core/ids.js";
import { setup } from "./helpers.js";

const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "create" };
const silent = { text: '{"notify":false,"text":""}', messages: [] };

async function readyTask() {
  const h = setup();
  h.engine.handler = async () => silent;
  const task = await h.app.tasks.create(actor, {
    kind: "discussion",
    title: "旧回执恢复",
    requirements: "验证已送达消息后的本地恢复",
    participants: [{ kind: "codex" }],
    keepGroup: false,
  });
  await h.app.tasks.reconcile(task.id);
  return { ...h, task: h.app.tasks.get(actor, task.id) };
}

function receipt(id: string, chatId: string, text: string) {
  return {
    id,
    chatId,
    text,
    parts: [text],
    ids: ["old-delivered-id"],
    state: "delivered",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

for (const kind of ["before_close", "before_group_delete"]) {
  test(`legacy delivered ${kind} recovers missing notice markers without sending again`, async () => {
    const h = await readyTask();
    try {
      const signature = stableId(h.task.id, kind, "destroying", "", "close");
      const id = `notice:${signature}`;
      const text = "已投递的清理通知";
      const saved = receipt(id, h.task.chatId as string, text);
      h.store.set("notice_decisions", signature, { notify: true, text });
      h.store.set("outbox", id, saved);
      await h.app.tasks.action({ ...actor, messageId: "complete" }, h.task.id, "complete");
      await h.app.tasks.reconcile(h.task.id);
      await h.app.tasks.reconcile(h.task.id);
      assert.equal(h.app.tasks.get(actor, h.task.id).status, "destroyed");
      assert.equal(h.platform.texts.length, 0);
      assert.equal(h.herdr.closes, 1);
      assert.equal(h.platform.deletions, 1);
      assert.deepEqual(h.store.get("outbox", id), saved, "no guessed envelope is written");
      assert.deepEqual(h.store.get("notices_done", signature), { notified: true });
      const session = h.app.sessions.forTask(actor.ownerId, h.task.id);
      assert.ok(
        h.app.sessions
          .history(actor.ownerId, session.id)
          .some(
            (message) =>
              message.text === text &&
              message.delivery === "delivered" &&
              message.createdAt === saved.updatedAt,
          ),
      );
    } finally {
      await h.close();
    }
  });
}

for (const wrongChat of [false, true]) {
  test(`legacy final output resumes cleanup only in its recorded chat (changed=${wrongChat})`, async () => {
    const h = await readyTask();
    try {
      const participant = h.app.tasks.records.participants(h.task)[0];
      assert.ok(participant);
      const key = "pending-legacy-output";
      const text = "已送达的最后结果";
      const id = `output:${h.task.id}:${participant.id}:${key}`;
      const saved = receipt(
        id,
        wrongChat ? "other-chat" : (h.task.chatId as string),
        `${participant.name} (${participant.kind})：\n${text}`,
      );
      h.store.set("outbox", id, saved);
      h.store.set("pending_outputs", key, {
        taskId: h.task.id,
        participantId: participant.id,
        entry: { id: "native-entry", role: "assistant", final: true, text },
      });
      const session = h.app.sessions.forTask(actor.ownerId, h.task.id);
      const cleared = h.app.sessions.clear(actor.ownerId, session.id);
      await h.app.tasks.action({ ...actor, messageId: "complete" }, h.task.id, "complete");
      await h.app.tasks.reconcile(h.task.id);
      await h.app.tasks.reconcile(h.task.id);
      assert.equal(h.platform.texts.length, 0, "neither a duplicate nor rerouted send is allowed");
      assert.deepEqual(h.store.get("outbox", id), saved);
      if (wrongChat) {
        assert.equal(h.herdr.closes, 0);
        assert.equal(h.platform.deletions, 0);
        assert.equal(h.store.list("pending_outputs").length, 1);
        assert.match(h.app.tasks.get(actor, h.task.id).syncError ?? "", /发送回执与消息不匹配/);
      } else {
        assert.equal(h.app.tasks.get(actor, h.task.id).status, "destroyed");
        assert.equal(h.herdr.closes, 1);
        assert.equal(h.platform.deletions, 1);
        assert.equal(h.store.list("pending_outputs").length, 0);
        assert.ok(h.store.get("task_outputs", key));
        assert.ok(
          h.app.sessions
            .history(actor.ownerId, session.id)
            .some(
              (message) =>
                message.text.includes(text) &&
                message.delivery === "delivered" &&
                message.createdAt === saved.updatedAt &&
                message.generation === cleared.generation - 1,
            ),
        );
      }
    } finally {
      await h.close();
    }
  });
}
