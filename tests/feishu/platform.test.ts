import assert from "node:assert/strict";
import test from "node:test";
import type { EventDispatcher } from "@larksuiteoapi/node-sdk";
import { OperationError } from "../../src/core/errors.js";
import type { PlatformHandlers } from "../../src/core/ports.js";
import type { APIRequest } from "../../src/feishu/api.js";
import { FetchHttpClient } from "../../src/feishu/http.js";
import { FeishuPlatform, type PlatformDependencies } from "../../src/feishu/platform.js";

const credentials = { appId: "cli_test", appSecret: "test-secret" };
const handlers: PlatformHandlers = {
  message: async () => {},
  action: async () => {},
  taskChanged: async () => {},
};

test("task subscription uses the app-assignee endpoint without a user token or body", async () => {
  const calls: APIRequest[] = [];
  const platform = new FeishuPlatform(credentials, {
    request: async (input) => {
      calls.push(input);
      return { code: 0, data: { code: 0, msg: "success" } };
    },
  });
  await platform.subscribeTasks();
  assert.deepEqual(calls, [
    {
      method: "POST",
      url: "/open-apis/task/v2/task_v2/task_subscription",
      params: { user_id_type: "open_id" },
    },
  ]);
  for (const response of [{ code: 99991672 }, { code: 0, data: { code: 1470400 } }]) {
    const rejected = new FeishuPlatform(credentials, { request: async () => response });
    await assert.rejects(rejected.subscribeTasks(), OperationError);
  }
});

test("subscribed task updates use the existing dispatcher and await durable task acceptance", async () => {
  let dispatcher: EventDispatcher | undefined;
  const taskIds: string[] = [];
  const calls: string[] = [];
  const platform = new FeishuPlatform(credentials, {
    request: async ({ url }) => {
      calls.push(url);
      return { code: 0, bot: { open_id: "bot" }, data: { code: 0 } };
    },
    connection: ({ onReady }) => ({
      start: async (input) => {
        dispatcher = input.eventDispatcher;
        onReady();
      },
      close: () => {},
    }),
  });
  try {
    await platform.start(
      {
        ...handlers,
        taskChanged: async (id) => {
          taskIds.push(id);
          if (id === "rejected-task") throw new Error("durable task enqueue failed");
        },
      },
      new AbortController().signal,
    );
    await platform.subscribeTasks();
    assert.deepEqual(calls, [
      "/open-apis/bot/v3/info",
      "/open-apis/task/v2/task_v2/task_subscription",
    ]);
    assert.ok(dispatcher);
    const event = (id: string, appId = credentials.appId) => ({
      schema: "2.0",
      header: { event_type: "task.task.update_user_access_v2", app_id: appId },
      event: { task_guid: id },
    });
    await dispatcher.invoke(event("task"), { needCheck: false });
    await dispatcher.invoke(event("foreign-task", "cli_other"), { needCheck: false });
    await assert.rejects(
      dispatcher.invoke(event("rejected-task"), { needCheck: false }),
      /enqueue/,
    );
    await platform.stop();
    await dispatcher.invoke(event("after-stop"), { needCheck: false });
    assert.deepEqual(taskIds, ["task", "rejected-task"]);
  } finally {
    await platform.stop();
  }
});

test("task/group/message calls preserve stable idempotency and bot-owned group semantics", async () => {
  const calls: APIRequest[] = [];
  const platform = new FeishuPlatform(credentials, {
    request: async (input) => {
      calls.push(input);
      return {
        code: 0,
        data: { task: { guid: "task", completed_at: "123" }, chat_id: "chat", message_id: "m1" },
      };
    },
  });
  await platform.createTask({
    title: "Title",
    description: "Description",
    ownerId: "owner",
    key: "task-key",
  });
  await platform.createGroup("Group", "owner", "group-key");
  await platform.sendText("chat", "Hello", "message-key", "parent");
  await platform.updateTask("task", "Done", "456");
  assert.equal(calls[0]?.data?.client_token, "task-key");
  assert.deepEqual(calls[0]?.data?.members, [
    { id: "owner", type: "user", role: "assignee" },
    { id: "cli_test", type: "app", role: "assignee" },
  ]);
  assert.equal(calls[1]?.params?.uuid, "group-key");
  assert.equal(calls[1]?.data?.owner_id, undefined);
  assert.equal(calls[1]?.data?.chat_type, "private");
  assert.equal(calls[2]?.url, "/open-apis/im/v1/messages/parent/reply");
  assert.equal(calls[2]?.data?.uuid, "message-key");
  assert.deepEqual(calls[4]?.data?.update_fields, ["description"]);
});

