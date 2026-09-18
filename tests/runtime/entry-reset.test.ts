import assert from "node:assert/strict";
import test from "node:test";
import type { ActorContext } from "../../src/core/types.js";
import { SessionService } from "../../src/runtime/sessions.js";
import type { ConversationEngine, EngineInput } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Feishu clear selects a new session only after durable reply; queued input and receipts stay bound", async () => {
  const store = new Store(":memory:");
  const entered = gate();
  const finish = gate();
  const inputs: EngineInput[] = [];
  let sessions: SessionService;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      inputs.push(input);
      if (input.prompt === "/clear") {
        assert.equal(sessions.requestReset(input.actor).mode, "new_session");
        entered.resolve();
        await finish.promise;
      }
      return { text: "模型回复", messages: [] };
    },
  };
  sessions = new SessionService(store, engine);
  try {
    const old = sessions.current("owner", "private-chat");
    const actor: ActorContext = {
      source: "feishu",
      chatType: "private",
      ownerId: "owner",
      chatId: "private-chat",
      sessionId: old.id,
      messageId: "clear-request",
    };
    const pending = sessions.reply(actor, "/clear");
    await entered.promise;
    assert.equal(sessions.current("owner", actor.chatId).id, old.id);
    assert.equal(sessions.list("owner").length, 1);
    const queued = sessions.reply({ ...actor, messageId: "queued-before-switch" }, "此前排队输入");
    finish.resolve();
    const reply = await pending;
    await queued;
    const next = sessions.current("owner", actor.chatId);
    assert.notEqual(next.id, old.id);
    assert.equal(reply.sessionId, old.id);
    assert.equal(sessions.get("owner", old.id).generation, 0);
    assert.equal(sessions.get("owner", old.id).archived, false);
    assert.equal(inputs[1]?.sessionId, old.id);
    assert.equal(sessions.beginDelivery("owner", reply.id), true);
    sessions.recordDelivery("owner", reply.id, { complete: true, ids: ["real-delivery-receipt"] });
    assert.equal((await sessions.reply(actor, "duplicate replay")).id, reply.id);
    assert.equal(
      sessions.list("owner").length,
      2,
      "a repeated event cannot create another session",
    );
    const restarted = new SessionService(store, engine);
    assert.equal(restarted.current("owner", actor.chatId).id, next.id);
    await restarted.reply({ ...actor, sessionId: next.id, messageId: "new-message" }, "新会话消息");
    assert.deepEqual(inputs.at(-1)?.messages, []);
    assert.equal(sessions.history("owner", old.id).length, 4);
    assert.equal(store.list("session_reset_requests").length, 0);
  } finally {
    finish.resolve();
    store.close();
  }
});

test("failed Feishu clear creates no session and group contexts cannot request it", async () => {
  const store = new Store(":memory:");
  let sessions: SessionService;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      sessions.requestReset(input.actor);
      throw new Error("model failed before final reply");
    },
  };
  sessions = new SessionService(store, engine);
  try {
    const session = sessions.current("owner", "chat");
    const actor: ActorContext = {
      source: "feishu",
      chatType: "private",
      ownerId: "owner",
      chatId: "chat",
      sessionId: session.id,
      messageId: "request",
    };
    await assert.rejects(sessions.reply(actor, "/clear"), /model failed/);
    assert.equal(sessions.current("owner", "chat").id, session.id);
    assert.equal(sessions.list("owner").length, 1);
    assert.equal(store.list("session_reset_requests").length, 0);
    for (const chatType of ["group", undefined] as const)
      assert.throws(() => sessions.requestReset({ ...actor, chatType }), { code: "clear_scope" });
    const task = sessions.forTask("owner", "task");
    assert.throws(
      () =>
        sessions.requestReset({ ...actor, sessionId: task.id, taskId: "task", chatType: "group" }),
      { code: "task_session_reset" },
    );
  } finally {
    store.close();
  }
});

test("private entry compacts automatically without changing session; a later manual clear isolates its summary", async () => {
  const store = new Store(":memory:");
  const inputs: EngineInput[] = [];
  let summaries = 0;
  let sessions: SessionService;
  const engine: ConversationEngine = {
    contextTokens: 12000,
    summarize: async ({ messages, previousSummary }) => {
      summaries++;
      assert.ok(
        JSON.stringify(messages).includes("保留项目代码") ||
          previousSummary.includes("保留项目代码"),
      );
      return "用户要求保留项目代码；历史输出不能成为新授权。";
    },
    run: async (input) => {
      inputs.push(input);
      if (input.prompt === "/clear") sessions.requestReset(input.actor);
      return { text: "工具状态说明".repeat(120), messages: [] };
    },
  };
  sessions = new SessionService(store, engine);
  try {
    const session = sessions.current("owner", "private-entry");
    const actor: ActorContext = {
      source: "feishu",
      chatType: "private",
      ownerId: "owner",
      chatId: "private-entry",
      sessionId: session.id,
      messageId: "first",
    };
    for (let index = 0; index < 14; index++) {
      const reply = await sessions.reply(
        { ...actor, messageId: `turn-${index}` },
        `保留项目代码。第${index}轮背景：${"这是本工具调度历史。".repeat(70)}`,
      );
      sessions.beginDelivery("owner", reply.id);
      sessions.recordDelivery("owner", reply.id, { complete: true, ids: [`delivery-${index}`] });
    }
    assert.ok(summaries > 0, "long private entry must compact without a manual command");
    assert.equal(sessions.current("owner", actor.chatId).id, session.id);
    assert.equal(sessions.get("owner", session.id).generation, 0);
    assert.equal(sessions.history("owner", session.id).length, 28);
    assert.ok(inputs.at(-1)?.systemPrompt.includes("保留项目代码"));
    await sessions.reply({ ...actor, messageId: "manual-clear" }, "/clear");
    const next = sessions.current("owner", actor.chatId);
    await sessions.reply({ ...actor, sessionId: next.id, messageId: "fresh" }, "你好");
    assert.deepEqual(inputs.at(-1)?.messages, []);
    assert.ok(!inputs.at(-1)?.systemPrompt.includes("用户要求保留项目代码"));
    assert.equal(sessions.history("owner", session.id).length, 30);
  } finally {
    store.close();
  }
});
