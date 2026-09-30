import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMessage } from "../../src/app/messages.js";
import { taskInput } from "../../src/app/validation.js";
import { stableId } from "../../src/core/ids.js";
import type { Task, TaskCreateInput } from "../../src/core/types.js";
import { message, setup } from "./helpers.js";

const input: TaskCreateInput = {
  kind: "discussion",
  title: "讨论",
  requirements: "讨论要求",
  participants: [{ kind: "codex" }, { kind: "claude" }],
};

function actor(h: ReturnType<typeof setup>) {
  return {
    source: "feishu" as const,
    ownerId: "owner",
    chatId: "entry",
    sessionId: h.app.sessions.current("owner", "entry").id,
    messageId: "create",
  };
}

test("new discussion defaults to manual without AI; explicit round_robin is rejected", async () => {
  const h = setup(false);
  try {
    const created = await h.app.tasks.create(actor(h), input);
    assert.equal(created.discussion.mode, "manual");
    assert.equal(created.orchestration, undefined);
    await assert.rejects(
      h.app.tasks.create(
        { ...actor(h), messageId: "deprecated" },
        {
          ...input,
          discussion: { mode: "round_robin" },
        },
      ),
      { code: "discussion_mode_deprecated" },
    );
    assert.equal(h.store.list("tasks").length, 1);
  } finally {
    await h.close();
  }
});

test("input validation rejects round_robin with a specific deprecation code", () => {
  assert.throws(() => taskInput({ ...input, discussion: { mode: "round_robin" } }), {
    code: "discussion_mode_deprecated",
  });
  assert.equal(taskInput({ ...input, discussion: { mode: "manual" } }).discussion?.mode, "manual");
  assert.equal(taskInput({ ...input }).discussion, undefined);
});

test("default AI discussion remains workflow when Jev is configured", async () => {
  const h = setup(true);
  assert.ok(h.config.jev);
  h.config.jev.apiKey = "local-test-key";
  try {
    const created = await h.app.tasks.create(actor(h), input);
    assert.equal(created.discussion.mode, "manual");
    assert.equal(created.orchestration?.mode, "workflow");
  } finally {
    await h.close();
  }
});

for (const ai of [false, true]) {
  test(`deprecated commands are consumed before participant or model input: ai=${ai}`, async () => {
    const h = setup(ai);
    try {
      await h.herdr.startAgent("p1", "codex", "p1", { directories: [h.directory] });
      for (const [index, text] of ["/ls", "/card p1", "／card p1"].entries())
        await handleMessage(h.app, h.app.legacy, message(`reject-${index}`, text));
      assert.equal(h.engine.calls.length, 0);
      assert.equal(h.herdr.sends.length, 0);
      assert.equal(h.platform.cards.length, 0);
      assert.equal(h.platform.texts.length, 3);
      assert.ok(h.platform.texts.every((item) => /已弃用.*pi/.test(item.text)));
      assert.equal(h.store.get("legacy_selection", stableId("owner", "entry")), undefined);
      await assert.rejects(h.app.legacy.select("owner", "entry", "p1"), {
        code: "legacy_takeover_deprecated",
      });
    } finally {
      await h.close();
    }
  });
}

