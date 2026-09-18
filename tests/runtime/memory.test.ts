import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryConfig } from "../../src/config/types.js";
import { MemoryService, memoryEntry } from "../../src/runtime/memory.js";
import { SessionService } from "../../src/runtime/sessions.js";
import type { ConversationEngine, EngineInput } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

const memoryConfig: MemoryConfig = {
  provider: "http",
  baseUrl: "https://memory.invalid",
  apiKey: "private-key",
  timeoutMs: 1000,
  users: {},
};
const actor = { ownerId: "owner", chatId: "entry", sessionId: "s1", messageId: "message" };

test("HTTP memory retains legacy protocol, isolates sessions, uses owner override and refuses redirects", async () => {
  const store = new Store(":memory:");
  const requests: Array<{ url: string; body: { scope: unknown }; init: RequestInit }> = [];
  const provider = new MemoryService(
    store,
    { ...memoryConfig, users: { owner: { ...memoryConfig, baseUrl: "https://owner.invalid" } } },
    async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)), init: init ?? {} });
      return String(url).endsWith("/recall")
        ? new Response(JSON.stringify({ summary: "记忆", revision: "r1" }))
        : new Response(null, { status: 204 });
    },
  );
  try {
    assert.equal((await provider.recall(actor)).summary, "记忆");
    await provider.store({ ...actor, sessionId: "s2" }, memoryEntry("新摘要"));
    assert.equal(requests[0]?.url, "https://owner.invalid/recall");
    assert.deepEqual(requests[0]?.body.scope, { owner_id: "owner", chat_id: "pi:s1" });
    assert.deepEqual(requests[1]?.body.scope, { owner_id: "owner", chat_id: "pi:s2" });
    assert.equal(requests[0]?.init.redirect, "error");
  } finally {
    store.close();
  }
});

test("provider failure is redacted and does not execute a turn", async () => {
  const store = new Store(":memory:");
  let runs = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    run: async () => {
      runs++;
      return { text: "x", messages: [] };
    },
    summarize: async () => "",
  };
  const sessions = new SessionService(store, engine, {
    memoryProvider: new MemoryService(store, memoryConfig, async () => {
      throw new Error("private-key and secret request");
    }),
  });
  try {
    const session = sessions.current("owner", "entry");
    await assert.rejects(
      sessions.reply({ ...actor, sessionId: session.id }, "test"),
      (error: unknown) => error instanceof Error && !error.message.includes("private-key"),
    );
    assert.equal(runs, 0);
    assert.equal(sessions.history("owner", session.id).length, 0);
  } finally {
    store.close();
  }
});

test("compaction preserves raw history, current input and delivery visibility across repeated summaries", async () => {
  const store = new Store(":memory:");
  const inputs: EngineInput[] = [];
  let summaries = 0;
  const engine: ConversationEngine = {
    contextTokens: 8000,
    run: async (input) => {
      inputs.push(input);
      return { text: "答复".repeat(200), messages: input.messages };
    },
    summarize: async ({ messages, previousSummary }) => {
      summaries++;
      assert.ok(messages.length);
      assert.ok(!JSON.stringify(messages).includes("未见建议"));
      return `${previousSummary}保留约束${summaries}`;
    },
  };
  const sessions = new SessionService(store, engine);
  try {
    const session = sessions.current("owner", "entry");
    for (let i = 0; i < 15; i++) {
      const reply = await sessions.reply(
        { ...actor, sessionId: session.id, messageId: `m${i}` },
        `第${i}轮不能改项目${"需求".repeat(200)}`,
      );
      if (i % 2 === 0) {
        sessions.beginDelivery("owner", reply.id);
        sessions.recordDelivery("owner", reply.id, { complete: true, ids: [`sent${i}`] });
      }
    }
    assert.ok(summaries > 0);
    assert.equal(sessions.history("owner", session.id).length, 30);
    assert.ok(sessions.get("owner", session.id).summary.includes("保留约束"));
    assert.ok(inputs.at(-1)?.prompt.startsWith("第14轮"));
  } finally {
    store.close();
  }
});

test("failed compaction leaves original history and creates no receipt for unexecuted input", async () => {
  const store = new Store(":memory:");
  let runs = 0;
  const engine: ConversationEngine = {
    contextTokens: 5000,
    run: async () => {
      runs++;
      return { text: "答复".repeat(500), messages: [] };
    },
    summarize: async () => {
      throw new Error("summary failure");
    },
  };
  const sessions = new SessionService(store, engine);
  try {
    const session = sessions.current("owner", "entry");
    let failed = false;
    for (let i = 0; i < 20; i++) {
      const before = sessions.history("owner", session.id).length;
      try {
        const reply = await sessions.reply(
          { ...actor, sessionId: session.id, messageId: `m${i}` },
          "需求".repeat(300),
        );
        sessions.beginDelivery("owner", reply.id);
        sessions.recordDelivery("owner", reply.id, { complete: true, ids: [`sent${i}`] });
      } catch {
        failed = true;
        assert.equal(sessions.history("owner", session.id).length, before);
        break;
      }
    }
    assert.ok(failed);
    assert.equal(store.list("turn_receipts").length, runs);
    assert.equal(sessions.get("owner", session.id).summary, "");
  } finally {
    store.close();
  }
});

test("clear while a provider is in flight cannot restore old generation", async () => {
  const store = new Store(":memory:");
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announce: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const sessions = new SessionService(store, {
    contextTokens: 50000,
    summarize: async () => "",
    run: async () => {
      announce();
      await waiting;
      return { text: "迟到回复", messages: [] };
    },
  });
  try {
    const session = sessions.current("owner", "entry");
    const pending = sessions.reply({ ...actor, sessionId: session.id }, "test");
    await started;
    sessions.clear("owner", session.id);
    release();
    await assert.rejects(pending);
    assert.equal(sessions.get("owner", session.id).generation, 1);
    assert.ok(
      !sessions.history("owner", session.id).some((message) => message.text === "迟到回复"),
    );
  } finally {
    store.close();
  }
});
