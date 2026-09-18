import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import type { WebAssets, WebBackend } from "../../src/web/contracts.js";
import { parseListen } from "../../src/web/security.js";
import { startWeb } from "../../src/web/server.js";

const assets: WebAssets = {
  "index.html":
    '<html><meta name="csrf-token" content="__CSRF_TOKEN__"><script src="/app.js"></script></html>',
  "styles.css": "body{color:green}",
  "app.js": 'console.log("workspace")',
};

function backend() {
  let listener: (() => void) | undefined;
  let released = false;
  const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
  const port: WebBackend = {
    history: (ownerId) => ({
      ...(ownerId === undefined ? {} : { activeOwnerId: ownerId }),
      sessions: [],
      authorization: { status: "setup_required" },
    }),
    dispatch: async (action, input) => {
      calls.push({ action, input });
      return { action, input };
    },
    subscribe: (callback) => {
      listener = callback;
      return () => {
        released = true;
      };
    },
  };
  return { port, calls, notify: () => listener?.(), released: () => released };
}

test("loopback address validation rejects network listeners", () => {
  assert.deepEqual(parseListen("127.0.0.1:0"), { host: "127.0.0.1", port: 0 });
  assert.deepEqual(parseListen("[::1]:18790"), { host: "::1", port: 18790 });
  for (const address of [
    "0.0.0.0:18790",
    "192.168.1.2:18790",
    "evil.example:80",
    "127.0.0.1:99999",
    "localhost",
  ])
    assert.throws(() => parseListen(address), /loopback/);
});

test("serves read-only assets and owner-scoped history with CSP and no cache", async () => {
  const mock = backend();
  const web = await startWeb({ listen: "127.0.0.1:0", backend: mock.port, assets });
  try {
    const response = await fetch(web.url);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /name="csrf-token" content="[a-f0-9]{64}"/);
    assert.doesNotMatch(html, /__CSRF_TOKEN__/);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      (await fetch(`${web.url}/app.js`)).headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    assert.deepEqual(await (await fetch(`${web.url}/api/state`)).json(), mock.port.history());
    assert.equal((await fetch(`${web.url}/api/state?ownerId=second`)).status, 200);
    assert.equal(
      (
        (await (await fetch(`${web.url}/api/state?ownerId=second`)).json()) as {
          activeOwnerId: string;
        }
      ).activeOwnerId,
      "second",
    );
    assert.equal((await fetch(`${web.url}/config.toml`)).status, 404);
  } finally {
    await web.close();
  }
  assert.equal(mock.released(), true);
});

test("rejects Host rebinding and cross-origin state reads", async () => {
  const web = await startWeb({ listen: "127.0.0.1:0", backend: backend().port, assets });
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const call = request(
        `${web.url}/api/state`,
        { headers: { Host: "evil.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      call.on("error", reject);
      call.end();
    });
    assert.equal(status, 403);
    assert.equal(
      (await fetch(`${web.url}/api/state`, { headers: { Origin: "https://evil.example" } })).status,
      403,
    );
    assert.equal(
      (await fetch(`${web.url}/api/state`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status,
      403,
    );
  } finally {
    await web.close();
  }
});

test("configuration writes require CSRF and business actions stay in Feishu", async () => {
  const mock = backend();
  let reads = 0;
  const history = mock.port.history;
  mock.port.history = (owner) => {
    reads++;
    return history(owner);
  };
  const web = await startWeb({ listen: "127.0.0.1:0", backend: mock.port, assets });
  try {
    const html = await (await fetch(web.url)).text();
    const csrf = html.match(/name="csrf-token" content="([^"]+)"/)?.[1];
    assert.ok(csrf);
    const write = (action: string, input: Record<string, unknown> = {}) =>
      fetch(`${web.url}/api/actions`, {
        method: "POST",
        headers: {
          Origin: web.url,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
        },
        body: JSON.stringify({ action, input }),
      });
    assert.equal((await write("project.save", { name: "demo" })).status, 200);
    assert.equal((await write("config.ai", { model: "test" })).status, 200);
    assert.deepEqual(
      mock.calls.map(({ action }) => action),
      ["project.save", "config.ai"],
    );
    for (const action of [
      "session.create",
      "chat.send",
      "task.create",
      "task.action",
      "participant.answer",
      "approval.answer",
    ]) {
      const response = await write(action, { text: "/clear" });
      assert.equal(response.status, 403, action);
      assert.equal((await response.json()).error.code, "web_action_forbidden");
    }
    assert.equal(
      (
        await fetch(`${web.url}/api/actions`, {
          method: "POST",
          headers: { Origin: web.url, "Content-Type": "application/json", "X-CSRF-Token": "wrong" },
          body: JSON.stringify({ action: "project.default", input: { name: "demo" } }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${web.url}/api/actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify({ action: "project.default", input: { name: "demo" } }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${web.url}/api/actions`, {
          method: "POST",
          headers: { Origin: web.url, "X-CSRF-Token": csrf },
          body: JSON.stringify({ action: "project.default", input: { name: "demo" } }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(`${web.url}/api/state`, { method: "POST", body: "not-json" })).status,
      405,
    );
    assert.equal((await fetch(`${web.url}/api/actions?action=chat.send&text=/clear`)).status, 404);
    assert.equal(reads, 0);
  } finally {
    await web.close();
  }
});

test("SSE broadcasts changes and shuts down without holding the listener", async () => {
  const mock = backend();
  const web = await startWeb({ listen: "127.0.0.1:0", backend: mock.port, assets });
  const controller = new AbortController();
  try {
    const response = await fetch(`${web.url}/api/events`, { signal: controller.signal });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body?.getReader();
    assert.ok(reader);
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
    mock.notify();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: change/);
    await reader.cancel();
  } finally {
    controller.abort();
    await web.close();
  }
  assert.equal(mock.released(), true);
});
