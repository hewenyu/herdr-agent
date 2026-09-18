import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { AgentSnapshot, ExecutionRef } from "../../src/core/types.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { AgentControl } from "../../src/herdr/control.js";
import { verifyEcho, verifyReceipt } from "../../src/herdr/echo.js";
import { showsDialog, trustKeys } from "../../src/herdr/screen.js";
import { HerdrTransport } from "../../src/herdr/transport.js";

const ref: ExecutionRef = { paneId: "w1:p1", workspaceId: "w1", kind: "claude", cwd: "/tmp" };
const base: AgentSnapshot = {
  ...ref,
  status: "idle",
  stateSeq: "3",
  interactiveReady: true,
  launchPending: false,
};
const screen = (body: string, composer = "") =>
  `${body}\n${"─".repeat(20)}\n> ${composer}\n${"─".repeat(20)}\nfooter`;

class FakeClient extends HerdrClient {
  agent = { ...base };
  reads = 0;
  prompts: string[] = [];
  strokes: string[][] = [];
  before = screen("old output");
  after = screen("hello world");
  failPrompt = false;
  constructor() {
    super(new HerdrTransport("/not-used"));
  }
  override async get() {
    return { ...this.agent };
  }
  override async read() {
    return { text: this.reads++ === 0 ? this.before : this.after, truncated: false };
  }
  override async prompt(_pane: string, text: string) {
    this.prompts.push(text);
    if (this.failPrompt) throw new OperationError("agent_prompt_stalled", "stalled", "unknown");
    return this.agent;
  }
  override async keys(_pane: string, input: string[]) {
    this.strokes.push(input);
  }
}

test("blocked pi send refuses without cancelling a dialog", async () => {
  const client = new FakeClient();
  client.agent.status = "blocked";
  await assert.rejects(new AgentControl(client).send(ref, "hello world"), /审批/);
  assert.deepEqual(client.prompts, []);
  assert.deepEqual(client.strokes, []);
});

test("pane/name fallback cannot silently retarget delivery", async () => {
  const client = new FakeClient();
  client.agent.paneId = "w2:p1";
  await assert.rejects(new AgentControl(client).send(ref, "hello world"), /位置已变化/);
  assert.deepEqual(client.prompts, []);
});

test("stale approval rejected before any keystroke", async () => {
  const client = new FakeClient();
  client.agent.status = "blocked";
  await assert.rejects(
    new AgentControl(client).answer(ref, "1", {
      stateSeq: "2",
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    }),
    /已变化/,
  );
  assert.deepEqual(client.strokes, []);
});

test("settled delivery verifies outside composer; stalled prompt is never replayed", async () => {
  const client = new FakeClient();
  const result = await new AgentControl(client).send(ref, "hello world");
  assert.equal(result.status, "delivered");
  assert.equal(result.verified, true);
  const stalled = new FakeClient();
  stalled.failPrompt = true;
  assert.equal((await new AgentControl(stalled).send(ref, "hello world")).status, "unconfirmed");
  assert.equal(stalled.prompts.length, 1);
});

test("screen false-negative blocked status is caught before paste", async () => {
  const client = new FakeClient();
  client.before = "Do you want to\nproceed?\n1. Yes\n2. No";
  await assert.rejects(new AgentControl(client).send(ref, "hello world"), /审批/);
  assert.equal(client.prompts.length, 0);
});

test("ghost suggestions and repeated queued text do not prove delivery", () => {
  assert.equal(
    verifyEcho(screen("old"), screen("old", "hello world"), "hello world", false),
    false,
  );
  assert.equal(verifyEcho(screen("old", "ok"), screen("old", "ok"), "ok", true), false);
  assert.equal(verifyEcho(screen("old", "ok"), screen("old", "ok\nok"), "ok", true), true);
  assert.equal(verifyEcho(screen("old"), screen("nothing here"), "no", false), false);
});

test("unique initial receipt proves long prompt only when absent before", () => {
  const receipt = `HERDR_RECEIPT_${"a".repeat(32)}`;
  assert.equal(
    verifyReceipt(screen("old"), screen(receipt), `long prompt\n${receipt}`, receipt, false),
    true,
  );
  assert.equal(
    verifyReceipt(screen(receipt), screen(receipt), `long prompt\n${receipt}`, receipt, false),
    false,
  );
});

test("Codex trust recognizes selected choice, never arbitrary examples", () => {
  const native =
    "> You are in /tmp\nDo you trust the contents of this directory?\n› 1. Yes, continue\n2. No, quit\nPress enter to continue";
  assert.deepEqual(trustKeys(native), ["enter"]);
  assert.deepEqual(trustKeys(native.replace("› 1.", "1.").replace("2. No", "› 2. No")), [
    "up",
    "enter",
  ]);
  assert.equal(trustKeys(`Example:\n${native}`), undefined);
  assert.equal(showsDialog(native), true);
});
