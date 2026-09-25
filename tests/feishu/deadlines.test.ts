import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformHandlers } from "../../src/core/ports.js";
import { FeishuAPI } from "../../src/feishu/api.js";
import { FetchHttpClient } from "../../src/feishu/http.js";
import { FeishuPlatform } from "../../src/feishu/platform.js";

const url = "https://open.feishu.cn/open-apis/im/v1/messages";
const credentials = { appId: "cli_test", appSecret: "secret" };
const handlers: PlatformHandlers = {
  message: async () => {},
  action: async () => {},
  taskChanged: async () => {},
};

for (const stage of ["fetch", "body"] as const) {
  for (const method of ["GET", "POST"] as const) {
    test(`deadline bounds a noncooperative ${stage} for ${method}`, { timeout: 1000 }, async () => {
      let requestSignal: AbortSignal | null | undefined;
      const client = new FetchHttpClient(async (_url, init) => {
        requestSignal = init?.signal;
        if (stage === "fetch") return new Promise<Response>(() => {});
        const response = new Response("{}");
        response.json = () => new Promise(() => {});
        return response;
      }, 5);
      await assert.rejects(client.request({ url, method }), {
        code: "feishu_timeout",
        outcome: method === "POST" ? "unknown" : "not_executed",
      });
      assert.equal(requestSignal?.aborted, true);
    });
  }
}

test("pre-aborted HTTP mutations never dispatch and remain safe to retry", async () => {
  let calls = 0;
  const client = new FetchHttpClient(async () => {
    calls++;
    return new Response("{}");
  });
  const controller = new AbortController();
  controller.abort(new Error("sensitive cancellation detail"));
  await assert.rejects(client.request({ url, method: "POST", signal: controller.signal }), {
    code: "feishu_aborted",
    outcome: "not_executed",
  });
  assert.equal(calls, 0);
});

test("caller cancellation settles a dispatched write without authorizing replay", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  let started: () => void = () => {};
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = new FetchHttpClient(async (_url, init) => {
    requestSignal = init?.signal;
    started();
    return new Promise<Response>(() => {});
  });
  const pending = client.request({ url, method: "POST", signal: controller.signal });
  const rejected = assert.rejects(pending, { code: "feishu_aborted", outcome: "unknown" });
  await dispatched;
  controller.abort(new Error("sensitive cancellation detail"));
  await rejected;
  assert.equal(requestSignal?.aborted, true);
});

test("SDK request deadline includes authentication and preserves mutation uncertainty", async () => {
  let signal: AbortSignal | undefined;
  let calls = 0;
  const api = new FeishuAPI(
    credentials,
    async (_input, requestSignal) => {
      signal = requestSignal;
      calls++;
      return new Promise(() => {});
    },
    5,
  );
  await assert.rejects(api.call({ method: "POST", url: "/open-apis/im/v1/messages" }), {
    code: "feishu_timeout",
    outcome: "unknown",
  });
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});

test("SDK cannot issue a late mutation after cancellation during authentication", async (t) => {
  const calls: string[] = [];
  let release: (response: Response) => void = () => {};
  let started: () => void = () => {};
  const authenticating = new Promise<void>((resolve) => {
    started = resolve;
  });
  t.mock.method(globalThis, "fetch", async (input: URL | string) => {
    calls.push(String(input));
    started();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const api = new FeishuAPI({ ...credentials, appId: "cancelled-during-authentication" });
  const controller = new AbortController();
  const pending = api.call(
    { method: "POST", url: "/open-apis/im/v1/messages", data: { uuid: "same-key" } },
    controller.signal,
  );
  const rejected = assert.rejects(pending, { code: "feishu_aborted", outcome: "unknown" });
  await authenticating;
  controller.abort();
  await rejected;
  release(Response.json({ code: 0, tenant_access_token: "token", expire: 7200 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /tenant_access_token/);
});

for (const stop of ["stop", "abort"] as const) {
  test(`${stop} during identity lookup settles startup and allows restart`, {
    timeout: 1000,
  }, async () => {
    let identitySignal: AbortSignal | undefined;
    let release: (value: unknown) => void = () => {};
    let lookedUp: () => void = () => {};
    let calls = 0;
    let connections = 0;
    const lookup = new Promise<void>((resolve) => {
      lookedUp = resolve;
    });
    const platform = new FeishuPlatform(credentials, {
      request: async (_input, signal) => {
        calls++;
        if (calls > 1) return { code: 0, bot: { open_id: "bot" } };
        identitySignal = signal;
        lookedUp();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      connection: ({ onReady }) => ({
        start: async () => {
          connections++;
          onReady();
        },
        close: () => {},
      }),
    });
    const controller = new AbortController();
    try {
      const starting = platform.start(handlers, controller.signal);
      const rejected = assert.rejects(starting, {
        code: stop === "stop" ? "feishu_stopped" : "feishu_aborted",
        outcome: "not_executed",
      });
      await lookup;
      if (stop === "stop") await platform.stop();
      else controller.abort();
      await rejected;
      assert.equal(identitySignal?.aborted, true);
      assert.equal(connections, 0);
      await platform.start(handlers, new AbortController().signal);
      assert.equal(connections, 1);
      release({ code: 0, bot: { open_id: "stale-bot" } });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(connections, 1, "late identity must not establish a second connection");
    } finally {
      await platform.stop();
    }
  });
}
