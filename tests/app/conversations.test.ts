import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { StoredMessage } from "../../src/core/types.js";
import { deferred, message, setup } from "./helpers.js";

test("durable inbox pins pi session, deduplicates message identity and isolates owners", async () => {
  const h = setup();
  try {
    const first = h.app.sessions.current("owner", "entry");
    const event = message("first", "开一个讨论");
    await h.app.handlers().message(event);
    const next = h.app.sessions.create("owner", { name: "另一会话" });
    h.app.sessions.select("owner", "entry", next.id);
    await h.app.handlers().message({ ...event, eventId: "other-envelope" });
    await h.app.handlers().message({ ...message("unauthorized", "恶意输入"), ownerId: "other" });
    await h.app.tick();
    assert.equal(h.engine.calls.length, 1);
    assert.equal(h.engine.calls[0]?.actor.sessionId, first.id);
    assert.equal(h.app.sessions.history("owner", next.id).length, 0);
    assert.equal(h.platform.texts.length, 1);
    assert.equal(h.app.sessions.history("owner", first.id).at(-1)?.delivery, "delivered");
  } finally {
    await h.close();
  }
});

test("one slow pi session does not block independent conversations; same chat stays ordered", async () => {
  const h = setup();
  const started = deferred();
  const release = deferred();
  try {
    h.engine.handler = async (input) => {
      if (input.prompt === "slow") {
        started.resolve();
        await release.promise;
      }
      return { text: input.prompt, messages: [] };
    };
    await h.app.handlers().message(message("slow", "slow", "a"));
    await h.app.handlers().message(message("next", "next", "a"));
    const draining = h.app.inbox.drain();
    await started.promise;
    await h.app.handlers().message(message("fast", "fast", "b"));
    const otherDrain = h.app.inbox.drain();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      h.engine.calls.map((call) => call.prompt),
      ["slow", "fast"],
    );
    release.resolve();
    await Promise.all([draining, otherDrain]);
    assert.deepEqual(
      h.engine.calls.map((call) => call.prompt),
      ["slow", "fast", "next"],
    );
  } finally {
    release.resolve();
    await h.close();
  }
});

test("Web reply only becomes visible context after scoped rendering acknowledgement", async () => {
  const h = setup();
  try {
    const first = h.app.sessions.current("owner", "web:owner");
    const answer = (await h.app.dispatch("chat.send", {
      sessionId: first.id,
      text: "先讨论",
    })) as StoredMessage;
    assert.equal(h.app.sessions.history("owner", first.id).at(-1)?.delivery, "sending");
    const other = h.app.sessions.create("owner");
    await assert.rejects(
      h.app.dispatch("chat.ack", { sessionId: other.id, messageId: answer.id }),
      /回执不属于/,
    );
    await h.app.dispatch("chat.send", { sessionId: first.id, text: "继续" });
    assert.match(JSON.stringify(h.engine.calls.at(-1)?.messages), /未确认完整送达/);
    await h.app.dispatch("chat.ack", { sessionId: first.id, messageId: answer.id });
    await h.app.dispatch("chat.ack", { sessionId: first.id, messageId: answer.id });
    assert.equal(
      h.app.sessions.history("owner", first.id).find((m) => m.id === answer.id)?.delivery,
      "delivered",
    );
    h.app.sessions.archive("owner", first.id);
    h.store.set("web_selection", "owner", first.id);
    const state = h.app.snapshot();
    assert.notEqual(state.activeSessionId, first.id);
    await h.app.dispatch("chat.send", { text: "新入口" });
    assert.notEqual(h.engine.calls.at(-1)?.actor.sessionId, first.id);
  } finally {
    await h.close();
  }
});

