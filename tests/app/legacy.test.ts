import assert from "node:assert/strict";
import { test } from "node:test";
import { stableId } from "../../src/core/ids.js";
import { message, setup } from "./helpers.js";

async function existing() {
  const h = setup(false);
  h.config.tasks.enabled = false;
  h.config.mirrorDefaultOn = true;
  for (const pane of ["p1", "p2"])
    await h.herdr.startAgent(pane, "codex", pane, { directories: [h.directory] });
  return h;
}

test("legacy reply binding outranks selected pane and imported bindings verify agent kind", async () => {
  const h = await existing();
  try {
    await h.app.legacy.select("owner", "entry", "p1");
    h.store.set("legacy_routes", "old-reply", {
      m: "old-reply",
      p: JSON.stringify({ p: "p2", k: "codex", s: "old" }),
      t: "old",
    });
    await h.app.legacy.handle({ ...message("reply", "继续第二位"), replyToMessageId: "old-reply" });
    assert.equal(h.herdr.sends.at(-1)?.pane, "p2");
    h.store.set("legacy_routes", "bad-reply", {
      m: "bad-reply",
      p: JSON.stringify({ p: "p2", k: "claude" }),
      t: "old",
    });
    await assert.rejects(
      h.app.legacy.handle({ ...message("bad", "不要误发"), replyToMessageId: "bad-reply" }),
      /已变化/,
    );
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    await h.close();
  }
});

test("legacy reply binding outranks an explicit pane argument", async () => {
  const h = await existing();
  try {
    const ref = await h.herdr.get("p1");
    h.store.set("legacy_routes", "reply-p1", {
      paneId: ref.paneId,
      workspaceId: ref.workspaceId,
      kind: ref.kind,
      cwd: ref.cwd,
      sessionId: ref.sessionId,
    });
    await h.app.legacy.handle({
      ...message("reply-with-explicit-pane", "/say p2 继续 p1"),
      replyToMessageId: "reply-p1",
    });
    assert.equal(h.herdr.sends.at(-1)?.pane, "p1");
    assert.equal(h.herdr.sends.at(-1)?.text, "继续 p1");
  } finally {
    await h.close();
  }
});

test("legacy raw reply route is rejected after the pane session is replaced", async () => {
  const h = await existing();
  try {
    const ref = await h.herdr.get("p1");
    h.store.set("legacy_routes", "stale-reply", ref);
    const current = h.herdr.agents.get("p1");
    assert.ok(current);
    current.sessionId = "replacement-session";
    await assert.rejects(
      h.app.legacy.handle({ ...message("stale", "不要误发"), replyToMessageId: "stale-reply" }),
      /已变化/,
    );
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    await h.close();
  }
});

test("migrated selection resumes from current output baseline and close cannot resurrect it", async () => {
  const h = await existing();
  try {
    h.store.set("legacy_selection", "entry", { c: "entry", t: { pane: "p1", kind: "codex" } });
    h.herdr.finish("p1", "迁移前已经送达");
    await h.app.legacy.handle(message("continue", "继续当前任务"));
    assert.equal(h.herdr.sends[0]?.pane, "p1");
    await h.app.legacy.tick();
    assert.ok(h.platform.texts.every((item) => !item.text.includes("迁移前")));
    h.herdr.finish("p1", "迁移后的新输出");
    await h.app.legacy.tick();
    assert.ok(h.platform.texts.some((item) => item.text.includes("迁移后的新输出")));
    await h.app.legacy.handle(message("close", "/close"));
    await h.app.legacy.handle(message("unselected", "不能悄悄恢复选择"));
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.store.get("legacy_selection", stableId("owner", "entry")), undefined);
  } finally {
    await h.close();
  }
});

test("invalid old selection does not prevent explicit picker or detach controls", async () => {
  const h = await existing();
  try {
    h.store.set("legacy_selection", "entry", { c: "entry", t: { pane: "gone", kind: "codex" } });
    await h.app.legacy.handle(message("pick", "/ls"));
    await h.app.legacy.handle(message("detach", "/close"));
    assert.equal(h.platform.cards.length, 1);
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    await h.close();
  }
});

test("legacy picker does not offer bare herdr shell panes", async () => {
  const h = await existing();
  try {
    h.herdr.agents.set("shell", {
      paneId: "shell",
      workspaceId: "w-shell",
      status: "idle",
      cwd: h.directory,
      stateSeq: "1",
      interactiveReady: true,
      launchPending: false,
    });
    await h.app.legacy.handle(message("pick-managed", "/ls"));
    const elements = (h.platform.cards[0]?.card.body as { elements?: unknown[] })?.elements;
    assert.ok(elements);
    assert.equal(elements.filter((item) => (item as { tag?: string }).tag === "button").length, 2);
    assert.ok(elements.every((item) => !JSON.stringify(item).includes("shell")));
  } finally {
    await h.close();
  }
});

test("legacy picker explains when no managed agent is available", async () => {
  const h = setup(false);
  h.config.tasks.enabled = false;
  try {
    h.herdr.agents.set("shell", {
      paneId: "shell",
      workspaceId: "w-shell",
      status: "idle",
      cwd: h.directory,
      stateSeq: "1",
      interactiveReady: true,
      launchPending: false,
    });
    await h.app.legacy.handle(message("pick-empty", "/ls"));
    const elements = (h.platform.cards[0]?.card.body as { elements?: unknown[] })?.elements;
    assert.deepEqual(elements, [
      { tag: "markdown", content: "当前没有可接管的 Claude/Codex agent。" },
    ]);
  } finally {
    await h.close();
  }
});

test("legacy notify_chat observes all existing agents without replaying their old outputs", async () => {
  const h = await existing();
  try {
    h.config.feishu.notifyChatId = "notifications";
    h.herdr.finish("p1", "历史结果");
    await h.app.legacy.tick();
    assert.equal(h.platform.texts.length, 0);
    h.herdr.finish("p1", "第一位的新回复");
    h.herdr.finish("p2", "第二位的新回复");
    await h.app.legacy.tick();
    assert.equal(h.platform.texts.length, 2);
    assert.ok(h.platform.texts.every((item) => item.chat === "notifications"));
    await h.app.legacy.tick();
    assert.equal(h.platform.texts.length, 2);
  } finally {
    await h.close();
  }
});