test("persisted selection supports card, say, stop, mirror and close without new binding", async () => {
  const h = setup(false);
  try {
    for (const pane of ["p1", "p2"])
      await h.herdr.startAgent(pane, "codex", pane, { directories: [h.directory] });
    const key = stableId("owner", "entry");
    const selected = { ref: await h.herdr.get("p1"), mirror: false, cursor: "original" };
    h.store.set("legacy_selection", key, selected);
    await h.app.legacy.select("owner", "entry", "p1");
    assert.deepEqual(h.store.get("legacy_selection", key), selected);
    await assert.rejects(h.app.legacy.select("owner", "entry", "p2"), {
      code: "legacy_takeover_deprecated",
    });
    await handleMessage(h.app, h.app.legacy, message("other-card", "/card p2"));
    assert.match(h.platform.texts.at(-1)?.text ?? "", /已弃用.*pi/);
    await handleMessage(h.app, h.app.legacy, message("same-card", "/card p1"));
    await handleMessage(h.app, h.app.legacy, message("say", "/say p1 继续"));
    assert.equal(h.herdr.sends.at(-1)?.text, "继续");
    await handleMessage(h.app, h.app.legacy, message("stop", "/stop p1"));
    await handleMessage(h.app, h.app.legacy, message("mirror", "/mirror p1 on"));
    assert.equal(h.store.get<{ mirror: boolean }>("legacy_selection", key)?.mirror, true);
    await handleMessage(h.app, h.app.legacy, message("other-mirror", "/mirror p2 on"));
    assert.equal(
      h.store.get<{ ref: { paneId: string } }>("legacy_selection", key)?.ref.paneId,
      "p1",
    );
    await handleMessage(h.app, h.app.legacy, message("close", "/close"));
    assert.equal(h.store.get("legacy_selection", key), undefined);
    assert.equal(h.herdr.closes, 0);
    await h.app.legacy.handle(message("no-fallback", "不要自动接管"));
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    await h.close();
  }
});

test("persisted round_robin discussion still relays verified output to the next participant", async () => {
  const h = setup(false);
  try {
    const created = await h.app.tasks.create(actor(h), input);
    const persisted = h.store.get<Task>("tasks", created.id);
    assert.ok(persisted);
    persisted.discussion.mode = "round_robin";
    h.store.set("tasks", persisted.id, persisted);
    await h.app.tasks.tick();
    const roster = h.app.tasks.get(actor(h), created.id).participants;
    const first = roster[0];
    const second = roster[1];
    assert.ok(first?.execution);
    assert.ok(second?.execution);
    assert.equal(h.herdr.sends.length, 1);
    h.herdr.finish(first.execution.paneId, "存量协议的第一位观点");
    await h.app.tasks.tick();
    assert.equal(h.herdr.sends.length, 2);
    assert.equal(h.herdr.sends[1]?.pane, second.execution.paneId);
    assert.match(h.herdr.sends[1]?.text ?? "", /存量协议的第一位观点/);
    assert.equal(h.app.tasks.get(actor(h), created.id).discussion.mode, "round_robin");
  } finally {
    await h.close();
  }
});

test("deprecated legacy commands in a task group never reach participant input", async () => {
  const h = setup(false);
  try {
    const created = await h.app.tasks.create(actor(h), input);
    await h.app.tasks.tick();
    const task = h.app.tasks.get(actor(h), created.id);
    assert.ok(task.chatId);
    const before = h.herdr.sends.length;
    for (const [index, text] of ["/ls", "/card p1"].entries())
      await handleMessage(h.app, h.app.legacy, {
        ...message(`group-${index}`, text, task.chatId),
        chatType: "group",
        mentionedBot: true,
      });
    assert.equal(h.herdr.sends.length, before);
    assert.ok(h.platform.texts.slice(-2).every((item) => /已弃用.*pi/.test(item.text)));
  } finally {
    await h.close();
  }
});

test("single-agent fallback cannot create an implicit new takeover", async () => {
  const h = setup(false);
  h.config.tasks.enabled = false;
  try {
    await h.herdr.startAgent("p1", "codex", "p1", { directories: [h.directory] });
    await handleMessage(h.app, h.app.legacy, message("no-selection", "不能自动接管"));
    assert.equal(h.herdr.sends.length, 0);
    assert.match(h.platform.texts.at(-1)?.text ?? "", /已弃用.*pi/);
  } finally {
    await h.close();
  }
});

test("no-AI new command still creates a manual development task", async () => {
  const h = setup(false);
  try {
    await handleMessage(h.app, h.app.legacy, message("new", "/new project codex 实现要求"));
    const tasks = h.app.tasks.list(actor(h));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.discussion.mode, "manual");
    assert.equal(tasks[0]?.kind, "development");
  } finally {
    await h.close();
  }
});
