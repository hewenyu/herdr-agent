import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { createWorkspace, startAgent, startupArgs } from "../../src/herdr/lifecycle.js";
import { HerdrTransport } from "../../src/herdr/transport.js";

const agent = {
  pane_id: "w1:p1",
  workspace_id: "w1",
  terminal_id: "t1",
  agent: "claude",
  agent_status: "idle",
  name: "participant-1",
  interactive_ready: true,
  launch_pending: false,
  state_change_seq: 1,
};

class FakeTransport extends HerdrTransport {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  response: unknown = { agent };
  failures: OperationError[] = [];
  constructor() {
    super("/not-used");
  }
  override async call(method: string, params: Record<string, unknown> = {}) {
    this.calls.push({ method, params });
    if (method === "pane.get")
      return { pane: { pane_id: "w1:p1", workspace_id: "w1", terminal_id: "t1" } };
    const error = this.failures.shift();
    if (error) throw error;
    return this.response;
  }
}

test("workspace is created unfocused and preserves root pane identity", async () => {
  const transport = new FakeTransport();
  transport.response = {
    workspace: { workspace_id: "w1" },
    root_pane: { pane_id: "w1:p1", cwd: "/code" },
  };
  assert.deepEqual(await createWorkspace(new HerdrClient(transport), "/code", "task"), {
    workspaceId: "w1",
    paneId: "w1:p1",
    cwd: "/code",
  });
  assert.deepEqual(transport.calls[0]?.params, { cwd: "/code", label: "task", focus: false });
});

test("native directory argv remain separate values; unsupported paths fail before RPC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "directory ' quoted-"));
  try {
    assert.deepEqual(await startupArgs("codex", [dir], true), [
      "--dangerously-bypass-approvals-and-sandbox",
      "--add-dir",
      dir,
    ]);
    const transport = new FakeTransport();
    await assert.rejects(
      startAgent(new HerdrClient(transport), "w1:p1", "claude", "participant-1", {
        directories: ["relative"],
        bypass: false,
      }),
      /绝对路径/,
    );
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("blocked startup succeeds without approval or prompt", async () => {
  const transport = new FakeTransport();
  transport.response = {
    agent: { ...agent, agent_status: "blocked", interactive_ready: false, launch_pending: true },
  };
  const result = await startAgent(new HerdrClient(transport), "w1:p1", "claude", "participant-1", {
    directories: [],
    bypass: false,
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(
    transport.calls.map((call) => call.method),
    ["agent.start"],
  );
});

test("only definitive busy refusal is retried; unknown start is not replayed", async () => {
  const busy = new FakeTransport();
  busy.failures = [new OperationError("agent_pane_busy", "busy")];
  await startAgent(new HerdrClient(busy), "w1:p1", "claude", "participant-1", {
    directories: [],
    bypass: false,
  });
  assert.equal(busy.calls.filter((call) => call.method === "agent.start").length, 2);
  const unknown = new FakeTransport();
  unknown.failures = [new OperationError("timeout", "timeout", "unknown")];
  await assert.rejects(
    startAgent(new HerdrClient(unknown), "w1:p1", "claude", "participant-1", {
      directories: [],
      bypass: false,
    }),
    /timeout/,
  );
  assert.equal(unknown.calls.length, 1);
  for (const code of ["agent_pane_busy", "agent_name_taken"]) {
    const unconfirmed = new FakeTransport();
    unconfirmed.failures = [new OperationError(code, "unconfirmed refusal", "unknown")];
    await assert.rejects(
      startAgent(new HerdrClient(unconfirmed), "w1:p1", "claude", "participant-1", {
        directories: [],
        bypass: false,
      }),
      { code, outcome: "unknown" },
    );
    assert.equal(unconfirmed.calls.length, 1, "unknown results cannot authorize another start");
  }
});

test("unconfirmed startup argv and changed owner cannot receive a task", async () => {
  const transport = new FakeTransport();
  await assert.rejects(
    startAgent(new HerdrClient(transport), "w1:p1", "claude", "participant-1", {
      directories: [],
      bypass: true,
    }),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === "agent_options_unconfirmed" &&
      error.outcome === "unknown",
  );
  transport.response = { agent: { ...agent, name: "someone-else" } };
  await assert.rejects(
    startAgent(new HerdrClient(transport), "w1:p1", "claude", "participant-1", {
      directories: [],
      bypass: false,
    }),
    /原执行位置/,
  );
});
