import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_OPTIONS_VERSION, Approvals } from "../../src/app/approvals.js";
import { OperationError } from "../../src/core/errors.js";
import type { PlatformPort } from "../../src/core/ports.js";
import type { AgentScreen, ExecutionRef } from "../../src/core/types.js";
import { actor, discussion } from "../tasks/helpers.js";
import { deferred, setup } from "./helpers.js";

const ref: ExecutionRef = { workspaceId: "w", paneId: "p", kind: "claude", cwd: "/project" };
const screen: AgentScreen = {
  text: "current question",
  question: "current question",
  options: [
    { key: "1", label: "红色" },
    { key: "2", label: "蓝色" },
    { key: "3", label: "Type something." },
    { key: "4", label: "Chat about this" },
  ],
  agent: {
    ...ref,
    stateSeq: "274",
    status: "blocked",
    interactiveReady: true,
    launchPending: false,
  },
};

test("changed live option labels retire old nonce before one replacement publication, without keys", async () => {
  const h = setup();
  try {
    let strokes = 0;
    h.herdr.answer = async () => {
      strokes++;
    };
    const first = await h.app.approvals.publish("owner", "chat", ref, screen);
    const changed = {
      ...screen,
      options: [{ key: "1", label: "绿色" }, ...screen.options.slice(1)],
    };
    const updates: string[] = [];
    const platform: PlatformPort = h.platform;
    platform.updateCard = async (id) => {
      updates.push(id);
      await assert.rejects(h.app.approvals.answer("owner", "chat", first.nonce, "1"), /已处理/);
    };
    const [next, same] = await Promise.all([
      h.app.approvals.publish("owner", "chat", ref, changed),
      h.app.approvals.publish("owner", "chat", ref, changed),
    ]);
    assert.notEqual(next.nonce, first.nonce);
    assert.equal(same.nonce, next.nonce);
    assert.deepEqual(updates, [first.messageId]);
    assert.equal(h.platform.cards.length, 2);
    assert.equal(strokes, 0);
    assert.match(JSON.stringify(h.platform.cards[1]?.card), /绿色/);
    const recovered = new Approvals(h.store, h.herdr, () => h.platform);
    const unchanged = await recovered.publish("owner", "chat", ref, {
      ...changed,
      text: "new scrollback",
    });
    assert.equal(unchanged.nonce, next.nonce);
    assert.equal(h.platform.cards.length, 2);
  } finally {
    await h.close();
  }
});

test("E39 legacy wrong key order can refresh, but absent legacy labels are never invented", async () => {
  const h = setup();
  try {
    const old = {
      ...screen,
      options: [{ key: "4", label: "不要完成任务" }, ...screen.options.slice(0, 3)],
    };
    const first = await h.app.approvals.publish("owner", "chat", ref, old);
    delete first.menuFingerprint;
    h.store.set("approvals", first.nonce, first);
    const next = await h.app.approvals.publish("owner", "chat", ref, screen);
    assert.notEqual(next.nonce, first.nonce);
    assert.deepEqual(next.keys, ["1", "2", "3", "4", "esc"]);
    assert.equal(h.store.get<typeof first>("approvals", first.nonce)?.consumed, true);
    delete next.menuFingerprint;
    h.store.set("approvals", next.nonce, next);
    const labelsOnly = {
      ...screen,
      options: screen.options.map((option) => ({ ...option, label: "unknown old label" })),
    };
    assert.equal(
      (await h.app.approvals.publish("owner", "chat", ref, labelsOnly)).nonce,
      next.nonce,
    );
    assert.equal(h.platform.cards.length, 2);
  } finally {
    await h.close();
  }
});

for (const outcome of ["done", "unknown"] as const) {
  test(`changed menu cannot revive consumed ${outcome} key even after expiry`, async () => {
    const h = setup();
    try {
      let strokes = 0;
      h.herdr.answer = async () => {
        strokes++;
        if (outcome === "unknown")
          throw new OperationError("input_unconfirmed", "unknown", "unknown");
      };
      const first = await h.app.approvals.publish("owner", "chat", ref, screen);
      const answer = h.app.approvals.answer("owner", "chat", first.nonce, "1");
      if (outcome === "unknown") await assert.rejects(answer);
      else await answer;
      const stored = h.store.get<typeof first>("approvals", first.nonce);
      assert.ok(stored);
      h.store.set("approvals", first.nonce, { ...stored, expiresAt: "2000-01-01T00:00:00.000Z" });
      const recovered = new Approvals(h.store, h.herdr, () => h.platform);
      const next = await recovered.publish("owner", "chat", ref, {
        ...screen,
        options: screen.options.slice(0, 2),
      });
      assert.equal(next.nonce, first.nonce);
      assert.equal(next.consumed, true);
      assert.equal(h.platform.cards.length, 1);
      assert.equal(strokes, 1);
    } finally {
      await h.close();
    }
  });
}

