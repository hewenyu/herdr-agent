import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import type { InboxRecord } from "../../src/app/inbox.js";
import { messageActor } from "../../src/app/messages.js";
import { OperationError } from "../../src/core/errors.js";
import { logger, message, setup } from "./helpers.js";

function makeDue(h: ReturnType<typeof setup>): void {
  for (const [id, record] of h.store.entries<InboxRecord>("inbox"))
    if (record.state === "queued") h.store.set("inbox", id, { ...record, nextAttemptAt: 0 });
}

test("Feishu transient model failure resumes the accepted request without a new user message", async () => {
  const h = setup();
  let attempts = 0;
  h.engine.handler = async (input) => {
    if (++attempts === 1) throw new OperationError("model_failed", "network", "unknown");
    assert.equal(input.resume, true);
    assert.ok(JSON.stringify(input.messages).includes("帮我理解需求"));
    return { text: "请说明具体目标。", messages: [] };
  };
  try {
    await h.app.handlers().message(message("retry", "帮我理解需求"));
    await h.app.inbox.drain();
    assert.equal(h.store.get<InboxRecord>("inbox", "message:retry")?.state, "queued");
    makeDue(h);
    await h.app.inbox.drain();
    assert.equal(attempts, 2);
    assert.equal(h.store.get<InboxRecord>("inbox", "message:retry")?.state, "done");
    assert.equal(h.platform.texts.at(-1)?.text, "请说明具体目标。");
  } finally {
    await h.close();
  }
});

test("known refusal of a later reply fragment retries only its remainder, never the model", async () => {
  const h = setup();
  h.engine.response = "答".repeat(4000);
  let attempts = 0;
  h.platform.sendHook = () => {
    if (++attempts === 2) throw new OperationError("feishu_99991400", "rate limited");
  };
  try {
    await h.app.handlers().message(message("fragment", "你好"));
    await h.app.inbox.drain();
    assert.equal(h.platform.texts.length, 1);
    assert.equal(h.store.get<InboxRecord>("inbox", "message:fragment")?.state, "queued");
    makeDue(h);
    await h.app.inbox.drain();
    assert.equal(h.engine.calls.length, 1);
    assert.equal(h.platform.texts.length, 2);
    assert.equal(h.platform.texts.map((part) => part.text).join(""), h.engine.response);
    assert.equal(h.store.get<InboxRecord>("inbox", "message:fragment")?.state, "done");
  } finally {
    await h.close();
  }
});

test("restart delivers a finished prepared answer without rerunning the turn", async () => {
  const h = setup();
  let restarted: Application | undefined;
  try {
    const incoming = message("prepared", "你好");
    await h.app.handlers().message(incoming);
    const actor = messageActor(h.app, incoming);
    await h.app.sessions.reply(actor, incoming.text);
    const record = h.store.get<InboxRecord>("inbox", "message:prepared");
    assert.ok(record);
    h.store.set("inbox", record.id, { ...record, state: "processing", attempts: 1 });
    await h.app.shutdown();
    restarted = new Application({
      config: h.config,
      store: h.store,
      engine: h.engine,
      herdr: h.herdr,
      platform: h.platform,
      logger,
    });
    await restarted.inbox.drain();
    assert.equal(h.engine.calls.length, 1);
    assert.equal(h.platform.texts.length, 1);
    assert.equal(h.store.get<InboxRecord>("inbox", record.id)?.state, "done");
  } finally {
    await restarted?.shutdown();
    await h.close();
  }
});

test("exhausted model recovery emits one factual operational failure notice", async () => {
  const h = setup();
  h.engine.handler = async () => {
    throw new OperationError("model_failed", "offline", "unknown");
  };
  try {
    await h.app.handlers().message(message("exhausted", "你好"));
    for (let attempt = 0; attempt < 4; attempt++) {
      makeDue(h);
      await h.app.inbox.drain();
    }
    assert.equal(h.engine.calls.length, 3);
    assert.equal(h.platform.texts.length, 1);
    assert.match(h.platform.texts[0]?.text ?? "", /处理已中断/);
    assert.equal(h.store.get<InboxRecord>("inbox", "message:exhausted")?.state, "uncertain");
  } finally {
    await h.close();
  }
});

test("an interrupted message from a cleared generation is never rebound on restart", async () => {
  const h = setup();
  let restarted: Application | undefined;
  try {
    const incoming = message("old-generation", "旧要求");
    await h.app.handlers().message(incoming);
    const record = h.store.get<InboxRecord>("inbox", "message:old-generation");
    assert.ok(record?.actor);
    h.store.set("inbox", record.id, { ...record, state: "processing" });
    h.app.sessions.clear("owner", record.actor.sessionId);
    await h.app.shutdown();
    restarted = new Application({
      config: h.config,
      store: h.store,
      engine: h.engine,
      herdr: h.herdr,
      platform: h.platform,
      logger,
    });
    await restarted.inbox.drain();
    assert.equal(h.engine.calls.length, 0);
    assert.equal(h.store.get<InboxRecord>("inbox", record.id)?.state, "uncertain");
  } finally {
    await restarted?.shutdown();
    await h.close();
  }
});