test("unknown API errors, dropped responses and missing IDs never grant automatic replay", async () => {
  for (const request of [
    async () => {
      throw new Error("secret transport details");
    },
    async () => ({ code: 0, data: {} }),
    async () => ({ code: 99999999, msg: "secret details" }),
  ]) {
    const platform = new FeishuPlatform(credentials, { request });
    await assert.rejects(platform.sendText("chat", "hi", "key"), (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.outcome, "unknown");
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
  const refused = new FeishuPlatform(credentials, { request: async () => ({ code: 99991672 }) });
  await assert.rejects(refused.createGroup("g", "o", "k"), { outcome: "not_executed" });
  const deleted = new FeishuPlatform(credentials, { request: async () => ({ code: 232009 }) });
  await deleted.deleteGroup("chat");
});

test("dispatcher awaits durable acceptance and propagates failed card enqueue", async () => {
  let dispatcher: EventDispatcher | undefined;
  let closed = 0;
  let accepted = false;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const platform = new FeishuPlatform(credentials, {
    request: async () => ({ code: 0, bot: { open_id: "bot" } }),
    connection: ({ onReady }) => ({
      start: async (input) => {
        dispatcher = input.eventDispatcher;
        onReady();
      },
      close: () => {
        closed++;
      },
    }),
  });
  const controller = new AbortController();
  await platform.start(
    {
      ...handlers,
      message: async () => {
        await pending;
        accepted = true;
      },
      action: async () => {
        throw new Error("durable enqueue failed");
      },
    },
    controller.signal,
  );
  assert.ok(dispatcher);
  const event = {
    schema: "2.0",
    header: { event_id: "e", event_type: "im.message.receive_v1", app_id: "cli_test" },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: "owner" } },
      message: {
        message_id: "m",
        chat_id: "chat",
        chat_type: "p2p",
        message_type: "text",
        content: '{"text":"hello"}',
      },
    },
  };
  const processing = dispatcher.invoke(event, { needCheck: false });
  assert.equal(accepted, false);
  release();
  await processing;
  assert.equal(accepted, true);
  await assert.rejects(
    dispatcher.invoke(
      {
        schema: "2.0",
        header: { event_type: "card.action.trigger", app_id: "cli_test" },
        event: {
          operator: { open_id: "owner" },
          context: { open_message_id: "m", open_chat_id: "chat" },
          action: { value: { key: "1" } },
        },
      },
      { needCheck: false },
    ),
  );
  controller.abort();
  assert.ok(closed > 0);
  await platform.stop();
});

test("connection timeout closes transport and failed startup can be retried", async () => {
  let closed = 0;
  const platform = new FeishuPlatform(credentials, {
    request: async () => ({ code: 0, bot: { open_id: "bot" } }),
    connectTimeoutMs: 5,
    connection: () => ({
      start: async () => {},
      close: () => {
        closed++;
      },
    }),
  });
  await assert.rejects(platform.start(handlers, new AbortController().signal), {
    code: "feishu_connect_timeout",
  });
  await assert.rejects(platform.start(handlers, new AbortController().signal), {
    code: "feishu_connect_timeout",
  });
  assert.ok(closed >= 2);
});

test("terminal runtime connection failure is reported after startup", async () => {
  let callbacks: Parameters<NonNullable<PlatformDependencies["connection"]>>[0] | undefined;
  const failures: Error[] = [];
  const platform = new FeishuPlatform(credentials, {
    request: async () => ({ code: 0, bot: { open_id: "bot" } }),
    connection: (input) => {
      callbacks = input;
      return {
        start: async () => input.onReady(),
        close: () => {},
      };
    },
  });
  await platform.start(handlers, new AbortController().signal, (error) => failures.push(error));
  callbacks?.onError(new Error("reconnect exhausted"));
  callbacks?.onError(new Error("duplicate terminal error"));
  assert.equal(failures.length, 1);
  assert.ok(failures[0] instanceof OperationError);
  assert.equal((failures[0] as OperationError).code, "feishu_connect_failed");
  await platform.stop();
  callbacks?.onError(new Error("late terminal error"));
  assert.equal(failures.length, 1);
});

test("HTTP adapter restricts hosts, aborts timeout, and distinguishes 503 from 403", async () => {
  let calls = 0;
  const client = new FetchHttpClient(async () => {
    calls++;
    return new Response("{}", { status: 503 });
  });
  await assert.rejects(client.post("https://evil.example/open-apis/im/v1/messages", {}), {
    code: "invalid_feishu_url",
  });
  assert.equal(calls, 0);
  await assert.rejects(client.post("https://open.feishu.cn/open-apis/im/v1/messages", {}), {
    outcome: "unknown",
  });
  const denied = new FetchHttpClient(async () => new Response("{}", { status: 403 }));
  await assert.rejects(denied.post("https://open.feishu.cn/open-apis/im/v1/messages", {}), {
    outcome: "not_executed",
  });
  const timed = new FetchHttpClient(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      }),
    5,
  );
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(timed.post("https://open.feishu.cn/open-apis/im/v1/messages", {}), {
      outcome: "unknown",
    });
  } finally {
    clearTimeout(keepAlive);
  }
});

test("stopping during handshake settles start and stale dispatchers cannot enqueue after restart", async () => {
  let ready: () => void = () => {};
  let oldDispatcher: EventDispatcher | undefined;
  let arrived = 0;
  let connected: () => void = () => {};
  const created = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const platform = new FeishuPlatform(credentials, {
    request: async () => ({ code: 0, bot: { open_id: "bot" } }),
    connection: ({ onReady }) => {
      ready = onReady;
      return {
        start: async ({ eventDispatcher }) => {
          oldDispatcher = eventDispatcher;
          connected();
        },
        close: () => {},
      };
    },
  });
  const starting = platform.start(
    {
      ...handlers,
      message: async () => {
        arrived++;
      },
    },
    new AbortController().signal,
  );
  await created;
  const rejection = assert.rejects(starting, { code: "feishu_stopped" });
  await platform.stop();
  await rejection;
  ready();
  assert.ok(oldDispatcher);
  await oldDispatcher.invoke(
    {
      schema: "2.0",
      header: { event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "owner" } },
        message: {
          message_id: "m",
          chat_id: "chat",
          chat_type: "p2p",
          message_type: "text",
          content: '{"text":"late"}',
        },
      },
    },
    { needCheck: false },
  );
  assert.equal(arrived, 0);
});
