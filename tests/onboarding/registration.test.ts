import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
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
