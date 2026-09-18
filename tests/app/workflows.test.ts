import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredMessage, Task } from "../../src/core/types.js";
import { message, setup } from "./helpers.js";

const input = {
  kind: "discussion",
  title: "讨论重构",
  requirements: "仅讨论，不编写代码；每个文件不超过1000行。",
  participants: [
    { kind: "claude", name: "Claude" },
    { kind: "codex", name: "Codex" },
  ],
};

test("pi tools create a real task flow, herdr owns agents, notification decisions never enter user authority", async () => {
  const h = setup();
  try {
    h.engine.handler = async (turn) => {
      if (turn.sessionId.startsWith("notice:")) {
        assert.ok(turn.tools.every((tool) => tool.readOnly));
        return { text: '{"notify":true,"text":"模型选择的通知内容"}', messages: [] };
      }
      const tool = turn.tools.find((item) => item.name === "task_create");
      assert.ok(tool);
      const created = await tool.execute(input, turn.actor);
      return { text: `已登记 ${JSON.stringify(created)}`, messages: [] };
    };
    await h.app.handlers().message(message("create", "让Claude与Codex讨论重构"));
    await h.app.inbox.drain();
    const task = h.app.tasks.records.list("owner")[0];
    assert.ok(task);
    assert.equal(h.herdr.creates, 0);
    await h.app.tasks.reconcile(task.id);
    assert.equal(h.herdr.creates, 2);
    assert.equal(h.herdr.starts, 2);
    assert.equal(h.herdr.sends.length, 1);
    assert.match(h.herdr.sends[0]?.text ?? "", /仅讨论，不编写代码；每个文件不超过1000行/);
    const session = h.app.sessions.forTask("owner", task.id);
    const history = h.app.sessions.history("owner", session.id);
    assert.ok(history.length > 0);
    assert.ok(history.every((entry) => entry.role !== "user" && !entry.text.includes('"notify"')));
    assert.ok(history.every((entry) => entry.delivery === "delivered"));
    assert.ok(h.platform.texts.some((entry) => entry.text === "模型选择的通知内容"));
    const live = { participants: h.app.tasks.records.participants(task) };
    h.herdr.finish(live.participants[0]?.execution?.paneId ?? "", "讨论结论（参与者自述）");
    await h.app.tasks.reconcile(task.id);
    assert.equal(h.herdr.sends.length, 2);
    assert.match(h.herdr.sends[1]?.text ?? "", /讨论结论/);
    assert.ok(
      h.app.sessions.history("owner", session.id).some((entry) => entry.role === "participant"),
    );
    await h.app.handlers().message(message("create", "重复事件"));
    await h.app.inbox.drain();
    assert.equal(h.app.tasks.records.list("owner", true).length, 1);
  } finally {
    await h.close();
  }
});

test("Web-only participant output stays unconfirmed until visible session acknowledges it", async () => {
  const h = setup(false, false);
  try {
    const task = (await h.app.dispatch("task.create", {
      ...input,
      participants: [{ kind: "codex" }],
      createGroup: false,
      createRemoteTask: false,
    })) as Task;
    await h.app.tasks.reconcile(task.id);
    const participant = h.app.tasks.records.participants(task)[0];
    h.herdr.finish(participant?.execution?.paneId ?? "", "已提出讨论方案");
    await h.app.tasks.reconcile(task.id);
    const session = h.app.sessions.forTask("owner", task.id);
    const output = h.app.sessions
      .history("owner", session.id)
      .find((entry) => entry.role === "participant") as StoredMessage;
    assert.ok(output);
    assert.equal(output.delivery, "prepared");
    await h.app.dispatch("chat.ack", { sessionId: session.id, messageId: output.id });
    assert.equal(
      h.app.sessions.history("owner", session.id).find((entry) => entry.id === output.id)?.delivery,
      "delivered",
    );
  } finally {
    await h.close();
  }
});

test("identical participant display names require an ID and never silently choose the first", async () => {
  const h = setup(false, false);
  try {
    const task = (await h.app.dispatch("task.create", {
      ...input,
      createGroup: false,
      createRemoteTask: false,
      participants: [
        { kind: "codex", name: "reviewer" },
        { kind: "codex", name: "reviewer" },
      ],
    })) as Task;
    await h.app.tasks.reconcile(task.id);
    const sends = h.herdr.sends.length;
    await assert.rejects(
      h.app.dispatch("participant.send", {
        taskId: task.id,
        participantId: "reviewer",
        text: "开始",
      }),
      /同名/,
    );
    assert.equal(h.herdr.sends.length, sends);
    await h.app.dispatch("participant.send", {
      taskId: task.id,
      participantId: task.participantIds[1],
      text: "评审",
    });
    assert.equal(h.herdr.sends.length, sends + 1);
  } finally {
    await h.close();
  }
});
