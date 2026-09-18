import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionRef } from "../../src/core/types.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { AgentControl } from "../../src/herdr/control.js";
import { HerdrRuntime } from "../../src/herdr/runtime.js";
import { directoryTrustKeys, showsStartupMenu } from "../../src/herdr/screen.js";
import { HerdrTransport } from "../../src/herdr/transport.js";

// Synthetic startup menu: the E21 pre-send screen was not captured.
const menu = [
  "Update available!",
  "› 1. Update now (runs npm install -g @openai/codex)",
  "  2. Skip",
  "  3. Skip until next version",
  "Press enter to continue",
].join("\n");
const ref: ExecutionRef = { paneId: "w1:p1", workspaceId: "w1", kind: "codex", cwd: "/tmp" };
const agent = {
  pane_id: ref.paneId,
  workspace_id: ref.workspaceId,
  agent: ref.kind,
  cwd: ref.cwd,
  terminal_id: "terminal-1",
  agent_status: "idle",
  state_change_seq: 7,
  interactive_ready: true,
  launch_pending: false,
};

class StartupTransport extends HerdrTransport {
  calls: string[] = [];
  text = menu;
  truncated = false;
  constructor() {
    super("/not-used");
  }
  override async call(method: string, params: Record<string, unknown> = {}) {
    this.calls.push(method);
    if (method === "agent.get") return { agent };
    if (method === "agent.read")
      return {
        read: {
          text: params.source === "detection" ? "old detection output" : this.text,
          truncated: this.truncated,
        },
      };
    throw new Error(`Unexpected mutation: ${method}`);
  }
}

test("a numbered startup choice reported idle cannot receive task text or automatic trust", async () => {
  const transport = new StartupTransport();
  const client = new HerdrClient(transport);
  assert.equal((await client.get(ref.paneId)).status, "blocked");
  assert.equal(directoryTrustKeys("codex", menu, ref.cwd), undefined);
  const control = new AgentControl(client);
  await assert.rejects(control.send(ref, "task prompt"), /审批/);
  await assert.rejects(
    control.trustDirectory(ref, ref.cwd, {
      stateSeq: "7",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    /须由用户审批/,
  );
  assert.ok(transport.calls.every((method) => ["agent.get", "agent.read"].includes(method)));
});

test("manual approval receives the visible startup menu instead of stale herdr detection output", async () => {
  const runtime = new HerdrRuntime({ socket: "/not-used" });
  const transport = new StartupTransport();
  runtime.client.transport.call = transport.call.bind(transport);
  const screen = await runtime.screen(ref);
  assert.equal(screen.agent.status, "blocked");
  assert.equal(screen.text, menu);
  assert.deepEqual(
    screen.options.map((option) => option.key),
    ["1", "2", "3"],
  );
  assert.ok(transport.calls.every((method) => ["agent.get", "agent.read"].includes(method)));
});

test("incomplete menus and ordinary numbered output do not establish a startup confirmation", async () => {
  assert.equal(showsStartupMenu("1. First\n2. Second"), false);
  assert.equal(showsStartupMenu(menu.replace("› ", "")), false);
  assert.equal(showsStartupMenu(`${menu}\n› normal composer`), false);
  const transport = new StartupTransport();
  const client = new HerdrClient(transport);
  transport.truncated = true;
  assert.equal((await client.get(ref.paneId)).status, "idle");
  // An established session's past output is not reclassified by startup normalization.
  transport.truncated = false;
  assert.equal(
    (await client.normalize({ ...agent, agent_session: { kind: "id", value: "session-1" } }))
      .status,
    "idle",
  );
});
