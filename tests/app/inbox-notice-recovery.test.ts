import assert from "node:assert/strict";
import test from "node:test";
import { Inbox, type InboxRecord } from "../../src/app/inbox.js";
import { OperationError } from "../../src/core/errors.js";
import type { IncomingMessage } from "../../src/core/types.js";
import { Store } from "../../src/storage/store.js";

const logger = { info() {}, warn() {}, error() {} };
function message(id: string): IncomingMessage {
  return {
    source: "feishu",
    ownerId: "owner",
    chatId: "chat",
    chatType: "private",
    eventId: `event-${id}`,
    messageId: id,
    mentionedBot: false,
    text: "request",
  };
}

test("known-unsent failure notice survives restart and concurrent drains without blocking its chat", async (t) => {
  const clock = Date.parse("2026-09-25T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const store = new Store(":memory:");
  let attempts = 0;
  let completed = 0;
  let startRetry!: () => void;
  const retryStarted = new Promise<void>((resolve) => {
    startRetry = resolve;
  });
  let finishRetry!: () => void;
  const retryDone = new Promise<void>((resolve) => {
    finishRetry = resolve;
  });
  const process = async (record: InboxRecord) => {
    if (record.id === "message:failed")
      throw new OperationError("model_failed", "model unavailable", "unknown");
    completed++;
  };
  const recovery = {
    canRetry: () => false,
    exhausted: async () => {
      if (++attempts === 1) throw new OperationError("platform_unavailable", "Feishu disconnected");
      startRetry();
      await retryDone;
    },
  };
  const inbox = new Inbox(store, process, logger, 8, recovery);
  let restarted: Inbox | undefined;
  try {
    inbox.enqueue("message", "failed", message("failed"));
    await inbox.drain();
    const pending = store.get<InboxRecord>("inbox", "message:failed");
    assert.equal(pending?.failureNotice, "pending");
    assert.equal(pending?.failureNoticeNextAttemptAt, clock + 1000);
    inbox.enqueue("message", "next", message("next"));
    await Promise.all([inbox.drain(), inbox.drain()]);
    assert.equal(completed, 1, "backoff does not hold the failed message's conversation lane");
    assert.equal(attempts, 1);
    await inbox.shutdown();
    restarted = new Inbox(store, process, logger, 8, recovery);
    await restarted.drain();
    assert.equal(attempts, 1, "restart preserves the backoff deadline");
    t.mock.timers.tick(1000);
    const firstDrain = restarted.drain();
    await retryStarted;
    const secondDrain = restarted.drain();
    assert.equal(attempts, 2, "only one drain claims the due notice");
    finishRetry();
    await Promise.all([firstDrain, secondDrain]);
    assert.equal(store.get<InboxRecord>("inbox", "message:failed")?.failureNotice, "delivered");
    await restarted.drain();
    assert.equal(attempts, 2);
  } finally {
    finishRetry();
    await restarted?.shutdown();
    await inbox.shutdown();
    store.close();
  }
});

test("unknown failure-notice delivery is never retried by polls or restart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-25T00:00:00Z") });
  const store = new Store(":memory:");
  let attempts = 0;
  const process = async () => {
    throw new OperationError("model_failed", "unavailable", "unknown");
  };
  const recovery = {
    canRetry: () => false,
    exhausted: async () => {
      attempts++;
      throw new OperationError("delivery_uncertain", "send acknowledgement lost", "unknown");
    },
  };
  const inbox = new Inbox(store, process, logger, 8, recovery);
  let restarted: Inbox | undefined;
  try {
    inbox.enqueue("message", "unknown", message("unknown"));
    await inbox.drain();
    assert.equal(store.get<InboxRecord>("inbox", "message:unknown")?.failureNotice, "attempted");
    t.mock.timers.tick(120_000);
    await Promise.all([inbox.drain(), inbox.drain()]);
    await inbox.shutdown();
    restarted = new Inbox(store, process, logger, 8, recovery);
    await restarted.drain();
    assert.equal(attempts, 1);
  } finally {
    await restarted?.shutdown();
    await inbox.shutdown();
    store.close();
  }
});

test("repeated definite refusal backs off to a capped delay instead of looping inside drain", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-25T00:00:00Z") });
  const store = new Store(":memory:");
  let attempts = 0;
  const inbox = new Inbox(
    store,
    async () => {
      throw new OperationError("model_failed", "offline", "unknown");
    },
    logger,
    8,
    {
      canRetry: () => false,
      retryDelayMs: 0,
      exhausted: async () => {
        attempts++;
        throw new OperationError("platform_unavailable", "disconnected");
      },
    },
  );
  try {
    inbox.enqueue("message", "refused", message("refused"));
    await inbox.drain();
    for (const expectedDelay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const record = store.get<InboxRecord>("inbox", "message:refused");
      assert.equal((record?.failureNoticeNextAttemptAt ?? 0) - Date.now(), expectedDelay);
      const before = attempts;
      await inbox.drain();
      assert.equal(attempts, before);
      t.mock.timers.tick(expectedDelay);
      await inbox.drain();
      assert.equal(attempts, before + 1);
    }
  } finally {
    await inbox.shutdown();
    store.close();
  }
});
