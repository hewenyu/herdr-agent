import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Application } from "../../src/app/application.js";
import type { Session, StoredMessage } from "../../src/core/types.js";
import { Store } from "../../src/storage/store.js";
import type { WebState } from "../../src/web/contracts.js";
import { logger, setup } from "./helpers.js";

test("Web restore selects the restored session and retains its history after restart", async () => {
  const h = setup(true, false);
  try {
    const session = (await h.app.dispatch("session.create", { name: "归档历史" })) as Session;
    const reply = (await h.app.dispatch("chat.send", {
      sessionId: session.id,
      text: "保留这段调度历史",
      requestId: "archive-history",
    })) as StoredMessage;
    await h.app.dispatch("chat.ack", { sessionId: session.id, messageId: reply.id });
    await h.app.dispatch("session.archive", { id: session.id });
    assert.notEqual((h.app.snapshot() as WebState).activeSessionId, session.id);
    const restored = (await h.app.dispatch("session.restore", { id: session.id })) as Session;
    assert.equal(restored.archived, false);
    assert.equal((h.app.snapshot() as WebState).activeSessionId, session.id);

    const reopened = new Store(join(h.directory, "state.sqlite"));
    const restarted = new Application({
      config: h.config,
      store: reopened,
      engine: h.engine,
      herdr: h.herdr,
      logger,
    });
    try {
      const snapshot = restarted.snapshot() as WebState;
      assert.equal(snapshot.activeSessionId, session.id);
      assert.ok(snapshot.messages?.some((message) => message.id === reply.id));
      assert.equal(
        snapshot.messages?.find((message) => message.id === reply.id)?.delivery,
        "delivered",
      );
      assert.equal(h.herdr.closes, 0);
    } finally {
      await restarted.shutdown();
      reopened.close();
    }
  } finally {
    await h.close();
  }
});

test("a rejected cross-owner or stale restore cannot replace the current Web selection", async () => {
  const h = setup(true, false);
  try {
    const active = (await h.app.dispatch("session.create", { name: "当前会话" })) as Session;
    const foreign = h.app.sessions.create("another-owner", { name: "其他身份" });
    h.app.sessions.archive("another-owner", foreign.id);
    await assert.rejects(h.app.dispatch("session.restore", { id: foreign.id }));
    const archived = h.app.sessions.create("owner", { name: "已归档" });
    h.app.sessions.archive("owner", archived.id);
    await assert.rejects(
      h.app.dispatch("session.restore", { id: archived.id, expectedOwnerId: "another-owner" }),
      { code: "web_identity_changed" },
    );
    assert.equal((h.app.snapshot() as WebState).activeSessionId, active.id);
    assert.equal(h.app.sessions.get("another-owner", foreign.id).archived, true);
    assert.equal(h.app.sessions.get("owner", archived.id).archived, true);
  } finally {
    await h.close();
  }
});
