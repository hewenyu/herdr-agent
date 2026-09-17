import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { parseExactJson, snapshot } from "../../src/herdr/protocol.js";
import { resolveSocketPath } from "../../src/herdr/socket-path.js";
import { HerdrTransport } from "../../src/herdr/transport.js";

async function server(reply: (request: Record<string, unknown>) => string | undefined) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-wire-"));
  const socket = join(directory, "s");
  let connections = 0;
  const requests: Record<string, unknown>[] = [];
  const listener = createServer((client) => {
    connections++;
    let buffer = "";
    client.on("error", () => {});
    client.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer) as Record<string, unknown>;
      requests.push(request);
      const response = reply(request);
      if (response !== undefined) client.end(response);
    });
  });
  await new Promise<void>((resolve) => listener.listen(socket, resolve));
  return {
    socket,
    requests,
    connections: () => connections,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("one connection per RPC, string IDs, empty params, EOF response, exact uint64", async () => {
  const mock = await server(
    (request) => `{"id":${JSON.stringify(request.id)},"result":{"seq":18446744073709551615}}`,
  );
  try {
    const client = new HerdrTransport(mock.socket);
    assert.deepEqual(await client.call("ping"), { seq: "18446744073709551615" });
    await client.call("ping");
    assert.equal(mock.connections(), 2);
    assert.equal(typeof mock.requests[0]?.id, "string");
    assert.deepEqual(mock.requests[0]?.params, {});
  } finally {
    await mock.close();
  }
});

test("invalid id and post-write timeout preserve unknown effect", async () => {
  const mock = await server(() => '{"id":"wrong","result":{}}\n');
  try {
    await assert.rejects(
      new HerdrTransport(mock.socket).call("agent.prompt", { target: "w1:p1", text: "x" }),
      (error: unknown) => error instanceof OperationError && error.outcome === "unknown",
    );
  } finally {
    await mock.close();
  }
  const silent = await server(() => undefined);
  try {
    await assert.rejects(
      new HerdrTransport(silent.socket, 30).call("agent.prompt", { target: "w1:p1", text: "x" }),
      (error: unknown) =>
        error instanceof OperationError && error.code === "timeout" && error.outcome === "unknown",
    );
  } finally {
    await silent.close();
  }
});

test("explicit refusal accepts empty error id; forbidden reads never dial", async () => {
  const mock = await server(
    () => '{"id":"","error":{"code":"agent_pane_busy","message":"busy"}}\n',
  );
  try {
    const client = new HerdrTransport(mock.socket);
    await assert.rejects(
      client.call("agent.start", {}),
      (error: unknown) => error instanceof OperationError && error.outcome === "not_executed",
    );
    await assert.rejects(client.call("agent.read", { source: "recent" }), /仅允许/);
    await assert.rejects(client.call("server.stop"), /不支持/);
    assert.equal(mock.connections(), 1);
  } finally {
    await mock.close();
  }
});

test("integer protection does not alter numeric strings or ordinary numbers", () => {
  const decoded = parseExactJson('{"x":"18446744073709551615","y":42,"z":18446744073709551615}');
  assert.deepEqual(decoded, { x: "18446744073709551615", y: 42, z: "18446744073709551615" });
  assert.equal(
    snapshot({ pane_id: "w1:p1", state_change_seq: "18446744073709551615" }).stateSeq,
    "18446744073709551615",
  );
  assert.throws(() => snapshot({ pane_id: "w1:p1", state_change_seq: 2 ** 53 }), /不精确/);
});

test("socket resolution follows herdr named-session rules", () => {
  assert.equal(resolveSocketPath("/explicit", { HERDR_SOCKET_PATH: "/env" }, "/u"), "/explicit");
  assert.equal(
    resolveSocketPath(undefined, { HERDR_SESSION: "dev", XDG_CONFIG_HOME: "/cfg" }, "/u"),
    "/cfg/herdr/sessions/dev/herdr.sock",
  );
  assert.equal(
    resolveSocketPath(undefined, { HERDR_SESSION: "../escape" }, "/u"),
    "/u/.config/herdr/herdr.sock",
  );
  assert.equal(
    resolveSocketPath(undefined, { HERDR_SESSION: "default" }, "/u"),
    "/u/.config/herdr/herdr.sock",
  );
});
