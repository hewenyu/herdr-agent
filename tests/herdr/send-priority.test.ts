import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { InputProgress } from "../../src/core/ports.js";
import type { AgentSnapshot, ExecutionRef } from "../../src/core/types.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { AgentControl } from "../../src/herdr/control.js";
import { startAgent } from "../../src/herdr/lifecycle.js";
import { HerdrRuntime } from "../../src/herdr/runtime.js";
import { HerdrTransport } from "../../src/herdr/transport.js";

const ref: ExecutionRef = { paneId: "w1:p1", workspaceId: "w1", kind: "claude", cwd: "/tmp" };
const agent: AgentSnapshot = {
  ...ref,
  status: "idle",
  stateSeq: "1",
  interactiveReady: true,
  launchPending: false,
};
const screen = (text: string) => `${text}\n${"─".repeat(20)}\n> \n${"─".repeat(20)}\nfooter`;

async function fixture(
  reply: (request: { id: string; method: string; params: Record<string, unknown> }) => unknown,
) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-send-guard-"));
  const socket = join(directory, "s");
  const requests: string[] = [];
  const listener = createServer((client) => {
    client.on("error", () => {});
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer);
      requests.push(request.method);
      client.end(`${JSON.stringify({ id: request.id, result: reply(request) })}\n`);
    });
  });
  await new Promise<void>((resolve) => listener.listen(socket, resolve));
  return {
    socket,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("agent.start checks lifecycle authorization after connecting, before writing", async () => {
  const f = await fixture(() => ({}));
  try {
    let authorized = true;
    const transport = new HerdrTransport(f.socket);
    const call = transport.call.bind(transport);
    transport.call = (...args) => {
      const result = call(...args);
      if (args[0] === "agent.start") authorized = false;
      return result;
    };
    await assert.rejects(
      startAgent(new HerdrClient(transport), ref.paneId, ref.kind, "executor", {
        directories: [],
        bypass: false,
        beforeWrite: () => {
          if (!authorized) throw new OperationError("revoked", "lifecycle changed");
        },
      }),
      { code: "revoked", outcome: "not_executed" },
    );
    await transport.call("ping");
    assert.deepEqual(f.requests, ["ping"]);
  } finally {
    await f.close();
  }
});

test("native startup trust rechecks authorization at socket.write and permits a refused attempt to retry", async () => {
  let authorized = true;
  let revokeDuringConnect = true;
  const current: AgentSnapshot = {
    ...agent,
    kind: "codex",
    status: "blocked",
    terminalId: "term1",
  };
  const target: ExecutionRef = { ...ref, kind: "codex" };
  const f = await fixture((request) => {
    if (request.method === "agent.send_keys") current.status = "idle";
    return {};
  });
  try {
    const transport = new HerdrTransport(f.socket);
    const call = transport.call.bind(transport);
    transport.call = (...args) => {
      const result = call(...args);
      if (args[0] === "agent.send_keys" && revokeDuringConnect) authorized = false;
      return result;
    };
    const client = new HerdrClient(transport);
    client.get = async () => ({ ...current });
    client.read = async () => ({
      truncated: false,
      text:
        current.status === "blocked"
          ? "> You are in /tmp\nDo you trust the contents of this directory?\n› 1. Yes, continue\n2. No, quit\nPress enter to continue"
          : "Welcome to your coding agent\nReady for input",
    });
    const control = new AgentControl(client);
    const guard = {
      stateSeq: "1",
      terminalId: "term1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      assertCurrent: () => {
        if (!authorized) throw new OperationError("revoked", "authorization changed");
      },
    };
    await assert.rejects(control.trustDirectory(target, target.cwd, guard), {
      code: "revoked",
      outcome: "not_executed",
    });
    await transport.call("ping");
    assert.deepEqual(f.requests, ["ping"]);
    authorized = true;
    revokeDuringConnect = false;
    await control.trustDirectory(target, target.cwd, guard);
    assert.deepEqual(f.requests, ["ping", "agent.send_keys"]);
  } finally {
    await f.close();
  }
});

