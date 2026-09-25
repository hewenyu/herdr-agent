import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import { Inbox, type InboxRecord, type InboxRecovery } from "../../src/app/inbox.js";
import { Outbox } from "../../src/app/outbox.js";
import { OperationError } from "../../src/core/errors.js";
import { Store } from "../../src/storage/store.js";
import { deferred, logger, message, Platform, setup } from "./helpers.js";

const noticeId = "message:interrupted:interrupted";
const noticeText = "The saved request was interrupted.";

function checkpoint(store: Store, state: InboxRecord["failureNotice"] = "attempted"): InboxRecord {
  const record: InboxRecord = {
    id: "message:interrupted",
    type: "message",
    payload: message("interrupted", "request"),
    state: "failed",
    lane: "owner:entry",
    sequence: 1,
    createdAt: new Date().toISOString(),
    attempts: 3,
    error: { code: "model_failed", message: "model unavailable", outcome: "unknown" },
    failureNotice: state,
    failureNoticeAttempts: state === "attempted" ? 1 : 0,
  };
  store.set("inbox", record.id, record);
  return record;
}

for (const state of [
  "missing",
  "prepared",
  "retryable",
  "delivered",
  "sending",
  "uncertain",
] as const)
  test(`failure-notice checkpoint consults the exact ${state} envelope after restart`, async () => {
    const store = new Store(":memory:");
    const platform = new Platform();
    const outbox = new Outbox(store, () => platform);
    let callbacks = 0;
    const recovery: InboxRecovery = {
      canRetry: () => false,
      exhaustedRetryable: (record) => {
        const receipt = outbox.receipt(`${record.id}:interrupted`);
        return !receipt || ["prepared", "retryable", "delivered"].includes(receipt.state);
      },
      exhausted: async (record) => {
        callbacks++;
        await outbox.send("entry", noticeText, `${record.id}:interrupted`);
      },
    };
    let inbox: Inbox | undefined;
    try {
      if (state !== "missing") {
        const send = platform.sendText.bind(platform);
        if (state !== "delivered")
          platform.sendText = async () => {
            throw new OperationError("fixture_refusal", "not sent");
          };
        await outbox.send("entry", noticeText, noticeId).catch(() => {});
        platform.sendText = send;
        const receipt = store.get<Record<string, unknown>>("outbox", noticeId);
        assert.ok(receipt);
        store.set("outbox", noticeId, { ...receipt, state });
      }
      const record = checkpoint(store);
      inbox = new Inbox(
        store,
        async () => assert.fail("terminal user turn cannot replay"),
        logger,
        8,
        recovery,
      );
      await Promise.all([inbox.drain(), inbox.drain()]);
      await inbox.shutdown();
      inbox = new Inbox(
        store,
        async () => assert.fail("terminal user turn cannot replay"),
        logger,
        8,
        recovery,
      );
      await inbox.drain();
      const blocked = state === "sending" || state === "uncertain";
      assert.equal(callbacks, blocked ? 0 : 1);
      assert.equal(platform.texts.length, blocked ? 0 : 1);
      assert.equal(
        store.get<InboxRecord>("inbox", record.id)?.failureNotice,
        blocked ? "attempted" : "delivered",
      );
      assert.equal(outbox.receipt(noticeId)?.state, blocked ? state : "delivered");
    } finally {
      await inbox?.shutdown();
      store.close();
    }
  });

test("concurrent drains cannot reclaim a live notice callback before its outbox exists", async () => {
  const store = new Store(":memory:");
  const platform = new Platform();
  const outbox = new Outbox(store, () => platform);
  const entered = deferred();
  const release = deferred();
  let callbacks = 0;
  let proofs = 0;
  let processed = 0;
  const record = checkpoint(store, "pending");
  const inbox = new Inbox(
    store,
    async () => {
      processed++;
    },
    logger,
    8,
    {
      canRetry: () => false,
      exhaustedRetryable: () => {
        proofs++;
        return !outbox.receipt(noticeId);
      },
      exhausted: async () => {
        callbacks++;
        entered.resolve();
        await release.promise;
        await outbox.send("entry", noticeText, noticeId);
      },
    },
  );
  let first: Promise<void> | undefined;
  try {
    first = inbox.drain();
    await entered.promise;
    assert.equal(store.get<InboxRecord>("inbox", record.id)?.failureNotice, "attempted");
    assert.equal(outbox.receipt(noticeId), undefined);
    inbox.enqueue("message", "next", message("next", "next request"));
    await Promise.all([inbox.drain(), inbox.drain()]);
    assert.equal(callbacks, 1);
    assert.equal(proofs, 0, "a live callback is not a crashed durable attempt");
    assert.equal(processed, 1, "notification recovery does not occupy the conversation lane");
    release.resolve();
    await first;
    await inbox.drain();
    assert.equal(callbacks, 1);
    assert.equal(platform.texts.length, 1);
  } finally {
    release.resolve();
    if (first) await first;
    await inbox.shutdown();
    store.close();
  }
});

test("a recovered attempt keeps durable refusal backoff across another restart", async (t) => {
  const clock = Date.parse("2026-09-25T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const store = new Store(":memory:");
  const record = checkpoint(store);
  let callbacks = 0;
  const recovery: InboxRecovery = {
    canRetry: () => false,
    exhaustedRetryable: () => true,
    exhausted: async () => {
      if (++callbacks === 1) throw new OperationError("platform_unavailable", "disconnected");
    },
  };
  let inbox = new Inbox(store, async () => {}, logger, 8, recovery);
  try {
    await inbox.drain();
    const saved = store.get<InboxRecord>("inbox", record.id);
    assert.equal(saved?.failureNotice, "pending");
    assert.equal(saved?.failureNoticeNextAttemptAt, clock + 2000);
    await inbox.shutdown();
    inbox = new Inbox(store, async () => {}, logger, 8, recovery);
    await Promise.all([inbox.drain(), inbox.drain()]);
    assert.equal(callbacks, 1);
    t.mock.timers.tick(2000);
    await Promise.all([inbox.drain(), inbox.drain()]);
    assert.equal(callbacks, 2);
    assert.equal(store.get<InboxRecord>("inbox", record.id)?.failureNotice, "delivered");
  } finally {
    await inbox.shutdown();
    store.close();
  }
});

test("Application restores an interrupted notice with no outbox after the attempted checkpoint", async () => {
  const h = setup();
  let restarted: Application | undefined;
  try {
    await h.app.handlers().message(message("interrupted", "request"));
    const record = h.store.get<InboxRecord>("inbox", "message:interrupted");
    assert.ok(record?.actor);
    h.store.set("inbox", record.id, {
      ...record,
      state: "failed",
      attempts: 3,
      failureNotice: "attempted",
      failureNoticeAttempts: 1,
      error: { code: "model_failed", message: "model unavailable", outcome: "unknown" },
    });
    await h.app.shutdown();
    restarted = new Application({
      config: h.config,
      store: h.store,
      herdr: h.herdr,
      engine: h.engine,
      platform: h.platform,
      logger,
    });
    await Promise.all([restarted.tick(), restarted.tick()]);
    await restarted.tick();
    assert.equal(restarted.outbox.receipt(noticeId)?.state, "delivered");
    assert.equal(h.store.get<InboxRecord>("inbox", record.id)?.failureNotice, "delivered");
    assert.equal(h.platform.texts.length, 1);
    assert.equal(h.platform.texts[0]?.chat, "entry");
    assert.equal(
      h.engine.calls.length,
      0,
      "notice recovery does not rerun the failed user request",
    );
  } finally {
    await restarted?.shutdown();
    await h.close();
  }
});
