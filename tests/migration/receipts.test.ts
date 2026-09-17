import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAction } from "../../src/feishu/normalize.js";
import { isLegacyReplay, legacyOperation, migrateLegacy } from "../../src/migration/index.js";
import { fixture } from "./fixtures.js";

test("legacy event, card and nonce replay stay blocked even after old expiry", async (t) => {
  const { dir, store, write } = await fixture(t);
  const action = normalizeAction({
    operator: { open_id: "owner" },
    context: { open_chat_id: "chat", open_message_id: "card" },
    action: { tag: "button", value: { nonce: "used-nonce", key: "1" } },
  });
  assert.ok(action);
  await write("dedup.json", {
    version: 1,
    entries: ["msg:old-event", `card:${action.eventId}`, "nonce:used-nonce"].map((k) => ({
      k,
      exp: "2020-01-01T00:00:00Z",
    })),
  });
  await migrateLegacy(dir, store);
  assert.equal(isLegacyReplay(store, { kind: "message", eventId: "old-event" }), true);
  assert.equal(isLegacyReplay(store, { kind: "action", eventId: "old-event" }), false);
  assert.equal(isLegacyReplay(store, { kind: "action", eventId: action.eventId }), true);
  assert.equal(
    isLegacyReplay(store, { kind: "action", eventId: "fresh-id", nonce: "used-nonce" }),
    true,
  );
  assert.equal(isLegacyReplay(store, { kind: "message", eventId: "fresh-id" }), false);
});

test("operation fingerprints, routes, selection, delivery and notification facts are archived", async (t) => {
  const { dir, store, write } = await fixture(t);
  const operation = { fingerprint: "a".repeat(64), done: false };
  await write("assistant-operations.json", {
    version: 1,
    operations: { "owner\0request": operation },
  });
  await write("routes.json", {
    version: 1,
    entries: [{ m: "msg", p: "pane", t: "2026-09-01T00:00:00Z" }],
  });
  await write("selection.json", {
    version: 1,
    entries: [{ c: "chat", t: { pane: "pane", kind: "codex" } }],
  });
  await write("deliveries.json", {
    version: 1,
    receipts: { result: { complete: true }, chunks: { chunks: 2 } },
  });
  const notice = {
    version: 1,
    event_id: "notice",
    owner_id: "owner",
    chat_id: "chat",
    task_id: "task",
    decided: true,
    notify: true,
    sending: true,
    text: "可能已经发送",
  };
  await write("notifications/n.json", notice);
  await migrateLegacy(dir, store);
  assert.deepEqual(legacyOperation(store, "owner", "request"), operation);
  assert.equal(legacyOperation(store, "stranger", "request"), undefined);
  assert.equal(store.list("legacy_routes").length, 1);
  assert.equal(store.list("legacy_selection").length, 1);
  assert.equal(store.list("legacy_deliveries").length, 2);
  assert.deepEqual(store.get("legacy_notifications", "notice"), notice);
  assert.equal(store.list("legacy_sources").length, 5);
  assert.deepEqual(store.list("outbox"), []);
});

test("bad receipts refuse migration without partially importing earlier files", async (t) => {
  for (const [name, data] of [
    [
      "assistant-operations.json",
      { version: 1, operations: { x: { fingerprint: "missing", done: true } } },
    ],
    ["deliveries.json", { version: 1, receipts: { x: { chunks: -1 } } }],
    ["dedup.json", { version: 1, entries: [{ k: "invalid", exp: "yesterday" }] }],
    ["notifications/n.json", { version: 1, event_id: "missing-scope" }],
  ] as const) {
    const { dir, store, write } = await fixture(t);
    await write("conversations/valid.json", {
      version: 1,
      owner: "owner",
      chat: "dm",
      messages: [],
      receipts: {},
    });
    await write(name, data);
    await assert.rejects(migrateLegacy(dir, store), { code: "migration_invalid" });
    assert.deepEqual(store.list("sessions"), []);
    assert.deepEqual(store.list("migrations"), []);
  }
});
