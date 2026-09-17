import assert from "node:assert/strict";
import { test } from "node:test";
import { Approvals } from "../../src/app/approvals.js";
import { OperationError } from "../../src/core/errors.js";
import type { AgentScreen, ExecutionRef } from "../../src/core/types.js";
import { setup } from "./helpers.js";

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