test("a lifecycle change accepted while socket.connect is pending vetoes the real request write", async () => {
  const f = await fixture(() => ({}));
  try {
    let current = true;
    let checks = 0;
    const transport = new HerdrTransport(f.socket);
    const running = transport.call(
      "agent.prompt",
      { target: ref.paneId, text: "sensitive input" },
      undefined,
      undefined,
      () => {
        checks++;
        if (!current) throw new OperationError("orchestration_deferred", "new lifecycle event");
      },
    );
    // call() has dialed, but no connect callback can execute before this same turn ends.
    current = false;
    await assert.rejects(running, { code: "orchestration_deferred", outcome: "not_executed" });
    assert.equal(checks, 1);
    assert.deepEqual(f.requests, []);
    await transport.call("ping");
    assert.deepEqual(f.requests, ["ping"]);
  } finally {
    await f.close();
  }
});

test("aborting during connection never writes and does not later revive its connect callback", async () => {
  const f = await fixture(() => ({}));
  try {
    const control = new AbortController();
    const transport = new HerdrTransport(f.socket);
    const running = transport.call(
      "agent.prompt",
      { target: ref.paneId, text: "input" },
      control.signal,
    );
    control.abort();
    await assert.rejects(running, { code: "cancelled", outcome: "not_executed" });
    await transport.call("ping");
    assert.deepEqual(f.requests, ["ping"]);
  } finally {
    await f.close();
  }
});

test("new lifecycle ingress during native settle is rechecked before agent.prompt", async () => {
  let current = true;
  const f = await fixture((request) => {
    if (request.method === "agent.get") {
      current = false;
      return {
        agent: {
          pane_id: ref.paneId,
          workspace_id: ref.workspaceId,
          agent: ref.kind,
          cwd: ref.cwd,
          agent_status: "idle",
          state_change_seq: "1",
          interactive_ready: true,
        },
      };
    }
    return { read: { text: screen("old output"), truncated: false } };
  });
  try {
    const runtime = new HerdrRuntime({ socket: f.socket });
    const progress: InputProgress[] = [];
    await assert.rejects(
      runtime.send(ref, "sensitive input", {
        assertCurrent: () => {
          if (!current) throw new OperationError("orchestration_deferred", "event pending");
        },
        onProgress: (entry) => progress.push(entry),
      }),
      { code: "orchestration_deferred", outcome: "not_executed" },
    );
    assert.equal(f.requests.includes("agent.prompt"), false);
    assert.deepEqual(progress, []);
  } finally {
    await f.close();
  }
});

for (const verified of [true, false])
  test(`ingress after a real write preserves ${verified ? "verified" : "unconfirmed"} delivery and records distinct boundaries`, async () => {
    let current = true;
    let written = false;
    const secret = "private task body";
    const f = await fixture((request) => {
      if (request.method === "agent.prompt") {
        written = true;
        current = false;
      }
      if (request.method === "agent.read")
        return {
          read: { text: screen(written && verified ? secret : "old output"), truncated: false },
        };
      return {
        agent: {
          pane_id: agent.paneId,
          workspace_id: agent.workspaceId,
          agent: agent.kind,
          cwd: agent.cwd,
          agent_status: "idle",
          state_change_seq: "1",
          interactive_ready: true,
        },
      };
    });
    try {
      const progress: InputProgress[] = [];
      const result = await new HerdrRuntime({ socket: f.socket }).send(ref, secret, {
        assertCurrent: () => {
          if (!current) throw new OperationError("orchestration_deferred", "event pending");
        },
        onProgress: (entry) => progress.push(entry),
      });
      assert.equal(result.verified, verified);
      assert.equal(result.acked, true);
      assert.equal(result.status, verified ? "delivered" : "unconfirmed");
      assert.equal(f.requests.filter((method) => method === "agent.prompt").length, 1);
      assert.deepEqual(
        progress.map((entry) => entry.phase),
        ["write_started", "acknowledged", "readback_completed"],
      );
      assert.equal(progress.at(-1)?.verified, verified);
      assert.ok(progress.every((entry) => Number.isFinite(Date.parse(entry.at))));
      assert.ok(
        progress.every(
          (entry, index) => index === 0 || entry.at >= (progress[index - 1]?.at as string),
        ),
      );
      assert.equal(JSON.stringify(progress).includes(secret), false);
    } finally {
      await f.close();
    }
  });
