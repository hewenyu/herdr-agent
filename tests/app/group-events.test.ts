import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import type { InboxRecord } from "../../src/app/inbox.js";
import { OperationError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/types.js";
import { logger, message, setup } from "./helpers.js";

test("disbanded event is durable and deduplicated; restart processes only its matching task", async () => {
  const h = setup(false);
  let restarted: Application | undefined;
  let dissolved = "";
  Object.assign(h.platform, {
    getGroupStatus: async (chatId: string) => (chatId === dissolved ? "dissolved" : "normal"),
  });
  try {
    const tasks: Task[] = [];
    for (const title of ["owned group", "another group"]) {
      const task = (await h.app.dispatch("task.create", {
        kind: "discussion",
        title,
        requirements: "只讨论",
        participants: [{ kind: "codex" }],
        keepGroup: true,
      })) as Task;
      await h.app.tasks.reconcile(task.id);
      tasks.push(h.app.tasks.records.get({ ownerId: "owner", chatId: "entry" }, task.id));
    }
    const target = tasks[0];
    const other = tasks[1];
    assert.ok(target?.chatId && other?.chatId);
    dissolved = target.chatId;
    await h.app.handlers().groupChanged?.(target.chatId);
    await h.app.handlers().groupChanged?.(target.chatId);
    const records = h.store.list<InboxRecord>("inbox");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.type, "group");
    assert.equal(records[0]?.state, "queued");
    assert.deepEqual(records[0]?.payload, { id: target.chatId });
    assert.equal(h.herdr.closes, 0, "event callback only durably registers work");
    await h.app.shutdown();
    restarted = new Application({
      config: h.config,
      store: h.store,
      engine: h.engine,
      herdr: h.herdr,
      platform: h.platform,
      logger,
    });
    await restarted.inbox.drain();
    assert.equal(h.store.list<InboxRecord>("inbox")[0]?.state, "done");
    assert.equal(
      restarted.tasks.records.get({ ownerId: "owner", chatId: "entry" }, target.id).groupDeleted,
      true,
    );
    assert.equal(
      restarted.tasks.records.get({ ownerId: "owner", chatId: "entry" }, target.id).status,
      "destroyed",
    );
    assert.equal(
      restarted.tasks.records.get({ ownerId: "owner", chatId: "entry" }, other.id).groupDeleted,
      false,
    );
    assert.equal(h.herdr.closes, 1);
    assert.equal(h.platform.deletions, 0, "already dissolved group must not be deleted again");
    await restarted.handlers().groupChanged?.(target.chatId);
    await restarted.handlers().groupChanged?.("unmanaged-chat");
    await restarted.inbox.drain();
    assert.equal(h.herdr.closes, 1, "duplicate and unowned events cannot clean another executor");
  } finally {
    await restarted?.shutdown();
    await h.close();
  }
});

test("a disbanded event cannot turn normal or unreadable group state into destructive cleanup", async () => {
  for (const denied of [false, true]) {
    const h = setup(false);
    Object.assign(h.platform, {
      getGroupStatus: async () => {
        if (denied) throw new OperationError("feishu_http_403", "permission denied");
        return "normal";
      },
    });
    try {
      const created = (await h.app.dispatch("task.create", {
        kind: "discussion",
        title: "guarded group",
        requirements: "只讨论",
        participants: [{ kind: "codex" }],
        keepGroup: true,
      })) as Task;
      await h.app.tasks.reconcile(created.id);
      const task = h.app.tasks.records.get({ ownerId: "owner", chatId: "entry" }, created.id);
      assert.ok(task.chatId);
      await h.app.handlers().groupChanged?.(task.chatId);
      await h.app.inbox.drain();
      assert.equal(h.herdr.closes, 0);
      assert.equal(h.platform.deletions, 0);
      const current = h.app.tasks.records.get({ ownerId: "owner", chatId: "entry" }, task.id);
      assert.equal(current.groupDeleted, false);
      assert.notEqual(current.status, "destroyed");
      if (denied) assert.match(current.syncError ?? "", /permission denied/);
    } finally {
      await h.close();
    }
  }
});

test("dissolved group messages and cards never fall through to a main pi session", async () => {
  const h = setup(false);
  try {
    const created = (await h.app.dispatch("task.create", {
      kind: "discussion",
      title: "stale callback",
      requirements: "只讨论",
      participants: [{ kind: "codex" }],
      keepGroup: true,
    })) as Task;
    await h.app.tasks.reconcile(created.id);
    const active = h.app.tasks.records.get({ ownerId: "owner", chatId: "entry" }, created.id);
    assert.ok(active.chatId);
    const group = active.chatId;
    const beforeSessions = h.store.list("sessions").length;
    const beforeMessages = h.store.list("messages").length;
    const beforeEngineCalls = h.engine.calls.length;
    const beforeApprovals = h.store.list("approvals").length;

    // Queue both callbacks while the group is still live, then dissolve it
    // before the durable inbox gets to execute them.
    await h.app.handlers().message({
      ...message("late-message", "旧群消息", group),
      chatType: "group",
      mentionedBot: true,
    });
    await h.app.handlers().action({
      eventId: "late-action",
      ownerId: "owner",
      chatId: group,
      messageId: "card-message",
      value: { action: "approval", nonce: "stale", key: "y" },
    });
    const stored = h.store.get<Task>("tasks", created.id);
    assert.ok(stored);
    stored.groupDeleted = true;
    h.app.tasks.records.save(stored);
    await h.app.inbox.drain();
    assert.equal(h.store.list("sessions").length, beforeSessions);
    assert.equal(h.store.list("messages").length, beforeMessages);
    assert.equal(h.engine.calls.length, beforeEngineCalls);
    assert.equal(h.store.list("approvals").length, beforeApprovals);
    assert.equal(
      h.store.list<InboxRecord>("inbox").every((record) => record.state === "done"),
      true,
    );

    // New callbacks are ignored at ingress and do not create an inbox row.
    const beforeInbox = h.store.list("inbox").length;
    await h.app.handlers().message({
      ...message("after-delete", "继续旧群", group),
      chatType: "group",
      mentionedBot: true,
    });
    await h.app.handlers().action({
      eventId: "after-delete-action",
      ownerId: "owner",
      chatId: group,
      messageId: "after-delete-card",
      value: { action: "approval", nonce: "stale", key: "y" },
    });
    assert.equal(h.store.list("inbox").length, beforeInbox);
  } finally {
    await h.close();
  }
});
