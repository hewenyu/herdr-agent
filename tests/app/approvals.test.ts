import assert from "node:assert/strict";
import { test } from "node:test";
import { Approvals } from "../../src/app/approvals.js";
import { OperationError } from "../../src/core/errors.js";
import type { HerdrPort, PlatformPort } from "../../src/core/ports.js";
import type { AgentScreen, ExecutionRef } from "../../src/core/types.js";
import { deferred, setup } from "./helpers.js";

const ref: ExecutionRef = {
  workspaceId: "w",
  paneId: "p",
  kind: "codex",
  cwd: "/project",
  sessionId: "s",
};
const screen: AgentScreen = {
  text: "需要确认",
  question: "允许访问？",
  options: [{ key: "1", label: "允许" }],
  agent: {
    ...ref,
    stateSeq: "18446744073709551615",
    status: "blocked",
    interactiveReady: true,
    launchPending: false,
  },
};

test("approval consumption survives callbacks racing publication and repeat publication", async () => {
  const h = setup();
  try {
    let answers = 0;
    h.herdr.answer = async () => {
      answers++;
    };
    h.platform.cardHook = (nonce) => h.app.approvals.answer("owner", "chat", nonce, "1");
    const approval = await h.app.approvals.publish("owner", "chat", ref, screen);
    assert.equal(approval.consumed, true);
    const published = await h.app.approvals.publish("owner", "chat", ref, screen);
    assert.equal(published.nonce, approval.nonce);
    assert.equal(h.platform.cards.length, 1);
    assert.equal(answers, 1);
    await assert.rejects(h.app.approvals.answer("owner", "chat", approval.nonce, "1"), /已处理/);
  } finally {
    await h.close();
  }
});

test("unknown approval keys and foreign scopes cannot consume a valid nonce", async () => {
  const h = setup();
  try {
    let answers = 0;
    h.herdr.answer = async () => {
      answers++;
      throw new OperationError("input_unconfirmed", "已尝试", "unknown");
    };
    const approval = h.app.approvals.create("owner", "chat", ref, screen);
    await assert.rejects(h.app.approvals.answer("other", "chat", approval.nonce, "1"), /不属于/);
    await assert.rejects(h.app.approvals.answer("owner", "other", approval.nonce, "1"), /不属于/);
    await assert.rejects(
      h.app.approvals.answer("owner", "chat", approval.nonce, "y"),
      /没有此选项/,
    );
    assert.equal(answers, 0);
    await assert.rejects(h.app.approvals.answer("owner", "chat", approval.nonce, "1"), /已尝试/);
    const recovered = new Approvals(h.store, h.herdr, () => h.platform);
    await assert.rejects(recovered.answer("owner", "chat", approval.nonce, "1"), /已处理/);
    assert.equal(answers, 1);
  } finally {
    await h.close();
  }
});

test("uncertain card sends cannot be silently repeated after restart", async () => {
  const h = setup();
  try {
    h.platform.cardHook = async () => {
      throw new OperationError("network", "结果未知", "unknown");
    };
    await assert.rejects(h.app.approvals.publish("owner", "chat", ref, screen), /结果未知/);
    const recovered = new Approvals(h.store, h.herdr, () => h.platform);
    await assert.rejects(recovered.publish("owner", "chat", ref, screen), /发送结果未知/);
    assert.equal(h.platform.cards.length, 1);
  } finally {
    await h.close();
  }
});

const menu: AgentScreen = {
  ...screen,
  text: "❯ No, exit\n  Yes, I trust this folder",
  question: "❯ No, exit\n  Yes, I trust this folder",
  options: [
    { key: "up", label: "上移选择（不确认）" },
    { key: "down", label: "下移选择（不确认）" },
    { key: "enter", label: "确认当前选项" },
  ],
};

test("successful navigation rereads the menu and issues a fresh card even when stateSeq does not change", async () => {
  const h = setup();
  try {
    const strokes: string[] = [];
    const moved = { ...menu, text: "No, exit\n❯ Yes, I trust this folder", question: "已选中 Yes" };
    let reads = 0;
    const herdr: HerdrPort = h.herdr;
    herdr.answer = async (_ref, key) => {
      strokes.push(key);
    };
    h.herdr.screen = async () => {
      reads++;
      return moved;
    };
    const first = await h.app.approvals.publish("owner", "chat", ref, menu);
    const sibling = h.app.approvals.create("owner", "another-chat", ref, menu);
    await h.app.approvals.answer("owner", "chat", first.nonce, "down");
    assert.equal(reads, 1);
    assert.equal(h.platform.cards.length, 2);
    assert.match(JSON.stringify(h.platform.cards[1]?.card), /已选中 Yes/);
    const next = h.app.approvals.create("owner", "chat", ref, moved);
    assert.notEqual(next.nonce, first.nonce);
    assert.equal(next.consumed, false);
    await assert.rejects(h.app.approvals.answer("owner", "chat", first.nonce, "enter"), /已处理/);
    await assert.rejects(
      h.app.approvals.answer("owner", "another-chat", sibling.nonce, "enter"),
      /已处理/,
    );
    await h.app.approvals.answer("owner", "chat", next.nonce, "enter");
    assert.deepEqual(strokes, ["down", "enter"]);
    await h.app.approvals.publish("owner", "chat", ref, moved);
    assert.equal(h.platform.cards.length, 2, "a confirmation must not issue another live nonce");
  } finally {
    await h.close();
  }
});

