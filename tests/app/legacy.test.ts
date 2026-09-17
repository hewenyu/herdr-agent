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
