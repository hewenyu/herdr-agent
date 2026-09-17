import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Application } from "../../src/app/application.js";
import type { Session, StoredMessage, Task } from "../../src/core/types.js";
import { Store } from "../../src/storage/store.js";
import type { WebState } from "../../src/web/contracts.js";
import { startWeb } from "../../src/web/index.js";
import { deferred, logger, setup } from "./helpers.js";

test("local HTTP identity selection persists and scopes sessions, history, tasks and acknowledgements", async () => {
  const h = setup(true, false);
  h.config.feishu.allowedOpenIds = ["owner", "owner-second"];
  const web = await startWeb({
    listen: "127.0.0.1:0",
    backend: h.app,
    assets: { "index.html": "__CSRF_TOKEN__", "app.js": "", "styles.css": "" },
  });
  const csrf = await (await fetch(web.url)).text();
  const state = async () => (await (await fetch(`${web.url}/api/state`)).json()) as WebState;
  const action = async (name: string, input: Record<string, unknown>, success = true) => {
    const response = await fetch(`${web.url}/api/actions`, {
      method: "POST",
      headers: { Origin: web.url, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ action: name, input }),
    });
    const body = (await response.json()) as {
      ok: boolean;
      result: Record<string, unknown>;
      error?: { code: string };
    };
    assert.equal(body.ok, success, JSON.stringify(body));
    assert.equal(response.ok, success);
    return body;
  };
  const makeTask = async (title: string) =>
    (
      await action("task.create", {
        kind: "discussion",
        title,
        requirements: title,
        participants: [{ kind: "codex" }],
        createGroup: false,
        createRemoteTask: false,
      })
    ).result as unknown as Task;
  try {
    assert.equal((await state()).activeOwnerId, "owner");
    const first = (await action("session.create", { name: "第一身份会话" }))
      .result as unknown as Session;
    const firstReply = (await action("chat.send", { text: "第一身份正文", requestId: "first" }))
      .result as unknown as StoredMessage;
    const firstTask = await makeTask("第一身份任务");
    await action("identity.select", { ownerId: "owner-second" });
    let snapshot = await state();
    assert.equal(snapshot.activeOwnerId, "owner-second");
    assert.equal(snapshot.tasks?.length, 0);
    assert.equal(snapshot.messages?.length, 0);
    assert.ok(snapshot.sessions?.every((item) => item.ownerId === "owner-second"));
    assert.equal(
      snapshot.identities?.find((item) => item.id === "owner")?.sessionCount,
      h.app.sessions.list("owner", { archived: true }).length,
    );

    const second = (await action("session.create", { name: "第二身份会话" }))
      .result as unknown as Session;
    await action("chat.send", {
      text: "第二身份正文",
      requestId: "second",
      expectedOwnerId: "owner-second",
    });
    const secondTask = await makeTask("第二身份任务");
    for (const [name, input] of [
      ["session.select", { id: first.id }],
      ["session.history", { id: first.id }],
      ["session.rename", { id: first.id, name: "非法修改" }],
      ["task.get", { id: firstTask.id }],
      ["task.action", { id: firstTask.id, action: "pause" }],
      ["chat.ack", { sessionId: first.id, messageId: firstReply.id }],
      ["session.create", { name: "过期身份", expectedOwnerId: "owner" }],
      ["session.create", { name: "冒充身份", ownerId: "owner" }],
      ["identity.select", { ownerId: "not-allowed" }],
    ] as Array<[string, Record<string, unknown>]>)
      await action(name, input, false);
    snapshot = await state();
    assert.equal(snapshot.activeOwnerId, "owner-second");
    assert.equal(snapshot.activeSessionId, second.id);
    assert.deepEqual(
      snapshot.tasks?.map((item) => item.id),
      [secondTask.id],
    );
    assert.ok(snapshot.messages?.some((message) => message.text === "第二身份正文"));
    assert.ok(snapshot.messages?.every((message) => message.sessionId === second.id));
    assert.equal(h.app.sessions.get("owner", first.id).name, "第一身份会话");
    assert.equal(h.store.get<StoredMessage>("messages", firstReply.id)?.delivery, "sending");

    await action("identity.select", { ownerId: "owner" });
    snapshot = await state();
    assert.equal(snapshot.activeSessionId, first.id);
    assert.deepEqual(
      snapshot.tasks?.map((item) => item.id),
      [firstTask.id],
    );
    await action("chat.ack", {
      sessionId: first.id,
      messageId: firstReply.id,
      expectedOwnerId: "owner",
    });
    assert.equal(h.store.get<StoredMessage>("messages", firstReply.id)?.delivery, "delivered");
    await action("identity.select", { ownerId: "owner-second" });

    const reopened = new Store(join(h.directory, "state.sqlite"));
    const restarted = new Application({
      config: h.config,
      store: reopened,
      engine: h.engine,
      herdr: h.herdr,
      logger,
    });
    try {
      const restored = restarted.snapshot() as WebState;
      assert.equal(restored.activeOwnerId, "owner-second");
      assert.equal(restored.activeSessionId, second.id);
    } finally {
      await restarted.shutdown();
      reopened.close();
    }

    h.config.feishu.allowedOpenIds = ["owner"];
    snapshot = await state();
    assert.equal(snapshot.activeOwnerId, "owner");
    assert.equal(snapshot.activeSessionId, first.id);
    assert.equal(h.store.get("web_identity", "selected"), undefined);
    await action("identity.select", { ownerId: "owner-second" }, false);
    h.store.set("web_identity", "selected", { invalid: "owner-second" });
    assert.equal((await state()).activeOwnerId, "owner");
    h.store.set("web_selection", "owner", second.id);
    assert.ok((await state()).sessions?.every((session) => session.ownerId === "owner"));
    assert.notEqual((await state()).activeSessionId, second.id);
    h.config.feishu.allowedOpenIds = [];
    snapshot = await state();
    assert.equal(snapshot.activeOwnerId, undefined);
    assert.deepEqual(snapshot.sessions, []);
    assert.deepEqual(snapshot.tasks, []);
    await action("session.create", { name: "无授权" }, false);
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
