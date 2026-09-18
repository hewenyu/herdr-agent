import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredMessage } from "../../src/core/types.js";
import type { WebState } from "../../src/web/contracts.js";
import { startWeb } from "../../src/web/index.js";
import { deferred, setup } from "./helpers.js";

test("browsing an empty history never creates an entry session or selection", async () => {
  const h = setup();
  try {
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(h.app.history().sessions, []);
      assert.deepEqual(h.app.history().messages, []);
      assert.deepEqual(h.store.entries("sessions"), []);
      assert.deepEqual(h.store.entries("session_selection"), []);
      assert.deepEqual(h.store.entries("web_selection"), []);
    }
    assert.equal(h.engine.calls.length, 0);
  } finally {
    await h.close();
  }
});

test("tool history orders rounds by time and preserves each round's call/result sequence", async () => {
  const h = setup();
  try {
    const session = h.app.sessions.create("owner");
    for (const [id, time, name] of [
      ["a-later", "2026-09-18T02:00:00Z", "later"],
      ["z-earlier", "2026-09-18T01:00:00Z", "earlier"],
    ]) {
      h.store.set("pi_checkpoints", id as string, {
        sessionId: session.id,
        updatedAt: time,
        messages: Array.from({ length: 12 }, (_, index) => ({
          role: "toolResult",
          toolCallId: `${name}-${index}`,
          toolName: `${name}-${index}`,
          content: [],
          isError: false,
        })),
      });
    }
    assert.deepEqual(
      h.app.history().records?.map((record) => (record.data as { name: string }).name),
      ["earlier", "later"].flatMap((name) =>
        Array.from({ length: 12 }, (_, index) => `${name}-${index}`),
      ),
    );
  } finally {
    await h.close();
  }
});

test("HTTP record browsing isolates identities and never changes sessions or delivery", async () => {
  const h = setup(true, false);
  h.config.feishu.allowedOpenIds = ["owner", "owner-second"];
  const first = h.app.sessions.create("owner", { name: "第一身份" });
  const archived = h.app.sessions.create("owner", { name: "已归档" });
  h.app.sessions.archive("owner", archived.id);
  const second = h.app.sessions.create("owner-second", { name: "第二身份" });
  const makeMessage = (sessionId: string, id: string, text: string): StoredMessage => ({
    id,
    sessionId,
    text,
    role: "assistant",
    source: "feishu",
    createdAt: new Date().toISOString(),
    delivery: "sending",
    deliveryIds: [],
    generation: 0,
  });
  const firstReply = makeMessage(first.id, "first-message", "第一身份正文");
  for (const m of [
    firstReply,
    makeMessage(archived.id, "archived-message", "旧历史"),
    makeMessage(second.id, "second-message", "第二身份正文"),
  ])
    h.store.set("messages", m.id, m);
  h.store.set("web_identity", "selected", "owner-second");
  h.store.set("web_selection", "owner", second.id);
  h.config.ai.apiKey = "test-model-secret";
  h.store.set("pi_checkpoints", "first-turn", {
    sessionId: first.id,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "task_get",
            arguments: { id: "task", apiKey: "different-secret" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "task_get",
        isError: false,
        content: [{ type: "text", text: "test-model-secret" }],
      },
    ],
  });
  h.store.set("pi_checkpoints", "second-turn", {
    sessionId: second.id,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-other",
            name: "task_get",
            arguments: { id: "private-other-task" },
          },
        ],
      },
    ],
  });
  const namespaces = [
    "sessions",
    "messages",
    "pi_checkpoints",
    "web_identity",
    "web_selection",
    "session_selection",
    "turns",
    "outbox",
  ];
  const saved = () => namespaces.map((namespace) => [namespace, h.store.entries(namespace)]);
  const before = saved();
  const web = await startWeb({
    listen: "127.0.0.1:0",
    backend: h.app,
    assets: { "index.html": "history", "app.js": "", "styles.css": "" },
  });
  const state = async (ownerId?: string) => {
    const response = await fetch(
      `${web.url}/api/state${ownerId === undefined ? "" : `?ownerId=${encodeURIComponent(ownerId)}`}`,
    );
    assert.equal(response.status, 200);
    return (await response.json()) as WebState;
  };
  try {
    const one = await state();
    assert.equal(one.activeOwnerId, "owner");
    assert.equal(one.activeSessionId, undefined);
    assert.deepEqual(new Set(one.sessions?.map((x) => x.id)), new Set([first.id, archived.id]));
    assert.deepEqual(
      new Set(one.messages?.map((x) => x.text)),
      new Set(["第一身份正文", "旧历史"]),
    );
    assert.equal(one.records?.length, 2);
    assert.ok(!JSON.stringify(one).includes("test-model-secret"));
    assert.ok(!JSON.stringify(one).includes("different-secret"));
    assert.ok(!JSON.stringify(one).includes("private-other-task"));
    for (const field of ["tasks", "participants", "catalog", "projects", "model", "config"])
      assert.equal(Object.hasOwn(one, field), false, field);
    const two = await state("owner-second");
    assert.deepEqual(
      two.sessions?.map((x) => x.id),
      [second.id],
    );
    assert.deepEqual(
      two.messages?.map((x) => x.text),
      ["第二身份正文"],
    );
    assert.equal(two.records?.length, 1);
    assert.deepEqual(await state("owner"), one);
    assert.equal((await fetch(`${web.url}/api/state?ownerId=stranger`)).status, 403);
    assert.equal((await fetch(`${web.url}/api/state?ownerId=`)).status, 403);
    assert.deepEqual(saved(), before);
    assert.equal(h.store.get<StoredMessage>("messages", firstReply.id)?.delivery, "sending");
    assert.equal(h.engine.calls.length, 0);
    h.config.feishu.allowedOpenIds = ["owner"];
    assert.equal((await fetch(`${web.url}/api/state?ownerId=owner-second`)).status, 403);
    assert.equal((await state()).activeOwnerId, "owner");
    assert.deepEqual(saved(), before);
    h.config.feishu.allowedOpenIds = [];
    const empty = await state();
    assert.deepEqual(empty.sessions, []);
    assert.deepEqual(empty.messages, []);
    assert.deepEqual(empty.records, []);
    assert.deepEqual(saved(), before);
  } finally {
    await web.close();
    await h.close();
  }
});

test("an in-flight turn retains its original owner while local identity changes", async () => {
  const h = setup(true, false);
  h.config.feishu.allowedOpenIds = ["owner", "owner-second"];
  const started = deferred();
  const release = deferred();
  h.engine.handler = async (input) => {
    assert.equal(input.actor.ownerId, "owner");
    started.resolve();
    await release.promise;
    return { text: "第一身份延迟结果", messages: [] };
  };
  try {
    const first = h.app.snapshot() as WebState;
    const turn = h.app.dispatch("chat.send", {
      text: "等待",
      requestId: "waiting",
      expectedOwnerId: "owner",
    });
    await started.promise;
    await h.app.dispatch("identity.select", { ownerId: "owner-second" });
    release.resolve();
    const result = (await turn) as StoredMessage;
    assert.equal(result.sessionId, first.activeSessionId);
    const snapshot = h.app.snapshot() as WebState;
    assert.equal(snapshot.activeOwnerId, "owner-second");
    assert.ok(!snapshot.messages?.some((message) => message.id === result.id));
    await assert.rejects(
      h.app.dispatch("chat.ack", {
        sessionId: result.sessionId,
        messageId: result.id,
        expectedOwnerId: "owner",
      }),
      { code: "web_identity_changed" },
    );
  } finally {
    release.resolve();
    await h.close();
  }
});
