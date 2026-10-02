import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { OperationError } from "../../src/core/errors.js";
import { registerApp, validAuthorizationURL } from "../../src/onboarding/registration.js";

const begin = {
  device_code: "private-device-code",
  verification_uri_complete: "https://open.feishu.cn/app/registration?code=opaque",
  expires_in: 600,
  interval: 0.001,
};
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

test("registration builds SDK-compatible addons and follows Lark switch only to fixed host", async () => {
  const hosts: string[] = [];
  const forms: URLSearchParams[] = [];
  const statuses: string[] = [];
  let shown = "";
  const answers = [
    begin,
    { error: "authorization_pending", user_info: { tenant_brand: "lark" } },
    {
      client_id: "cli_new",
      client_secret: "test-secret",
      user_info: { open_id: "owner", tenant_brand: "lark" },
    },
  ];
  const result = await registerApp({
    appId: "cli_new",
    onURL: (info) => {
      shown = info.url;
    },
    onStatus: ({ status }) => statuses.push(status),
    fetch: async (url, init) => {
      hosts.push(new URL(String(url)).hostname);
      forms.push(new URLSearchParams(String(init?.body)));
      assert.equal(init?.redirect, "error");
      return response(answers.shift());
    },
  });
  assert.deepEqual(hosts, ["accounts.feishu.cn", "accounts.feishu.cn", "accounts.larksuite.com"]);
  assert.equal(forms[0]?.get("archetype"), "PersonalAgent");
  assert.equal(forms[1]?.get("device_code"), "private-device-code");
  const url = new URL(shown);
  assert.equal(url.searchParams.get("clientID"), "cli_new");
  assert.equal(url.searchParams.get("source"), "node-sdk/myrix");
  assert.equal(url.searchParams.get("name"), "myrix");
  const addons = JSON.parse(
    gunzipSync(Buffer.from(url.searchParams.get("addons") ?? "", "base64url")).toString(),
  );
  assert.ok(addons.scopes.tenant.includes("task:task:write"));
  assert.deepEqual(addons.events.items.tenant, [
    "im.message.receive_v1",
    "im.chat.disbanded_v1",
    "task.task.update_user_access_v2",
  ]);
  assert.deepEqual(addons.callbacks.items, ["card.action.trigger"]);
  assert.deepEqual(statuses, ["domain_switched"]);
  assert.deepEqual(result, {
    appId: "cli_new",
    appSecret: "test-secret",
    openId: "owner",
    brand: "lark",
  });
});

test("registration requests task and group events only when tasks are enabled", async () => {
  for (const tasks of [true, false]) {
    let shown = "";
    await registerApp({
      tasks,
      onURL: ({ url }) => {
        shown = url;
      },
      fetch: async (_url, init) =>
        response(
          String(init?.body).includes("action=begin")
            ? begin
            : { client_id: "cli_new", client_secret: "test-secret" },
        ),
    });
    const addons = JSON.parse(
      gunzipSync(
        Buffer.from(new URL(shown).searchParams.get("addons") ?? "", "base64url"),
      ).toString(),
    );
    assert.deepEqual(
      addons.events.items.tenant,
      tasks
        ? ["im.message.receive_v1", "im.chat.disbanded_v1", "task.task.update_user_access_v2"]
        : ["im.message.receive_v1"],
    );
  }
});

test("target conflict and unsafe confirmation links fail without unauthorized network or callbacks", async () => {
  let calls = 0;
  await assert.rejects(
    registerApp({
      appId: "cli_old",
      createOnly: true,
      onURL: () => {},
      fetch: async () => {
        calls++;
        return response(begin);
      },
    }),
    { code: "registration_target" },
  );
  assert.equal(calls, 0);
  for (const url of [
    "http://open.feishu.cn/a",
    "https://evil.example/a",
    "https://user@open.feishu.cn/a",
    "https://open.feishu.cn:8443/a",
  ]) {
    assert.equal(validAuthorizationURL(url), false);
    await assert.rejects(
      registerApp({
        onURL: () => assert.fail("unsafe link"),
        fetch: async () => response({ ...begin, verification_uri_complete: url }),
      }),
      { code: "registration_response" },
    );
  }
});

test("cancellation during begin aborts HTTP and never exposes a late QR code", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  let callback = false;
  const run = registerApp({
    signal: controller.signal,
    onURL: () => {
      callback = true;
    },
    fetch: async (_url, init) => {
      signal = init?.signal;
      controller.abort();
      return response(begin);
    },
  });
  await assert.rejects(run, { code: "authorization_aborted" });
  assert.equal(signal?.aborted, true);
  assert.equal(callback, false);
});

