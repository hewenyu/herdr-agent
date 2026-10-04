import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { ExecutionRef } from "../../src/core/types.js";
import { approvalFailureEvidence } from "../../src/herdr/approval-error.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { AgentControl } from "../../src/herdr/control.js";
import { screenFingerprint } from "../../src/herdr/screen.js";
import { HerdrTransport } from "../../src/herdr/transport.js";

const ref: ExecutionRef = { paneId: "w1:p1", workspaceId: "w1", kind: "codex", cwd: "/tmp" };
const menu = "Permission required\n❯ 1. Allow once\n  2. Cancel\nEnter to confirm";
const ready = "Welcome to your coding agent\nReady for input";

type Guard = Parameters<AgentControl["answer"]>[2];

function guard(overrides: Partial<Guard> = {}): Guard {
  return {
    stateSeq: "1",
    sessionId: "s1",
    terminalId: "term1",
    cwd: ref.cwd,
    screenFingerprint: screenFingerprint(menu),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function snapshot(status: string) {
  return {
    pane_id: ref.paneId,
    workspace_id: ref.workspaceId,
    agent: ref.kind,
    cwd: ref.cwd,
    terminal_id: "term1",
    agent_session: { kind: "id", value: "s1" },
    agent_status: status,
    state_change_seq: "1",
    interactive_ready: true,
    launch_pending: false,
  };
}

async function fixture(
  reply: (request: { id: string; method: string; params: Record<string, unknown> }) => unknown,
) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-approval-boundary-"));
  const socket = join(directory, "s");
  const requests: string[] = [];
  const keys: string[][] = [];
  const listener = createServer((client) => {
    client.on("error", () => {});
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer);
      requests.push(request.method);
      if (request.method === "agent.send_keys") keys.push(request.params.keys);
      client.end(`${JSON.stringify({ id: request.id, result: reply(request) })}\n`);
    });
  });
  await new Promise<void>((resolve) => listener.listen(socket, resolve));
  return {
    socket,
    requests,
    keys,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * socket.connect is asynchronous, so an approval accepted at the last observation
 * can still be revoked or expire before the request bytes are handed to the socket.
 * These tests drive a real Unix socket and revoke exactly in that window, after
 * transport.call() has dialed but before its connect callback can run.
 */
function revokingTransport(socket: string, revoke: (method: string) => void) {
  const transport = new HerdrTransport(socket);
  const call = transport.call.bind(transport);
  transport.call = (...args) => {
    const result = call(...args);
    revoke(args[0]);
    return result;
  };
  return transport;
}

test("revoked task authorization during socket.connect prevents any approval key", async () => {
  const f = await fixture((request) => {
    if (request.method === "agent.read") return { read: { text: menu, truncated: false } };
    return { agent: snapshot("blocked") };
  });
  try {
    let authorized = true;
    const transport = revokingTransport(f.socket, (method) => {
      if (method === "agent.send_keys") authorized = false;
    });
    const control = new AgentControl(new HerdrClient(transport));
    await assert.rejects(
      control.answer(
        ref,
        "enter",
        guard({
          assertCurrent: () => {
            if (!authorized) throw new OperationError("revoked", "task authorization changed");
          },
        }),
      ),
      { code: "revoked", outcome: "not_executed" },
    );
    assert.deepEqual(f.keys, []);
    assert.equal(f.requests.includes("agent.send_keys"), false);
  } finally {
    await f.close();
  }
});

test("cancellation during socket.connect is not executed and sends no approval key", async () => {
  const f = await fixture((request) => {
    if (request.method === "agent.read") return { read: { text: menu, truncated: false } };
    return { agent: snapshot("blocked") };
  });
  try {
    const abort = new AbortController();
    const transport = revokingTransport(f.socket, (method) => {
      if (method === "agent.send_keys") abort.abort("cancelled during connect");
    });
    const control = new AgentControl(new HerdrClient(transport));
    await assert.rejects(control.answer(ref, "enter", guard({ signal: abort.signal })), {
      outcome: "not_executed",
    });
    assert.deepEqual(f.keys, []);
    assert.equal(f.requests.includes("agent.send_keys"), false);
  } finally {
    await f.close();
  }
});

test("a guard that expires while socket.connect is pending is never written", async () => {
  const f = await fixture((request) => {
    if (request.method === "agent.read") return { read: { text: menu, truncated: false } };
    return { agent: snapshot("blocked") };
  });
  const realNow = Date.now;
  try {
    const card = guard();
    let offset = 0;
    Date.now = () => realNow() + offset;
    let liveWhenDialing = false;
    const transport = revokingTransport(f.socket, (method) => {
      if (method !== "agent.send_keys") return;
      // The card is still live while the connection is established...
      liveWhenDialing = Date.parse(card.expiresAt) > realNow();
      // ...and expires before the asynchronous connect callback can write.
      offset = 120_000;
    });
    const control = new AgentControl(new HerdrClient(transport));
    await assert.rejects(control.answer(ref, "enter", card), {
      code: "stale_guard",
      outcome: "not_executed",
    });
    assert.equal(liveWhenDialing, true);
    assert.deepEqual(f.keys, []);
    assert.equal(f.requests.includes("agent.send_keys"), false);
  } finally {
    Date.now = realNow;
    await f.close();
  }
});

test("a key that was really attempted but cannot be read back stays conservatively unknown", async () => {
  const f = await fixture((request) => {
    if (request.method === "agent.read") return { read: { text: menu, truncated: false } };
    // The key is accepted, but the observed menu never changes.
    return { agent: snapshot("blocked") };
  });
  try {
    const control = new AgentControl(new HerdrClient(new HerdrTransport(f.socket)));
    await assert.rejects(control.answer(ref, "enter", guard()), (error: unknown) => {
      assert.equal((error as OperationError).code, "approval_unconfirmed");
      assert.equal((error as OperationError).outcome, "unknown");
      assert.equal(approvalFailureEvidence(error)?.phase, "readback");
      assert.equal(approvalFailureEvidence(error)?.reason, "menu_unchanged");
      return true;
    });
    assert.deepEqual(f.keys, [["enter"]]);
  } finally {
    await f.close();
  }
});

test("a live guard still writes exactly one key and confirms the approval", async () => {
  let status = "blocked";
  let text = menu;
  const f = await fixture((request) => {
    if (request.method === "agent.send_keys") {
      status = "idle";
      text = ready;
      return {};
    }
    if (request.method === "agent.read") return { read: { text, truncated: false } };
    return { agent: snapshot(status) };
  });
  try {
    const control = new AgentControl(new HerdrClient(new HerdrTransport(f.socket)));
    await control.answer(ref, "enter", guard());
    assert.deepEqual(f.keys, [["enter"]]);
    assert.equal(status, "idle");
  } finally {
    await f.close();
  }
});
