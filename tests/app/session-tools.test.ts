import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationTools } from "../../src/app/tools.js";
import { setup } from "./helpers.js";

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
