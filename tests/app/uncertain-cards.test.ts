import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type UncertainCard, UncertainCards } from "../../src/app/uncertain-cards.js";
import { uncertainCandidates } from "../../src/app/uncertain-choice.js";
import { OperationError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/types.js";
import { Store } from "../../src/storage/store.js";
import { Platform } from "./helpers.js";

function setup() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "uncertain-card-")));
  const store = new Store(join(directory, "state.sqlite"));
  const platform = new Platform();
  store.set("tasks", "task", { id: "task", participantIds: [] } as unknown as Task);
  store.set("operations", "task:send:op", {
    id: "task:send:op",
    state: "uncertain",
    fingerprint: "op",
    updatedAt: new Date().toISOString(),
  });
  const applied: string[] = [];
  let current = true;
  const cards = new UncertainCards(
    store,
    () => platform,
    async (_card, choice) => {
      applied.push(choice);
    },
    () => current,
  );
  const request = {
    operationId: "task:send:op",
    taskId: "task",
    ownerId: "owner",
    chatId: "chat",
    step: "pane close",
    evidence: { source: "herdr", status: "unknown" },
    candidates: uncertainCandidates,
  };
  return {
    store,
    platform,
    cards,
    request,
    applied,
    stale: () => {
      current = false;
    },
    close: () => {
      store.close();
      assert.equal(realpathSync(directory), directory);
      assert.ok(directory.startsWith(`${realpathSync(tmpdir())}/uncertain-card-`));
      rmSync(directory, { recursive: true });
    },
  };
}

test("uncertain card binds owner chat nonce candidates expiry and current task", async () => {
  const h = setup();
  try {
    const card = await h.cards.publish(h.request);
    assert.match(JSON.stringify(h.platform.cards[0]?.card), /重复副作用风险/);
    for (const [owner, chat, nonce, choice] of [
      ["other", "chat", card.nonce, "retry_once"],
      ["owner", "other", card.nonce, "retry_once"],
      ["owner", "chat", "foreign", "retry_once"],
      ["owner", "chat", card.nonce, "bad"],
    ] as const)
      await assert.rejects(h.cards.answer(owner, chat, nonce, choice));
    h.store.set("uncertain_cards", card.nonce, { ...card, expiresAt: new Date(0).toISOString() });
    await assert.rejects(h.cards.answer("owner", "chat", card.nonce, "retry_once"), /过期/);
    h.store.set("uncertain_cards", card.nonce, card);
    h.stale();
    await assert.rejects(h.cards.answer("owner", "chat", card.nonce, "retry_once"), /失效/);
    assert.deepEqual(h.applied, []);
    assert.equal(h.store.get<UncertainCard>("uncertain_cards", card.nonce)?.consumed, false);
  } finally {
    h.close();
  }
});

test("uncertain card publication races consume once and never restore the nonce", async () => {
  const h = setup();
  try {
    h.platform.cardHook = (nonce) => h.cards.answer("owner", "chat", nonce, "retry_once");
    const card = await h.cards.publish(h.request);
    assert.equal(card.consumed, true);
    assert.deepEqual(h.applied, ["retry_once"]);
    await assert.rejects(h.cards.answer("owner", "chat", card.nonce, "retry_once"), /已处理/);
    await h.cards.publish(h.request);
    assert.equal(h.platform.cards.length, 1);
  } finally {
    h.close();
  }
});

test("uncertain card unknown publication cannot be repeated across resolver restart", async () => {
  const h = setup();
  try {
    h.platform.cardHook = async () => {
      throw new OperationError("network", "unknown", "unknown");
    };
    await assert.rejects(h.cards.publish(h.request));
    const restarted = new UncertainCards(
      h.store,
      () => h.platform,
      async () => {
        assert.fail("must not apply");
      },
    );
    await assert.rejects(restarted.publish(h.request), /发送结果未知/);
    assert.equal(h.platform.cards.length, 1);
  } finally {
    h.close();
  }
});

test("uncertain card consumed decision stays consumed even if application fails", async () => {
  const h = setup();
  try {
    const card = await h.cards.publish(h.request);
    let attempts = 0;
    const failing = new UncertainCards(
      h.store,
      () => h.platform,
      async () => {
        attempts++;
        throw new Error("effect failed");
      },
    );
    await assert.rejects(failing.answer("owner", "chat", card.nonce, "abandon_step"));
    await assert.rejects(failing.answer("owner", "chat", card.nonce, "abandon_step"), /已处理/);
    assert.equal(attempts, 1);
  } finally {
    h.close();
  }
});
