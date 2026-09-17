import assert from "node:assert/strict";
import { test } from "node:test";
import { Inbox, type InboxRecord } from "../../src/app/inbox.js";
import { createLogger } from "../../src/app/logger.js";
import { OperationError } from "../../src/core/errors.js";
import type { IncomingMessage } from "../../src/core/types.js";
import { Store } from "../../src/storage/store.js";

test("inbox logs durable acceptance, duplicates and processing results without body or error details", async () => {
  const store = new Store(":memory:");
  const lines: string[] = [];
  const logs: Record<string, unknown>[] = [];
  let calls = 0;
  const logger = createLogger((line) => {
    lines.push(line);
    const entry = JSON.parse(line) as Record<string, unknown>;
    logs.push(entry);
    if (entry.event === "inbox.accepted")
      assert.equal(store.get<InboxRecord>("inbox", String(entry.inboxId))?.state, "queued");
    if (entry.event === "inbox.completed")
      assert.equal(store.get<InboxRecord>("inbox", String(entry.inboxId))?.state, "done");
  });
  const inbox = new Inbox(
    store,
    async (record) => {
      calls++;
      if (record.id === "message:failed")
        throw new OperationError(
          "test_rejected",
          "private-body https://api.test/?access_key=private-key",
        );
      if (record.id === "message:unknown")
        throw new Error("private-body wss://api.test/?token=private-key");
    },
    logger,
  );
  const message = (id: string): IncomingMessage => ({
    source: "feishu",
    eventId: `event-${id}`,
    messageId: id,
    ownerId: "owner",
    chatId: "chat",
    chatType: "private",
    mentionedBot: false,
    text: "private-body private-key",
  });
  try {
    assert.equal(inbox.enqueue("message", "ok", message("ok")), true);
    assert.equal(inbox.enqueue("message", "ok", message("ok")), false);
    inbox.enqueue("message", "failed", message("failed"));
    inbox.enqueue("message", "unknown", message("unknown"));
    await inbox.drain();
    assert.equal(inbox.enqueue("message", "ok", message("ok")), false);
    await inbox.drain();
    assert.equal(calls, 3);
    const ok = logs.filter((entry) => entry.messageId === "ok");
    assert.deepEqual(
      ok.map((entry) => entry.event),
      [
        "inbox.accepted",
        "inbox.duplicate",
        "inbox.processing",
        "inbox.completed",
        "inbox.duplicate",
      ],
    );
    assert.ok(ok.every((entry) => entry.eventId === "event-ok" && entry.lane === "owner:chat"));
    const results = logs.filter((entry) =>
      ["inbox.completed", "inbox.failed"].includes(String(entry.event)),
    );
    assert.deepEqual(
      results.map((entry) => entry.state),
      ["done", "failed", "uncertain"],
    );
    assert.ok(
      results.every((entry) => typeof entry.durationMs === "number" && entry.durationMs >= 0),
    );
    assert.equal(results[1]?.code, "test_rejected");
    assert.equal(results[2]?.code, "internal_error");
    assert.doesNotMatch(lines.join("\n"), /private-body|private-key|access_key|api\.test/);
  } finally {
    await inbox.shutdown();
    store.close();
  }
});

test("logger excludes transport objects, sensitive fields and URL credentials", () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  logger.info("safe diagnostic https://api.test/?access_key=secret-value", {
    event: "test",
    count: 1,
    ok: true,
    detail: "wss://api.test/?token=secret-value",
    appSecret: "secret-value",
    access_key: "secret-value",
    token: "secret-value",
    url: "https://api.test/?token=secret-value",
    body: "private-body",
    prompt: "private-body",
    details: { nested: "private-body" },
    items: ["private-body"],
    message: "private-body",
  });
  const entry = JSON.parse(lines[0] ?? "{}");
  assert.equal(entry.event, "test");
  assert.equal(entry.count, 1);
  assert.equal(entry.ok, true);
  assert.equal(entry.detail, "[redacted-url]");
  assert.equal(entry.message, "safe diagnostic [redacted-url]");
  assert.doesNotMatch(lines.join("\n"), /secret-value|private-body|api\.test|access_key/);
});
