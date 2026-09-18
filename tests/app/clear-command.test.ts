import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import type { InboxRecord } from "../../src/app/inbox.js";
import { OperationError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/types.js";
import { logger, message, setup } from "./helpers.js";

const success = "CLEAR_NEW_SESSION_OK";

for (const enabled of [true, false]) {
  for (const unavailable of [true, false]) {
    test(`private exact clear rotates without model: ai=${enabled}, unavailable=${unavailable}`, async () => {
      const h = setup(enabled);
      try {
        const old = h.app.sessions.current("owner", "entry");
        if (enabled) {
          await h.app.handlers().message(message("history", "保留旧调度历史"));
          await h.app.inbox.drain();
        }
        const history = h.app.sessions.history("owner", old.id);
        h.engine.calls.length = 0;
        h.platform.texts.length = 0;
        h.engine.handler = async () => {
          if (unavailable) throw new OperationError("model_unavailable", "unavailable");
          return { text: "model must not run", messages: [] };
        };
        await h.app.handlers().message(message("clear", " \n/clear\t "));
        await h.app.inbox.drain();
        const current = h.app.sessions.current("owner", "entry");
        assert.notEqual(current.id, old.id);
        assert.equal(h.app.sessions.get("owner", old.id).archived, true);
        assert.equal(current.archived, false);
        assert.equal(current.summary, "");
        assert.deepEqual(h.app.sessions.history("owner", current.id), []);
        for (const prior of history)
          assert.ok(
            h.app.sessions
              .history("owner", old.id)
              .some((entry) => entry.id === prior.id && entry.text === prior.text),
          );
        assert.deepEqual(
          h.platform.texts.map((entry) => entry.text),
          [success],
        );
        assert.equal(h.store.get<InboxRecord>("inbox", "message:clear")?.state, "done");
        assert.equal(h.engine.calls.length, 0);
        assert.equal(h.herdr.starts, 0);
        assert.equal(h.herdr.sends.length, 0);
        assert.equal(h.herdr.closes, 0);
      } finally {
        await h.close();
      }
    });
  }
}

test("duplicate Feishu clear events rotate once even when their envelope changes", async () => {
  const h = setup();
  try {
    const old = h.app.sessions.current("owner", "entry");
    const event = message("clear-once", "/clear");
    await h.app.handlers().message(event);
    await h.app.handlers().message({ ...event, eventId: "second-envelope" });
    await h.app.inbox.drain();
    const current = h.app.sessions.current("owner", "entry");
    await h.app.handlers().message({ ...event, eventId: "third-envelope" });
    await h.app.inbox.drain();
    assert.notEqual(current.id, old.id);
    assert.equal(h.app.sessions.current("owner", "entry").id, current.id);
    assert.equal(h.app.sessions.list("owner", { archived: true }).length, 2);
    assert.deepEqual(
      h.platform.texts.map((entry) => entry.text),
      [success],
    );
    assert.equal(h.engine.calls.length, 0);
  } finally {
    await h.close();
  }
});

test("queued messages bound before clear are rejected; later messages enter the new session", async () => {
  const h = setup();
  try {
    const old = h.app.sessions.current("owner", "entry");
    await h.app.handlers().message(message("clear", "/clear"));
    await h.app.handlers().message(message("queued-old", "旧会话排队要求"));
    assert.equal(h.store.get<InboxRecord>("inbox", "message:queued-old")?.actor?.sessionId, old.id);
    await h.app.inbox.drain();
    const current = h.app.sessions.current("owner", "entry");
    assert.equal(h.store.get<InboxRecord>("inbox", "message:queued-old")?.state, "failed");
    assert.equal(h.engine.calls.length, 0);
    assert.deepEqual(h.app.sessions.history("owner", current.id), []);
    await h.app.handlers().message(message("new", "新会话要求"));
    await h.app.inbox.drain();
    assert.equal(h.engine.calls.length, 1);
    assert.equal(h.engine.calls[0]?.actor.sessionId, current.id);
    assert.equal(h.engine.calls[0]?.prompt, "新会话要求");
    assert.ok(
      h.app.sessions.history("owner", current.id).some((entry) => entry.text === "新会话要求"),
    );
    assert.ok(
      !h.app.sessions.history("owner", current.id).some((entry) => entry.text === "旧会话排队要求"),
    );
  } finally {
    await h.close();
  }
});

for (const enabled of [true, false]) {
  for (const taskGroup of [true, false]) {
    test(`clear rejects ${taskGroup ? "task" : "ordinary"} group without model or native effects: ai=${enabled}`, async () => {
      const h = setup(enabled);
      try {
        if (taskGroup) {
          const task = (await h.app.dispatch("task.create", {
            kind: "discussion",
            title: "task group",
            requirements: "讨论",
            participants: [{ kind: "claude" }],
            createRemoteTask: false,
            createGroup: false,
          })) as Task;
          h.store.set("tasks", task.id, { ...task, chatId: "group" });
        }
        h.engine.handler = async () => {
          throw new Error("model must not run");
        };
        await h.app.handlers().message({
          ...message("group-clear", "/clear", "group"),
          chatType: "group",
          mentionedBot: true,
        });
        const before = h.app.sessions.list("owner", { archived: true });
        await h.app.inbox.drain();
        assert.deepEqual(h.app.sessions.list("owner", { archived: true }), before);
        assert.deepEqual(
          h.platform.texts.map((entry) => entry.text),
          ["/clear 仅用于主入口私聊或 Web 聊天。"],
        );
        assert.equal(h.store.get<InboxRecord>("inbox", "message:group-clear")?.state, "done");
        assert.equal(h.engine.calls.length, 0);
        assert.equal(h.herdr.starts, 0);
        assert.equal(h.herdr.sends.length, 0);
        assert.equal(h.herdr.closes, 0);
      } finally {
        await h.close();
      }
    });
  }
}

test("quoted clear text cannot rotate a different message body", async () => {
  const h = setup();
  try {
    h.engine.response = "/clear";
    await h.app.handlers().message(message("seed", "请解释这条命令"));
    await h.app.inbox.drain();
    const old = h.app.sessions.current("owner", "entry");
    const prior = h.app.sessions.history("owner", old.id).at(-1);
    assert.ok(prior);
    h.engine.response = "只是解释";
    h.engine.calls.length = 0;
    await h.app.handlers().message({
      ...message("quoted", "这条引用是什么意思"),
      replyToMessageId: prior.deliveryIds[0],
    });
    await h.app.inbox.drain();
    assert.equal(h.app.sessions.current("owner", "entry").id, old.id);
    assert.equal(h.app.sessions.get("owner", old.id).archived, false);
    assert.equal(h.engine.calls.length, 1);
    assert.match(h.engine.calls[0]?.prompt ?? "", /<quoted-message>\n\/clear\n<\/quoted-message>/);
  } finally {
    await h.close();
  }
});

test("clear with arguments, alternate case or embedded syntax remains ordinary conversation", async () => {
  const h = setup();
  try {
    const old = h.app.sessions.current("owner", "entry");
    const inputs = ["/clear now", "请解释 /clear", "/CLEAR", "／clear"];
    for (const [index, text] of inputs.entries())
      await h.app.handlers().message(message(`ordinary-${index}`, text));
    await h.app.inbox.drain();
    assert.deepEqual(
      h.engine.calls.map((call) => call.prompt),
      inputs,
    );
    assert.equal(h.app.sessions.current("owner", "entry").id, old.id);
    assert.equal(h.app.sessions.get("owner", old.id).archived, false);
    assert.ok(h.platform.texts.every((entry) => entry.text !== success));
  } finally {
    await h.close();
  }
});

test("failed selection persistence rolls back rotation and cannot send a success receipt", async () => {
  const h = setup();
  try {
    const old = h.app.sessions.current("owner", "entry");
    await h.app.handlers().message(message("clear-failure", "/clear"));
    const sessions = h.store.entries("sessions");
    const history = h.app.sessions.history("owner", old.id);
    const save = h.store.set.bind(h.store);
    h.store.set = (namespace, key, value) => {
      if (namespace === "session_selection")
        throw new OperationError("state_unavailable", "fixture persistence failure");
      save(namespace, key, value);
    };
    await h.app.inbox.drain();
    h.store.set = save;
    assert.deepEqual(h.store.entries("sessions"), sessions);
    assert.deepEqual(h.app.sessions.history("owner", old.id), history);
    assert.equal(h.app.sessions.current("owner", "entry").id, old.id);
    assert.equal(h.store.entries("turn_receipts").length, 0);
    assert.equal(h.store.entries("session_rotations").length, 0);
    assert.ok(h.platform.texts.every((entry) => entry.text !== success));
    assert.equal(h.engine.calls.length, 0);
  } finally {
    await h.close();
  }
});

for (const enabled of [true, false]) {
  test(`unknown clear reply delivery survives restart without rotation or send replay: ai=${enabled}`, async () => {
    const h = setup(enabled);
    let restarted: Application | undefined;
    try {
      const old = h.app.sessions.current("owner", "entry");
      let attempts = 0;
      const send = h.platform.sendText.bind(h.platform);
      h.platform.sendText = async (chat, text, key) => {
        if (text === success) {
          attempts++;
          throw new OperationError("lost_ack", "unknown delivery", "unknown");
        }
        return send(chat, text, key);
      };
      const event = message("uncertain-clear", "/clear");
      await h.app.handlers().message(event);
      await h.app.inbox.drain();
      const current = h.app.sessions.current("owner", "entry");
      assert.notEqual(current.id, old.id);
      assert.equal(attempts, 1);
      assert.equal(h.app.sessions.list("owner", { archived: true }).length, 2);
      assert.ok(
        h.store
          .list<{ text: string; state: string }>("outbox")
          .some((entry) => entry.text === success && entry.state === "uncertain"),
      );
      await h.app.shutdown();
      restarted = new Application({
        config: h.config,
        store: h.store,
        herdr: h.herdr,
        engine: h.engine,
        platform: h.platform,
        logger,
      });
      await restarted.handlers().message({ ...event, eventId: "duplicate-after-restart" });
      await restarted.inbox.drain();
      assert.equal(restarted.sessions.current("owner", "entry").id, current.id);
      assert.equal(restarted.sessions.list("owner", { archived: true }).length, 2);
      assert.equal(attempts, 1);
      assert.equal(h.engine.calls.length, 0);
    } finally {
      await restarted?.shutdown();
      await h.close();
    }
  });
}

test("disabled AI cannot execute old bound task commands queued behind clear", async () => {
  const h = setup(false);
  try {
    const old = h.app.sessions.current("owner", "entry");
    await h.app.handlers().message(message("clear", "/clear"));
    await h.app.handlers().message(message("queued-task", "/new project codex 旧队列任务不应执行"));
    assert.equal(
      h.store.get<InboxRecord>("inbox", "message:queued-task")?.actor?.sessionId,
      old.id,
    );
    await h.app.inbox.drain();
    assert.equal(h.store.get<InboxRecord>("inbox", "message:queued-task")?.state, "failed");
    assert.deepEqual(h.app.tasks.records.list("owner", true), []);
    assert.equal(h.engine.calls.length, 0);
    assert.equal(h.herdr.sends.length, 0);
    const next = h.app.sessions.current("owner", "entry");
    await h.app.handlers().message(message("new-input", "/tasks"));
    await h.app.inbox.drain();
    assert.equal(h.store.get<InboxRecord>("inbox", "message:new-input")?.actor?.sessionId, next.id);
    assert.equal(h.store.get<InboxRecord>("inbox", "message:new-input")?.state, "done");
  } finally {
    await h.close();
  }
});
