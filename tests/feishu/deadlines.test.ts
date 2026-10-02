import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
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

for (const reason of [
  new Error("sensitive handshake cancellation detail"),
  "sensitive handshake cancellation detail",
]) {
  test(`handshake cancellation normalizes ${reason instanceof Error ? "an Error" : "a string"} reason`, {
    timeout: 1000,
  }, async () => {
    let closed = 0;
    const platform = new FeishuPlatform(credentials, {
      request: async () => ({ code: 0, bot: { open_id: "bot" } }),
      connection: () => ({
        start: async () => {},
        close: () => {
          closed++;
        },
      }),
    });
    const controller = new AbortController();
    const starting = platform.start(handlers, controller.signal);
    const rejected = assert.rejects(starting, (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "feishu_aborted");
      assert.equal(error.outcome, "not_executed");
      assert.ok(!error.message.includes("sensitive"));
      return true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(reason);
    await rejected;
    assert.ok(closed > 0, "cancellation must close the transport");
    await platform.stop();
  });
}

test("caller abort during the identity gap is classified, not reported as an internal stop", {
  timeout: 1000,
}, async () => {
  let lookedUp: () => void = () => {};
  const lookup = new Promise<void>((resolve) => {
    lookedUp = resolve;
  });
  let calls = 0;
  const platform = new FeishuPlatform(credentials, {
    request: async () => {
      calls++;
      if (calls === 1) {
        lookedUp();
        // Never settles: the caller aborts while identity is still pending.
        return new Promise(() => {});
      }
      return { code: 0, bot: { open_id: "bot" } };
    },
  });
  const controller = new AbortController();
  try {
    const starting = platform.start(handlers, controller.signal);
    const rejected = assert.rejects(starting, (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "feishu_aborted");
      assert.equal(error.outcome, "not_executed");
      assert.ok(!error.message.includes("sensitive"));
      return true;
    });
    await lookup;
    controller.abort(new Error("sensitive identity-gap detail"));
    await rejected;
  } finally {
    await platform.stop();
  }
});

test("a pre-aborted caller never dispatches identity or opens a connection", async () => {
  let requests = 0;
  let connections = 0;
  const platform = new FeishuPlatform(credentials, {
    request: async () => {
      requests++;
      return { code: 0, bot: { open_id: "bot" } };
    },
    connection: () => {
      connections++;
      return { start: async () => {}, close: () => {} };
    },
  });
  const controller = new AbortController();
  controller.abort("sensitive pre-abort detail");
  await assert.rejects(platform.start(handlers, controller.signal), (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, "feishu_aborted");
    assert.equal(error.outcome, "not_executed");
    assert.ok(!error.message.includes("sensitive"));
    return true;
  });
  assert.equal(requests, 0);
  assert.equal(connections, 0);
  await platform.stop();
});

test("an internal stop keeps feishu_stopped semantics and cannot be mistaken for a caller abort", {
  timeout: 1000,
}, async () => {
  let ready: () => void = () => {};
  let connected: () => void = () => {};
  const created = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const platform = new FeishuPlatform(credentials, {
    request: async () => ({ code: 0, bot: { open_id: "bot" } }),
    connection: ({ onReady }) => {
      ready = onReady;
      return {
        start: async () => {
          connected();
        },
        close: () => {},
      };
    },
  });
  const controller = new AbortController();
  try {
    const starting = platform.start(handlers, controller.signal);
    const rejected = assert.rejects(starting, (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "feishu_stopped");
      assert.equal(error.outcome, "not_executed");
      return true;
    });
    await created;
    await platform.stop();
    await rejected;
    // A late ready must not settle the already-stopped generation.
    ready();
  } finally {
    await platform.stop();
  }
});