test("automatic invalidation consumes cards before an in-flight publication completes", async () => {
  const h = setup();
  const entered = deferred();
  const release = deferred();
  let publishing: Promise<unknown> | undefined;
  try {
    const updates: string[] = [];
    const platform: PlatformPort = h.platform;
    platform.updateCard = async (_id, card) => {
      updates.push(JSON.stringify(card));
    };
    h.platform.cardHook = async () => {
      entered.resolve();
      await release.promise;
    };
    const other = { ...ref, paneId: "another-pane" };
    const otherCard = h.app.approvals.create("owner", "chat", other, {
      ...menu,
      agent: { ...menu.agent, paneId: other.paneId },
    });
    publishing = h.app.approvals.publish("owner", "chat", ref, menu);
    await entered.promise;
    const nonce = h.platform.cards[0]?.key ?? "";
    await h.app.approvals.invalidate(ref, "pi 已确认目录信任，原卡片失效。");
    await assert.rejects(h.app.approvals.answer("owner", "chat", nonce, "enter"), /已处理/);
    release.resolve();
    await publishing;
    assert.ok(updates.some((update) => update.includes("pi 已确认目录信任")));
    assert.equal(h.app.approvals.create("owner", "chat", ref, menu).consumed, true);
    const currentOther = h.app.approvals.create("owner", "chat", other, {
      ...menu,
      agent: { ...menu.agent, paneId: other.paneId },
    });
    assert.equal(currentOther.nonce, otherCard.nonce);
    assert.equal(currentOther.consumed, false);
  } finally {
    release.resolve();
    await publishing;
    await h.close();
  }
});

test("invalidation during navigation readback cannot revive a card", async () => {
  const h = setup();
  const entered = deferred();
  const release = deferred();
  let navigating: Promise<void> | undefined;
  try {
    h.herdr.screen = async () => {
      entered.resolve();
      await release.promise;
      return menu;
    };
    const first = await h.app.approvals.publish("owner", "chat", ref, menu);
    navigating = h.app.approvals.answer("owner", "chat", first.nonce, "down");
    await entered.promise;
    await h.app.approvals.invalidate(ref, "目录信任已自动完成。");
    release.resolve();
    await navigating;
    assert.equal(h.platform.cards.length, 1);
    assert.equal(h.app.approvals.create("owner", "chat", ref, menu).consumed, true);
  } finally {
    release.resolve();
    await navigating;
    await h.close();
  }
});

test("two old cards cannot navigate and confirm concurrently at an unchanged stateSeq", async () => {
  const h = setup();
  const entered = deferred();
  const release = deferred();
  const strokes: string[] = [];
  const operations: Promise<void>[] = [];
  try {
    const herdr: HerdrPort = h.herdr;
    herdr.answer = async (_ref, key) => {
      strokes.push(key);
      if (key === "down") {
        entered.resolve();
        await release.promise;
      }
    };
    h.herdr.screen = async () => menu;
    const first = h.app.approvals.create("owner", "chat", ref, menu);
    const sibling = h.app.approvals.create("owner", "other-chat", ref, menu);
    operations.push(h.app.approvals.answer("owner", "chat", first.nonce, "down"));
    await entered.promise;
    const duplicate = assert.rejects(
      h.app.approvals.answer("owner", "other-chat", sibling.nonce, "enter"),
      /已处理/,
    );
    release.resolve();
    await Promise.all([...operations, duplicate]);
    assert.deepEqual(strokes, ["down"]);
  } finally {
    release.resolve();
    await Promise.allSettled(operations);
    await h.close();
  }
});

test("navigation from a Web-only approval refreshes its nonce without publishing a group card", async () => {
  const h = setup();
  try {
    h.herdr.screen = async () => menu;
    const first = h.app.approvals.create("owner", "web:owner", ref, menu);
    await h.app.approvals.answer("owner", "web:owner", first.nonce, "up");
    const next = h.app.approvals.create("owner", "web:owner", ref, menu);
    assert.notEqual(
      next.nonce,
      first.nonce,
      "navigation at a menu boundary still needs a new nonce",
    );
    assert.equal(next.consumed, false);
    assert.equal(h.platform.cards.length, 0);
  } finally {
    await h.close();
  }
});

test("an unknown navigation result cannot republish a live card or repeat the key", async () => {
  const h = setup();
  try {
    let strokes = 0;
    h.herdr.answer = async () => {
      strokes++;
      throw new OperationError("input_unconfirmed", "未知", "unknown");
    };
    const first = await h.app.approvals.publish("owner", "chat", ref, menu);
    await assert.rejects(h.app.approvals.answer("owner", "chat", first.nonce, "down"));
    const next = await h.app.approvals.publish("owner", "chat", ref, menu);
    assert.equal(next.nonce, first.nonce);
    assert.equal(next.consumed, true);
    assert.equal(h.platform.cards.length, 1);
    await assert.rejects(h.app.approvals.answer("owner", "chat", next.nonce, "down"));
    assert.equal(strokes, 1);
  } finally {
    await h.close();
  }
});
