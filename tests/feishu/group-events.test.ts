import assert from "node:assert/strict";
import test from "node:test";
import type { EventDispatcher } from "@larksuiteoapi/node-sdk";
import type { PlatformHandlers } from "../../src/core/ports.js";
import { FetchHttpClient } from "../../src/feishu/http.js";
import { FeishuPlatform } from "../../src/feishu/platform.js";

const credentials = { appId: "cli_group_test", appSecret: "fixture-secret" };
const handlers: PlatformHandlers = {
  message: async () => {},
  action: async () => {},
  taskChanged: async () => {},
};

function event(chatId: unknown, appId = credentials.appId) {
  return {
    schema: "2.0",
    header: { event_id: "event-group", event_type: "im.chat.disbanded_v1", app_id: appId },
    event: { chat_id: chatId },
  };
}

test("group GET recognizes only documented normal/dissolved/dissolved_save statuses", async () => {
  for (const [status, expected] of [
    ["normal", "normal"],
    ["dissolved", "dissolved"],
    ["dissolved_save", "dissolved"],
  ]) {
    const platform = new FeishuPlatform(credentials, {
      request: async (input) => {
        assert.equal(input.method, "GET");
        assert.equal(input.url, "/open-apis/im/v1/chats/chat%2Ffixture");
        return { code: 0, data: { chat_status: status } };
      },
    });
    assert.equal(await platform.getGroupStatus("chat/fixture"), expected);
  }
  for (const status of [undefined, null, "", "deleted", "DISSOLVED", 1]) {
    const platform = new FeishuPlatform(credentials, {
      request: async () => ({ code: 0, data: { chat_status: status } }),
    });
    await assert.rejects(platform.getGroupStatus("chat"), { code: "feishu_group_status" });
  }
});

test("group status permission and transport failures never become dissolved", async () => {
  for (const code of [99991672, 232009]) {
    const platform = new FeishuPlatform(credentials, { request: async () => ({ code }) });
    await assert.rejects(platform.getGroupStatus("chat"), { code: `feishu_${code}` });
  }
  const denied = new FetchHttpClient(async () => new Response("{}", { status: 403 }));
  const platform = new FeishuPlatform(credentials, {
    request: (input) => denied.get(`https://open.feishu.cn${input.url}`),
  });
  await assert.rejects(platform.getGroupStatus("chat"), {
    code: "feishu_http_403",
    outcome: "not_executed",
  });
  const unavailable = new FeishuPlatform(credentials, {
    request: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(unavailable.getGroupStatus("chat"), { code: "feishu_transport" });
});

test("disbanded dispatcher validates app and generation and awaits durable group enqueue", async () => {
  const dispatchers: EventDispatcher[] = [];
  const received: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const platform = new FeishuPlatform(credentials, {
    request: async () => ({ code: 0, bot: { open_id: "bot" } }),
    connection: ({ onReady }) => ({
      start: async ({ eventDispatcher }) => {
        dispatchers.push(eventDispatcher);
        onReady();
      },
      close: () => {},
    }),
  });
  let enqueueFailed = false;
  let accepted = false;
  const callbacks: PlatformHandlers = {
    ...handlers,
    groupChanged: async (chatId) => {
      received.push(chatId);
      if (enqueueFailed) throw new Error("durable write failed");
      await pending;
      accepted = true;
    },
  };
  try {
    await platform.start(callbacks, new AbortController().signal);
    const first = dispatchers[0];
    assert.ok(first);
    await first.invoke(event("foreign-chat", "cli_foreign"), { needCheck: false });
    await first.invoke(event(""), { needCheck: false });
    await first.invoke(event("   "), { needCheck: false });
    await first.invoke(event(123), { needCheck: false });
    const noApp = event("no-app");
    await first.invoke(
      { ...noApp, header: { ...noApp.header, app_id: undefined } },
      { needCheck: false },
    );
    assert.deepEqual(received, []);
    const processing = first.invoke(event("chat"), { needCheck: false });
    await Promise.resolve();
    assert.equal(accepted, false);
    finish();
    await processing;
    assert.deepEqual(received, ["chat"]);
    assert.equal(accepted, true);
    enqueueFailed = true;
    await assert.rejects(first.invoke(event("failed-chat"), { needCheck: false }), /durable write/);
    enqueueFailed = false;
    await platform.stop();
    const controller = new AbortController();
    await platform.start(callbacks, controller.signal);
    await first.invoke(event("stale-chat"), { needCheck: false });
    assert.deepEqual(received, ["chat", "failed-chat"]);
    const second = dispatchers[1];
    assert.ok(second);
    await second.invoke(event("new-chat"), { needCheck: false });
    controller.abort();
    await second.invoke(event("aborted-chat"), { needCheck: false });
    assert.deepEqual(received, ["chat", "failed-chat", "new-chat"]);
  } finally {
    finish();
    await platform.stop();
  }
});
