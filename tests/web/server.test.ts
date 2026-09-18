import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import type { WebAssets, WebBackend } from "../../src/web/contracts.js";
import { parseListen } from "../../src/web/security.js";
import { startWeb } from "../../src/web/server.js";

const assets: WebAssets = {
  "index.html": '<html><script src="/app.js"></script></html>',
  "styles.css": "body{color:green}",
  "app.js": 'console.log("workspace")',
};

function backend() {
  let listener: (() => void) | undefined;
  let released = false;
  const port: WebBackend = {
    history: (ownerId) => ({
      ...(ownerId === undefined ? {} : { activeOwnerId: ownerId }),
      sessions: [],
      authorization: { status: "setup_required" },
    }),
    subscribe: (callback) => {
      listener = callback;
      return () => {
        released = true;
      };
    },
  };
  return { port, notify: () => listener?.(), released: () => released };
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
    assert.equal(html, assets["index.html"]);
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

test("all write methods and historical action names are unavailable", async () => {
  const mock = backend();
  let reads = 0;
  const history = mock.port.history;
  mock.port.history = (owner) => {
    reads++;
    return history(owner);
  };
  const web = await startWeb({ listen: "127.0.0.1:0", backend: mock.port, assets });
  try {
    for (const action of [
      "identity.select",
      "session.create",
      "session.select",
      "session.archive",
      "session.clear",
      "session.restore",
      "chat.send",
      "chat.ack",
      "task.create",
      "task.action",
      "participant.answer",
      "participant.send",
      "participant.interrupt",
      "project.save",
      "config.ai",
    ])
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await fetch(`${web.url}/api/actions`, {
          method,
          headers: {
            Origin: web.url,
            "Content-Type": "application/json",
            "X-CSRF-Token": "old-page-token",
          },
          body: JSON.stringify({ action, input: { text: "/clear" } }),
        });
        assert.equal(response.status, 405, `${method} ${action}`);
        assert.equal(response.headers.get("allow"), "GET");
        assert.deepEqual(await response.json(), {
          ok: false,
          error: {
            code: "read_only",
            message: "Web 仅供查看会话记录。",
            outcome: "not_executed",
          },
        });
      }
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
