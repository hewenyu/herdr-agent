import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationTools } from "../../src/app/tools.js";
import type { StoredMessage } from "../../src/core/types.js";
import { setup } from "./helpers.js";

test("Web chat clear archives and selects a new session while the explicit clear button resets generation", async () => {
  const h = setup();
  try {
    const old = h.app.sessions.create("owner", { name: "旧 Web 会话" });
    h.store.set("web_selection", "owner", old.id);
    h.engine.handler = async (input) => {
      if (input.prompt === "/clear") {
        const tool = input.tools.find((item) => item.name === "session_clear");
        assert.ok(tool);
        const result = await tool.execute({}, input.actor);
        assert.equal((result as { mode: string }).mode, "new_session");
        assert.equal((result as { confirmation: string }).confirmation, "CLEAR_NEW_SESSION_OK");
        assert.equal(h.app.sessions.get("owner", old.id).archived, false);
      }
      return { text: "已安排会话操作", messages: [] };
    };
    const reply = (await h.app.dispatch("chat.send", { text: "/clear" })) as StoredMessage;
    assert.equal(reply.sessionId, old.id);
    assert.equal(h.app.sessions.get("owner", old.id).archived, true);
    assert.equal(h.app.sessions.get("owner", old.id).generation, 0);
    const snapshot = h.app.snapshot();
    const nextId = snapshot.activeSessionId as string;
    assert.notEqual(nextId, old.id);
    assert.notEqual(h.store.get("web_selection", "owner"), old.id);
    assert.equal(h.app.sessions.current("owner", "web:owner").id, nextId);
    await h.app.dispatch("chat.ack", { sessionId: old.id, messageId: reply.id });
    await h.app.dispatch("chat.send", { text: "新会话输入" });
    assert.equal(h.engine.calls.at(-1)?.sessionId, nextId);
    assert.deepEqual(h.engine.calls.at(-1)?.messages, []);
    await h.app.dispatch("session.clear", { id: nextId });
    assert.equal(h.app.sessions.get("owner", nextId).generation, 1);
    assert.equal(h.app.sessions.get("owner", nextId).archived, false);
    assert.equal(h.app.snapshot().activeSessionId, nextId);
    assert.equal(h.herdr.closes, 0);
  } finally {
    await h.close();
  }
});

test("pi exposes scoped archive and restore controls without closing execution resources", async () => {
  const h = setup();
  try {
    const current = h.app.sessions.current("owner", "entry");
    const other = h.app.sessions.create("owner", { name: "可归档" });
    const actor = {
      ownerId: "owner",
      chatId: "entry",
      sessionId: current.id,
      messageId: "archive",
    };
    const tools = applicationTools(h.app, actor);
    const archive = tools.find((tool) => tool.name === "session_archive");
    const restore = tools.find((tool) => tool.name === "session_restore");
    assert.ok(archive && restore);
    await archive.execute({ sessionId: other.id }, actor);
    assert.equal(h.app.sessions.get("owner", other.id).archived, true);
    await restore.execute({ sessionId: other.id }, actor);
    assert.equal(h.app.sessions.get("owner", other.id).archived, false);
    const foreign = h.app.sessions.create("other-owner");
    await assert.rejects(archive.execute({ sessionId: foreign.id }, actor));
    await assert.rejects(restore.execute({ sessionId: foreign.id }, actor));
    const task = h.app.sessions.forTask("owner", "task");
    await assert.rejects(restore.execute({ sessionId: task.id }, actor), /任务会话/);
    const groupTools = applicationTools(h.app, { ...actor, sessionId: task.id, taskId: "task" });
    assert.ok(!groupTools.some((tool) => tool.name.startsWith("session_")));
    assert.equal(h.herdr.closes, 0);
  } finally {
    await h.close();
  }
});