test("changed menu cannot duplicate an expired card with unknown publication", async () => {
  const h = setup();
  try {
    h.platform.cardHook = async () => {
      throw new OperationError("network", "unknown", "unknown");
    };
    await assert.rejects(h.app.approvals.publish("owner", "chat", ref, screen));
    const nonce = h.platform.cards[0]?.key;
    assert.ok(nonce);
    const stored = h.store.get<Record<string, unknown>>("approvals", nonce);
    h.store.set("approvals", nonce, { ...stored, expiresAt: "2000-01-01T00:00:00.000Z" });
    const recovered = new Approvals(h.store, h.herdr, () => h.platform);
    await assert.rejects(
      recovered.publish("owner", "chat", ref, { ...screen, options: screen.options.slice(0, 2) }),
      /发送结果未知/,
    );
    assert.equal(h.platform.cards.length, 1);
  } finally {
    await h.close();
  }
});

test("cleanup during old card disabling cannot publish the replacement afterwards", async () => {
  const h = setup();
  const entered = deferred(),
    release = deferred();
  let refresh: Promise<unknown> | undefined;
  try {
    await h.app.approvals.publish("owner", "chat", ref, screen);
    h.platform.updateCard = async () => {
      entered.resolve();
      await release.promise;
    };
    refresh = h.app.approvals.publish("owner", "chat", ref, {
      ...screen,
      options: screen.options.slice(0, 2),
    });
    await entered.promise;
    const invalidate = h.app.approvals.invalidate(ref, "task closed");
    release.resolve();
    await Promise.all([refresh, invalidate]);
    assert.equal(h.platform.cards.length, 1);
    assert.ok(
      h.store.list<{ consumed: boolean }>("approvals").every((approval) => approval.consumed),
    );
  } finally {
    release.resolve();
    await refresh;
    await h.close();
  }
});

test("menu changes during publication cannot create another live card until its outcome is known", async () => {
  const h = setup();
  const entered = deferred();
  const release = deferred();
  const pending: Promise<unknown>[] = [];
  try {
    h.platform.cardHook = async () => {
      entered.resolve();
      await release.promise;
      throw new OperationError("network", "unknown", "unknown");
    };
    const publishing = h.app.approvals.publish("owner", "chat", ref, screen);
    pending.push(publishing);
    const rejected = assert.rejects(publishing, /unknown/);
    await entered.promise;
    const first = h.platform.cards[0]?.key;
    const changed = { ...screen, options: screen.options.slice(0, 2) };
    assert.equal(h.app.approvals.create("owner", "chat", ref, changed).nonce, first);
    const refreshing = h.app.approvals.publish("owner", "chat", ref, changed);
    pending.push(refreshing);
    const stillUnknown = assert.rejects(refreshing, /发送结果未知/);
    release.resolve();
    await Promise.all([rejected, stillUnknown]);
    assert.equal(h.platform.cards.length, 1);
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
    await h.close();
  }
});

test("application refreshes the old blocked state once after parser upgrade without sending native input", async () => {
  const h = setup(false);
  try {
    const task = await h.app.tasks.create(actor, {
      ...discussion,
      participants: [{ kind: "claude" }],
    });
    await h.app.tasks.reconcile(task.id);
    const participant = h.app.tasks.get(actor, task.id).participants[0];
    assert.ok(participant?.execution);
    const agent = h.herdr.agents.get(participant.execution.paneId);
    assert.ok(agent);
    agent.status = "blocked";
    participant.status = "blocked";
    participant.lastNotifiedState = agent.stateSeq;
    h.store.set("participants", participant.id, participant);
    const current = { ...screen, agent };
    const old = {
      ...current,
      options: [{ key: "4", label: "old prompt" }, ...screen.options.slice(0, 3)],
    };
    assert.ok(h.app.tasks.get(actor, task.id).chatId);
    const chat = h.app.tasks.get(actor, task.id).chatId as string;
    const previous = await h.app.approvals.publish("owner", chat, participant.execution, old);
    delete previous.menuFingerprint;
    h.store.set("approvals", previous.nonce, previous);
    let reads = 0;
    h.herdr.screen = async () => {
      reads++;
      return current;
    };
    const sends = h.herdr.sends.length;
    await h.app.tasks.reconcile(task.id);
    assert.equal(h.platform.cards.length, 2);
    assert.equal(h.herdr.sends.length, sends);
    assert.equal(
      h.store.get("approval_observation_versions", participant.id),
      APPROVAL_OPTIONS_VERSION,
    );
    const after = reads;
    await h.app.tasks.reconcile(task.id);
    assert.equal(reads, after);
    assert.equal(h.platform.cards.length, 2);
  } finally {
    await h.close();
  }
});