test("partial Feishu delivery retains acknowledged chunks and cannot advertise a whole-message retry", async () => {
  const h = setup();
  try {
    h.engine.response = "x".repeat(5000);
    h.platform.sendHook = () => {
      if (h.platform.texts.length) throw new OperationError("rate_limit", "稍后再试");
    };
    await h.app.handlers().message(message("partial", "要求"));
    await h.app.inbox.drain();
    const session = h.app.sessions.current("owner", "entry");
    const answer = h.app.sessions.history("owner", session.id).at(-1);
    assert.equal(answer?.delivery, "uncertain");
    assert.deepEqual(answer?.deliveryIds, ["message-1"]);
    assert.equal(h.platform.texts.length, 1);
    await h.app.handlers().message(message("partial", "要求"));
    await h.app.inbox.drain();
    assert.equal(h.engine.calls.length, 1);
  } finally {
    await h.close();
  }
});

test("unknown slash commands get explicit feedback and legacy receipts prevent execution", async () => {
  const h = setup(false);
  try {
    h.store.set("legacy_event_receipts", "msg:event-old", { expiresAt: "2000-01-01" });
    await h.app.handlers().message(message("old", "/new project ignored"));
    await h.app.handlers().message(message("typo", "/destory"));
    await h.app.inbox.drain();
    assert.equal(h.app.tasks.records.list("owner", true).length, 0);
    assert.equal(h.platform.texts.length, 1);
    assert.match(h.platform.texts[0]?.text ?? "", /未知或已精简/);
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    await h.close();
  }
});

test("AI owns every conversational reply including slash syntax and unsupported content", async () => {
  const h = setup();
  try {
    h.engine.response = "这是模型自主决定的回应。";
    for (const [id, text] of [
      ["help", "/help"],
      ["new", "/new project 不要实际创建"],
      ["close", "确认关闭"],
    ]) {
      await h.app.handlers().message(message(id as string, text as string));
    }
    await h.app.handlers().message({ ...message("file", ""), unsupportedType: "file" });
    await h.app.inbox.drain();
    assert.equal(h.engine.calls.length, 4);
    assert.deepEqual(
      h.platform.texts.map((item) => item.text),
      Array(4).fill(h.engine.response),
    );
    assert.equal(h.app.tasks.records.list("owner", true).length, 0);
    assert.match(h.engine.calls.at(-1)?.prompt ?? "", /unsupported_message/);
    assert.ok(
      h.engine.calls[0]?.tools.every(
        (tool) => !/shell|exec|code_edit|approval_answer/.test(tool.name),
      ),
    );
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    await h.close();
  }
});

test("AI transport failure never falls through to templates, terminal input or slash execution", async () => {
  const h = setup();
  try {
    h.engine.handler = async () => {
      throw new OperationError("model_unavailable", "模型不可用");
    };
    await h.app.handlers().message(message("failure", "/new project 不要重投"));
    await h.app.inbox.drain();
    assert.equal(h.platform.texts.length, 0);
    assert.equal(h.herdr.sends.length, 0);
    assert.equal(h.app.tasks.records.list("owner", true).length, 0);
  } finally {
    await h.close();
  }
});

test("one application tick provisions a task created while draining its inbox", async () => {
  const h = setup();
  try {
    h.engine.handler = async (turn) => {
      if (turn.sessionId.startsWith("notice:"))
        return { text: '{"notify":false,"text":""}', messages: [] };
      const create = turn.tools.find((tool) => tool.name === "task_create");
      assert.ok(create);
      await create.execute(
        {
          kind: "development",
          title: "同轮调度任务",
          requirements: "创建一个 HTML 页面。",
          project: "project",
          participants: [{ kind: "codex" }],
          createGroup: true,
          createRemoteTask: false,
        },
        turn.actor,
      );
      return { text: "已登记。", messages: [] };
    };
    await h.app.handlers().message(message("same-tick", "请创建任务"));
    await h.app.tick();
    const task = h.app.tasks.records.list("owner", true)[0];
    assert.ok(task);
    assert.equal(task.chatId, "group1");
    assert.equal(task.status, "running");
    assert.equal(h.platform.groups, 1);
    assert.equal(h.herdr.creates, 1);
  } finally {
    await h.close();
  }
});
