import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
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
  const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
  let listener: (() => void) | undefined;
  let released = false;
  const port: WebBackend = {
    snapshot: () => ({ sessions: [], authorization: { status: "setup_required" } }),
    dispatch: async (action, input) => {
      calls.push({ action, input });
      return { accepted: true };
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

async function token(url: string): Promise<string> {
  const html = await (await fetch(url)).text();
  return /content="([a-f0-9]+)"/.exec(html)?.[1] ?? "";
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

test("serves injected assets and state with CSP, no cache and fresh CSRF token", async () => {
  const mock = backend();
  const web = await startWeb({ listen: "127.0.0.1:0", backend: mock.port, assets });
  try {
    const response = await fetch(web.url);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(html.includes("__CSRF_TOKEN__"), false);
    assert.match(html, /[a-f0-9]{64}/);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      (await fetch(`${web.url}/app.js`)).headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    assert.deepEqual(await (await fetch(`${web.url}/api/state`)).json(), mock.port.snapshot());
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

test("writes require exact origin and CSRF; valid action dispatched once", async () => {
  const mock = backend();
  const web = await startWeb({ listen: "127.0.0.1:0", backend: mock.port, assets });
  try {
    const csrf = await token(web.url);
    const body = JSON.stringify({ action: "project.save", input: { name: "demo" } });
    for (const headers of <Record<string, string>[]>[
      { "Content-Type": "application/json" },
      { "Content-Type": "application/json", Origin: web.url, "X-CSRF-Token": "wrong" },
      { "Content-Type": "application/json", Origin: "https://evil.example", "X-CSRF-Token": csrf },
    ])
      assert.equal(
        (await fetch(`${web.url}/api/actions`, { method: "POST", headers, body })).status,
        403,
      );
    assert.equal(mock.calls.length, 0);
    const response = await fetch(`${web.url}/api/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: web.url, "X-CSRF-Token": csrf },
      body,
    });
    assert.deepEqual(await response.json(), { ok: true, result: { accepted: true } });
    assert.deepEqual(mock.calls, [{ action: "project.save", input: { name: "demo" } }]);
  } finally {
    await web.close();
  }
});

test("malformed and oversized body cannot reach backend; unknown outcome remains explicit", async () => {
  const mock = backend();
  mock.port.dispatch = async () => {
    throw new OperationError("timeout", "执行回执未知", "unknown");
  };
  const web = await startWeb({ listen: "127.0.0.1:0", backend: mock.port, assets });
  try {
    const headers = {
      "Content-Type": "application/json",
      Origin: web.url,
      "X-CSRF-Token": await token(web.url),
    };
    assert.equal(
      (await fetch(`${web.url}/api/actions`, { method: "POST", headers, body: "not-json" })).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${web.url}/api/actions`, {
          method: "POST",
          headers,
          body: "x".repeat(1_048_577),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await fetch(`${web.url}/api/actions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "oops", input: {} }),
        })
      ).status,
      400,
    );
    const response = await fetch(`${web.url}/api/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "task.action", input: { id: "task" } }),
    });
    const body = (await response.json()) as { error: { outcome: string } };
    assert.equal(body.error.outcome, "unknown");
    assert.equal(mock.calls.length, 0);
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