test("unknown outcome does not retry begin/poll and does not disclose response secrets", async () => {
  let calls = 0;
  await assert.rejects(
    registerApp({
      onURL: () => {},
      fetch: async () => {
        calls++;
        if (calls === 1) return response(begin);
        throw new Error("secret device_code=private-device-code");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("private-device-code"));
      return true;
    },
  );
  assert.equal(calls, 2);
  await assert.rejects(
    registerApp({
      appId: "cli_old",
      onURL: () => {},
      fetch: async (_url, init) =>
        response(
          String(init?.body).includes("action=begin")
            ? begin
            : { client_id: "cli_other", client_secret: "secret" },
        ),
    }),
    { code: "registration_wrong_app" },
  );
});

test("HTTP 400 pending is polled; denial and expiry remain distinguishable", async () => {
  for (const [remote, code] of [
    ["access_denied", "authorization_denied"],
    ["expired_token", "authorization_expired"],
  ]) {
    let calls = 0;
    await assert.rejects(
      registerApp({
        onURL: () => {},
        fetch: async () => {
          calls++;
          if (calls === 1) return response(begin);
          if (calls === 2) return response({ error: "authorization_pending" }, 400);
          return response({ error: remote, error_description: "untrusted detail" }, 400);
        },
      }),
      { code },
    );
    assert.equal(calls, 3);
  }
});

test("a pre-aborted caller never dispatches begin and normalizes every abort reason", async () => {
  for (const reason of [
    undefined,
    new Error("sensitive pre-abort detail"),
    "sensitive pre-abort detail",
    false,
  ]) {
    const controller = new AbortController();
    reason === undefined ? controller.abort() : controller.abort(reason);
    let calls = 0;
    let qr = false;
    await assert.rejects(
      registerApp({
        signal: controller.signal,
        onURL: () => {
          qr = true;
        },
        fetch: async () => {
          calls++;
          return response(begin);
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, "authorization_aborted");
        assert.ok(!error.message.includes("sensitive"));
        return true;
      },
    );
    assert.equal(calls, 0);
    assert.equal(qr, false);
  }
});

test("oversized remote interval is capped instead of flooding the endpoint", {
  timeout: 5000,
}, async () => {
  const statuses: Array<number | undefined> = [];
  let calls = 0;
  const started = Date.now();
  await assert.rejects(
    registerApp({
      timeoutMs: 150,
      onURL: () => {},
      onStatus: ({ status, interval }) => {
        if (status === "slow_down") statuses.push(interval);
      },
      fetch: async () => {
        calls++;
        return response(
          calls === 1
            ? { ...begin, interval: 5_000_000, expires_in: 600 }
            : { error: "authorization_pending" },
        );
      },
    }),
    { code: "authorization_expired" },
  );
  // After begin and the first poll, the local budget must expire before another poll.
  assert.ok(calls <= 2, `expected no repeated polling, saw ${calls} calls`);
  assert.ok(Date.now() - started >= 100, "the capped interval must actually wait");
});

test("overflowing finite remote timing never overflows a timer or falsely expires early", async () => {
  for (const expires_in of [1e12, 1e303]) {
    let shown = "";
    let calls = 0;
    await assert.rejects(
      registerApp({
        // A short local budget proves the deadline, not a RangeError, ends the wait.
        timeoutMs: 100,
        onURL: ({ expiresAt }) => {
          shown = expiresAt;
        },
        fetch: async () => {
          calls++;
          return response(
            calls === 1 ? { ...begin, expires_in } : { error: "authorization_pending" },
          );
        },
      }),
      { code: "authorization_expired" },
    );
    assert.ok(shown, "an oversized expiry still yields a usable absolute deadline");
    assert.ok(!Number.isNaN(Date.parse(shown)), "the advertised deadline must be a valid date");
    // The advertised deadline never exceeds the local budget-derived deadline.
    const remaining = Date.parse(shown) - Date.now();
    assert.ok(remaining <= 1_500, `advertised deadline ${shown} must respect the local budget`);
  }
});

test("non-finite or millisecond-overflowing remote timing is rejected before callbacks or timers", async () => {
  // 1e307 seconds cannot even be represented as milliseconds, so it is malformed rather than
  // silently capped.
  for (const field of ["expires_in", "interval"] as const)
    for (const value of [Number.POSITIVE_INFINITY, Number.NaN, 1e307]) {
      let qr = false;
      await assert.rejects(
        registerApp({
          onURL: () => {
            qr = true;
          },
          fetch: async () => {
            // JSON cannot carry Infinity/NaN, so the parsed body is supplied directly.
            const body = new Response("{}");
            body.json = async () => ({ ...begin, [field]: value });
            return body;
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof OperationError);
          assert.equal(error.code, "registration_response");
          return true;
        },
      );
      assert.equal(qr, false);
    }
});

test("unusable non-positive remote timing is rejected as a malformed response before callbacks", async () => {
  for (const timing of [{ expires_in: 0 }, { expires_in: -1 }, { interval: 0 }, { interval: -5 }]) {
    let qr = false;
    await assert.rejects(
      registerApp({
        onURL: () => {
          qr = true;
        },
        fetch: async () => response({ ...begin, ...timing }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, "registration_response");
        return true;
      },
    );
    assert.equal(qr, false);
  }
});

test("slow_down reports its backoff and the local budget bounds the wait", {
  timeout: 5000,
}, async () => {
  const steps: number[] = [];
  let calls = 0;
  await assert.rejects(
    registerApp({
      timeoutMs: 120,
      onURL: () => {},
      onStatus: ({ status, interval }) => {
        if (status === "slow_down" && interval !== undefined) steps.push(interval);
      },
      fetch: async () => {
        calls++;
        // This first backoff exceeds the local budget; waiting must still abort promptly.
        return response(calls === 1 ? begin : { error: "slow_down" });
      },
    }),
    { code: "authorization_expired" },
  );
  assert.ok(steps.length >= 1);
  assert.ok(
    steps.every(
      (seconds) => Number.isFinite(seconds) && seconds > 0 && seconds <= 2_147_483_647 / 1000,
    ),
    `slow_down intervals must stay within the native timer range: ${steps.join(", ")}`,
  );
});

test("begin request has a bounded aborting timeout", async () => {
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      registerApp({
        requestTimeoutMs: 5,
        onURL: () => assert.fail("no QR"),
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("timed out")), {
              once: true,
            });
          }),
      }),
      { code: "authorization_transport" },
    );
  } finally {
    clearTimeout(keepAlive);
  }
});
