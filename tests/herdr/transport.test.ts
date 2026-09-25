import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { startAgent } from "../../src/herdr/lifecycle.js";
import { parseExactJson, snapshot } from "../../src/herdr/protocol.js";
import { resolveSocketPath } from "../../src/herdr/socket-path.js";
import { HerdrTransport } from "../../src/herdr/transport.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

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

test("explicit refusal requires the matching request id; forbidden reads never dial", async () => {
  const mock = await server(
    (request) =>
      `${JSON.stringify({ id: request.id, error: { code: "agent_pane_busy", message: "busy" } })}\n`,
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

test("unmatched error response IDs never turn a submitted write into a definite refusal", async () => {
  for (const id of ["wrong-id", "", undefined]) {
    const mock = await server(() =>
      JSON.stringify({ id, error: { code: "invalid_agent_name", message: "invalid name" } }),
    );
    try {
      await assert.rejects(new HerdrTransport(mock.socket).call("agent.start", {}), {
        code: "invalid_response",
        outcome: "unknown",
      });
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  }
});

test("name validation refusals are definite only for agent.start", async () => {
  for (const code of ["invalid_agent_name", "agent_name_taken"]) {
    const mock = await server((request) =>
      JSON.stringify({ id: request.id, error: { code, message: "name rejected before start" } }),
    );
    try {
      const client = new HerdrTransport(mock.socket);
      await assert.rejects(client.call("agent.start", {}), { code, outcome: "not_executed" });
      for (const method of ["agent.prompt", "agent.send_keys", "pane.close"])
        await assert.rejects(client.call(method, {}), { code, outcome: "unknown" });
    } finally {
      await mock.close();
    }
  }
});

test("agent_blocked is a definite prompt refusal but stalled prompts remain unknown", async () => {
  for (const code of ["agent_blocked", "agent_prompt_stalled"]) {
    const mock = await server((request) =>
      JSON.stringify({ id: request.id, error: { code, message: "upstream prompt outcome" } }),
    );
    try {
      const client = new HerdrTransport(mock.socket);
      await assert.rejects(client.call("agent.prompt", { target: "w1:p1", text: "continue" }), {
        code,
        outcome: code === "agent_blocked" ? "not_executed" : "unknown",
      });
      await assert.rejects(client.call("agent.send_keys", {}), { code, outcome: "unknown" });
    } finally {
      await mock.close();
    }
  }
});

function started(request: Record<string, unknown>, nameOverride?: string) {
  const params = request.params as Record<string, unknown>;
  return JSON.stringify({
    id: request.id,
    result: {
      argv: [params.kind, ...((params.args as string[] | undefined) ?? [])],
      agent: {
        pane_id: params.pane_id,
        workspace_id: String(params.pane_id).includes(":")
          ? String(params.pane_id).split(":")[0]
          : `w${String(params.pane_id).slice(1)}`,
        terminal_id: `terminal-${params.pane_id}`,
        agent: params.kind,
        agent_status: "idle",
        name: nameOverride ?? params.name,
        agent_session: { kind: "id", value: "native-session" },
        interactive_ready: true,
        launch_pending: false,
      },
    },
  });
}

test("wire startup maps display names safely and deterministically without truncation collisions", async () => {
  const mock = await server((request) => {
    const params = request.params as Record<string, unknown>;
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(String(params.name)))
      return JSON.stringify({
        id: request.id,
        error: { code: "invalid_agent_name", message: "name violates actual herdr grammar" },
      });
    return started(request);
  });
  try {
    const client = new HerdrClient(new HerdrTransport(mock.socket));
    const names = [
      "codex",
      "reviewer-1",
      "a".repeat(32),
      "Codex",
      "Claude",
      "需求分析师",
      "1reviewer",
      "agent".repeat(12),
      `${"same-prefix".repeat(8)}A`,
      `${"same-prefix".repeat(8)}B`,
    ];
    const mapped = new Set<string>();
    for (const name of names) {
      const options = { directories: [], bypass: false };
      const first = await startAgent(client, "w1:p1", "codex", name, options);
      const repeated = await startAgent(client, "w1:p1", "codex", name, options);
      assert.match(first.name ?? "", /^[a-z][a-z0-9_-]{0,31}$/);
      assert.equal(first.name, repeated.name);
      assert.equal(mapped.has(first.name ?? ""), false, "full original names stay distinct");
      mapped.add(first.name ?? "");
      if (/^[a-z][a-z0-9_-]{0,31}$/.test(name)) assert.equal(first.name, name);
      else {
        assert.notEqual(first.name, name);
        const otherPane = await startAgent(client, "w2:p1", "codex", name, options);
        assert.notEqual(otherPane.name, first.name, "same display names have pane-specific names");
      }
    }
    assert.ok(mock.requests.every((request) => request.method === "agent.start"));
  } finally {
    await mock.close();
  }
});

test("a definite legal-name collision gets one scoped fallback; unknown startup never changes name", async () => {
  const mock = await server((request) => {
    const params = request.params as Record<string, unknown>;
    return params.name === "reviewer"
      ? JSON.stringify({
          id: request.id,
          error: { code: "agent_name_taken", message: "already used on another pane" },
        })
      : started(request);
  });
  try {
    const client = new HerdrClient(new HerdrTransport(mock.socket));
    const options = { directories: [], bypass: false };
    const first = await startAgent(client, "w1:p1", "claude", "reviewer", options);
    const second = await startAgent(client, "w2:p1", "claude", "reviewer", options);
    assert.notEqual(first.name, second.name);
    assert.match(first.name ?? "", /^[a-z][a-z0-9_-]{0,31}$/);
    assert.equal(mock.requests.length, 4);
    assert.deepEqual(
      mock.requests.map((request) => (request.params as { name: string }).name),
      ["reviewer", first.name, "reviewer", second.name],
    );
  } finally {
    await mock.close();
  }
  for (const code of ["agent_name_taken", "agent_start_input_failed"]) {
    const refused = await server((request) =>
      JSON.stringify({ id: request.id, error: { code, message: "startup rejected" } }),
    );
    try {
      await assert.rejects(
        startAgent(new HerdrClient(new HerdrTransport(refused.socket)), "w1:p1", "codex", "Codex", {
          directories: [],
          bypass: false,
        }),
        { code, outcome: code === "agent_name_taken" ? "not_executed" : "unknown" },
      );
      assert.equal(refused.requests.length, 1, "a mapped name is never changed after refusal");
    } finally {
      await refused.close();
    }
  }
});

test("startup identity is checked against the mapped native name", async () => {
  const mock = await server((request) => started(request, "Codex"));
  try {
    await assert.rejects(
      startAgent(new HerdrClient(new HerdrTransport(mock.socket)), "w1:p1", "codex", "Codex", {
        directories: [],
        bypass: false,
      }),
      { code: "target_changed", outcome: "unknown" },
    );
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});

test("task participants keep display names while real wire startup uses native-safe names", async () => {
  const mock = await server((request) => started(request));
  const h = setup();
  try {
    const client = new HerdrClient(new HerdrTransport(mock.socket));
    h.herdr.startAgent = async (paneId, kind, name, options) => {
      const agent = await startAgent(client, paneId, kind, name, { ...options, bypass: false });
      h.herdr.agents.set(paneId, { ...agent, cwd: options.directories[0] ?? "" });
      return agent;
    };
    const task = await h.service.create(actor, {
      ...discussion,
      participants: [
        { kind: "codex", name: "Codex" },
        { kind: "claude", name: "中文评审" },
      ],
    });
    await h.service.reconcile(task.id);
    const participants = h.service.get(actor, task.id).participants;
    assert.deepEqual(
      participants.map((participant) => participant.name),
      ["Codex", "中文评审"],
    );
    assert.ok(participants.every((participant) => participant.started));
    assert.equal(mock.requests.length, 2);
    const nativeNames = mock.requests.map((request) => (request.params as { name: string }).name);
    assert.ok(nativeNames.every((name) => /^[a-z][a-z0-9_-]{0,31}$/.test(name)));
    assert.notEqual(nativeNames[0], nativeNames[1]);
  } finally {
    h.close();
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
