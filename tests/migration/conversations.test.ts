import assert from "node:assert/strict";
import test from "node:test";
import type { Session, StoredMessage } from "../../src/core/types.js";
import { hash, sessionId } from "../../src/migration/common.js";
import { isLegacyReplay, migrateLegacy } from "../../src/migration/index.js";
import { conversation, fixture } from "./fixtures.js";

test("visible conversations and summaries survive without replaying tools or uncertain delivery", async (t) => {
  const { dir, store, write } = await fixture(t);
  await write(
    "conversations/current.json",
    conversation({
      generation: 3,
      messages: [
        ...conversation().messages,
        { role: "user", content: "待确认请求", turn_id: "pending-message" },
        {
          role: "assistant",
          content: "待确认回复",
          turn_id: "pending-message",
          kind: "delivery_pending",
        },
      ],
      receipts: {
        ...conversation().receipts,
        "pending-message": {
          generation: 3,
          finished: true,
          reply: "待确认回复",
          delivery: "sending",
        },
      },
    }),
  );
  await migrateLegacy(dir, store);
  const id = sessionId("owner", "dm");
  const current = store.get<Session>("sessions", id);
  assert.equal(current?.generation, 3);
  assert.equal(current?.summary, "当前摘要");
  assert.equal(current?.archived, false);
  assert.equal(store.get("session_selection", hash("owner", "dm")), id);
  assert.deepEqual(store.get("memory", id), { summary: "当前摘要", revision: "revision" });
  assert.deepEqual(store.get("summary_cursor", id), { generation: 3, sequence: 0 });
  const messages = store
    .list<StoredMessage & { sequence: number }>("messages")
    .sort((a, b) => a.sequence - b.sequence);
  assert.equal(messages.length, 4);
  assert.equal(messages[1]?.text, "旧回复");
  assert.deepEqual(messages[1]?.deliveryIds, ["sent-id"]);
  assert.equal(messages[3]?.delivery, "uncertain");
  assert.equal(store.get("message_sequence", id), 4);
  assert.equal(
    isLegacyReplay(store, { ownerId: "owner", chatId: "dm", messageId: "pending-message" }),
    true,
  );
  assert.equal(
    isLegacyReplay(store, { ownerId: "stranger", chatId: "dm", messageId: "pending-message" }),
    false,
  );
  assert.equal(
    isLegacyReplay(store, { ownerId: "owner", chatId: "other", messageId: "pending-message" }),
    false,
  );
  assert.deepEqual(store.list("pi_checkpoints"), []);
  assert.deepEqual(store.list("pi_operations"), []);
});

test("clear barrier wins over stale external memory and archived messages remain isolated", async (t) => {
  const { dir, store, write } = await fixture(t);
  const clearedAt = "2026-09-10T00:00:00Z";
  await write(
    "conversations/current.json",
    conversation({
      generation: 4,
      cleared_at: clearedAt,
      messages: [],
      receipts: {},
      memory: { summary: "" },
    }),
  );
  await write("memory/stale.json", {
    version: 1,
    scope: { owner_id: "owner", chat_id: "dm" },
    entry: { summary: "失效摘要" },
  });
  await write("conversations/archive/old/snapshot.json", conversation());
  await write("conversations/archive/old/compact.json", {
    scope: { owner_id: "owner", chat_id: "dm" },
    previous_memory: { summary: "归档摘要", revision: "old" },
    messages: conversation().messages,
  });
  await migrateLegacy(dir, store);
  const id = sessionId("owner", "dm");
  assert.deepEqual(store.get("session_clear", id), { at: clearedAt, generation: 4 });
  assert.equal(store.get<Session>("sessions", id)?.summary, "");
  assert.equal(store.get("message_sequence", id), 0);
  assert.equal(
    store.list<StoredMessage>("messages").filter((message) => message.sessionId === id).length,
    0,
  );
  const archives = store.list<Session>("sessions").filter((session) => session.archived);
  assert.equal(archives.length, 2);
  assert.ok(archives.some((session) => session.summary === "归档摘要"));
  assert.ok(!store.list<Session>("sessions").some((session) => session.summary === "失效摘要"));
  assert.equal(
    isLegacyReplay(store, { ownerId: "owner", chatId: "dm", messageId: "old-message" }),
    true,
  );
});

test("orphan memory remains a visible archive instead of becoming current instructions", async (t) => {
  const { dir, store, write } = await fixture(t);
  await write("memory/orphan.json", {
    version: 1,
    scope: { owner_id: "owner", chat_id: "dm" },
    entry: { summary: "原始摘要" },
  });
  await migrateLegacy(dir, store);
  assert.equal(store.list<Session>("sessions")[0]?.archived, true);
  assert.equal(store.list<Session>("sessions")[0]?.summary, "原始摘要");
  assert.equal(store.get("session_selection", hash("owner", "dm")), undefined);
});

test("duplicate scopes and corrupt delivery receipts cannot overwrite or grant replay", async (t) => {
  for (const changes of [
    { owner: "" },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { messages: [{ role: "tool", content: "execute" }] },
    { pending: "missing" },
    { receipts: { x: { finished: true, reply: "x", delivery: "delivered" } } },
    {
      receipts: {
        x: { finished: true, reply: "x", delivery: "sending", delivery_ids: ["invalid"] },
      },
    },
  ]) {
    const { dir, store, write } = await fixture(t);
    await write("conversations/current.json", conversation(changes));
    await assert.rejects(migrateLegacy(dir, store), { code: "migration_invalid" });
    assert.deepEqual(store.list("sessions"), []);
  }
  const { dir, store, write } = await fixture(t);
  await write("conversations/one.json", conversation());
  await write("conversations/two.json", conversation());
  await assert.rejects(migrateLegacy(dir, store), { code: "migration_invalid" });
});
