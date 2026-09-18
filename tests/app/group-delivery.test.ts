import assert from "node:assert/strict";
import { test } from "node:test";
import { canDeleteTaskGroup } from "../../src/app/group-delivery.js";
import type { Task } from "../../src/core/types.js";
import { setup } from "./helpers.js";

test("group deletion waits for inbound reply and every outgoing part, including after restart", async () => {
  const h = setup();
  try {
    const task = { chatId: "test-group", groupDeleted: false } as Task;
    assert.equal(canDeleteTaskGroup(h.store, task), true);
    for (const state of ["queued", "processing", "uncertain"]) {
      h.store.set("inbox", "complete-request", { payload: { chatId: task.chatId }, state });
      assert.equal(canDeleteTaskGroup(h.store, task), false);
    }
    h.store.set("inbox", "complete-request", { payload: { chatId: task.chatId }, state: "done" });
    h.store.set("inbox", "remote-event", { payload: { id: "remote-task" }, state: "processing" });
    h.store.set("inbox", "unrelated", { payload: { chatId: "other" }, state: "processing" });
    assert.equal(canDeleteTaskGroup(h.store, task), true);
    for (const state of ["prepared", "sending", "retryable", "uncertain"]) {
      h.store.set("outbox", "reply", { chatId: task.chatId, state });
      assert.equal(canDeleteTaskGroup(h.store, task), false);
    }
    h.store.set("outbox", "reply", { chatId: task.chatId, state: "delivered" });
    h.store.set("outbox", "unrelated", { chatId: "other", state: "uncertain" });
    assert.equal(canDeleteTaskGroup(h.store, task), true);
  } finally {
    await h.close();
  }
});

test("external group dissolution delivers the last unpolled result to the entry before closing its pane", async () => {
  const h = setup();
  try {
    const actor = {
      ownerId: "owner",
      sessionId: "entry-session",
      chatId: "entry-chat",
      messageId: "new",
    };
    const task = await h.app.tasks.create(actor, {
      kind: "discussion",
      title: "群清理后结果",
      requirements: "只讨论",
      participants: [{ kind: "codex" }],
      keepGroup: false,
    });
    await h.app.tasks.reconcile(task.id);
    const participant = h.app.tasks.records.participants(task)[0];
    assert.ok(participant?.execution);
    h.herdr.finish(participant.execution.paneId, "迟到的完整结果");
    Object.assign(h.platform, { getGroupStatus: async () => "dissolved" as const });
    const close = h.herdr.close.bind(h.herdr);
    h.herdr.close = async (ref) => {
      assert.ok(
        h.platform.texts.some(
          (message) => message.chat === "entry-chat" && message.text.includes("迟到的完整结果"),
        ),
        "the final result must be observed and delivered before herdr closes its pane",
      );
      await close(ref);
    };
    await h.app.tasks.reconcile(task.id);
    const closed = h.app.tasks.records.get(actor, task.id);
    assert.equal(closed.groupDeleted, true);
    assert.equal(closed.status, "destroyed");
    assert.equal(
      closed.completedAt,
      undefined,
      "external group closure does not assert task acceptance",
    );
    assert.equal(h.herdr.closes, 1);
    assert.equal(h.herdr.agents.has(participant.execution.paneId), false);
    assert.equal(h.platform.deletions, 0);
    await h.app.tasks.reconcile(task.id);
    await h.app.tasks.tick();
    const sent = h.platform.texts.filter((message) => message.text.includes("迟到的完整结果"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.chat, "entry-chat");
    assert.equal(h.herdr.closes, 1, "completed cleanup is not replayed");
    const session = h.app.sessions.forTask(actor.ownerId, task.id);
    assert.equal(
      h.app.sessions
        .history(actor.ownerId, session.id)
        .filter(
          (m) =>
            m.role === "participant" &&
            m.delivery === "delivered" &&
            m.text.includes("迟到的完整结果"),
        ).length,
      1,
    );
  } finally {
    await h.close();
  }
});
