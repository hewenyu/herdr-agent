import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSnapshot, ExecutionRef } from "../../src/core/types.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { AgentControl } from "../../src/herdr/control.js";
import { screenFingerprint } from "../../src/herdr/screen.js";
import { HerdrTransport } from "../../src/herdr/transport.js";

const ref: ExecutionRef = { paneId: "w1:p1", workspaceId: "w1", kind: "codex", cwd: "/tmp" };
const initial = "New permission page\n❯ Allow once\n  Cancel\nEnter confirms";
class Client extends HerdrClient {
  agent: AgentSnapshot = {
    ...ref,
    terminalId: "term-1",
    sessionId: "s1",
    status: "blocked",
    stateSeq: "3",
    interactiveReady: true,
    launchPending: false,
  };
  text = initial;
  truncated = false;
  strokes: string[][] = [];
  reads = 0;
  onRead?: () => void;
  onKeys = () => {
    this.text = "Ready for the next step";
    this.agent.status = "idle";
  };
  constructor() {
    super(new HerdrTransport("/not-used"));
  }
  override async get() {
    return { ...this.agent };
  }
  override async read() {
    this.reads++;
    this.onRead?.();
    return { text: this.text, truncated: this.truncated };
  }
  override async keys(_pane: string, keys: string[]) {
    this.strokes.push(keys);
    this.onKeys();
  }
}
const guard = () => ({
  stateSeq: "3",
  sessionId: "s1",
  terminalId: "term-1",
  cwd: "/tmp",
  screenFingerprint: screenFingerprint(initial),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  literalKey: true,
});

for (const change of [
  "screen",
  "late-screen",
  "terminal",
  "cwd",
  "session",
  "state",
  "truncated",
  "cancel",
  "context",
] as const) {
  test(`complete native observation refuses ${change} changes before any key`, async () => {
    const client = new Client();
    const signal = new AbortController();
    if (change === "screen") client.text = initial.replace("Allow once", "Delete everything");
    if (change === "late-screen")
      client.onRead = () => {
        if (client.reads === 2) client.text = "A new menu";
      };
    if (change === "terminal") client.agent.terminalId = "replacement";
    if (change === "cwd") client.agent.cwd = "/another";
    if (change === "session") client.agent.sessionId = "replacement";
    if (change === "state") client.agent.stateSeq = "4";
    if (change === "truncated") client.truncated = true;
    if (change === "cancel") signal.abort();
    await assert.rejects(
      new AgentControl(client).answer(ref, "enter", {
        ...guard(),
        signal: signal.signal,
        beforeWrite: async () => {
          if (change === "context") throw new Error("task paused before write");
        },
      }),
    );
    assert.deepEqual(client.strokes, []);
  });
}

test("newly assigned session before a startup choice invalidates an absent-session guard", async () => {
  const client = new Client();
  await assert.rejects(
    new AgentControl(client).answer(ref, "enter", { ...guard(), sessionId: undefined }),
    { code: "stale_guard" },
  );
  assert.deepEqual(client.strokes, []);
});

for (const result of [
  "same-screen",
  "unrelated-output",
  "truncated",
  "terminal",
  "gone",
] as const) {
  test(`ACK with ${result} readback is unknown, never a successful approval`, async () => {
    const client = new Client();
    client.onKeys = () => {
      if (result === "unrelated-output")
        client.text = `Updated log at 10:23:45\n${initial}\nSpinner: running`;
      if (result === "truncated") client.truncated = true;
      if (result === "terminal") client.agent.terminalId = "replacement";
      if (result === "gone") client.agent.status = "gone";
    };
    await assert.rejects(new AgentControl(client).answer(ref, "enter", guard()), {
      code: "approval_unconfirmed",
      outcome: "unknown",
    });
    assert.deepEqual(client.strokes, [["enter"]]);
  });
}

test("navigation can succeed with unchanged stateSeq only after visible selection changes", async () => {
  const client = new Client();
  client.onKeys = () => {
    client.text = initial.replace("❯ Allow once\n  Cancel", "  Allow once\n❯ Cancel");
  };
  await new AgentControl(client).answer(ref, "down", guard());
  assert.deepEqual(client.strokes, [["down"]]);
  assert.equal(client.agent.stateSeq, "3");
});

test("automatic numeric choice remains exactly one key even on a legacy Codex trust screen", async () => {
  const client = new Client();
  client.text =
    "> You are in /tmp\nDo you trust the contents of this directory?\n1. Yes, continue\n› 2. No, quit\nPress enter to continue";
  await new AgentControl(client).answer(ref, "1", {
    ...guard(),
    screenFingerprint: screenFingerprint(client.text),
  });
  assert.deepEqual(client.strokes, [["1"]]);
});

for (const change of ["screen", "terminal", "session"] as const) {
  test(`native ${change} change during async scope checking is rejected before keys`, async () => {
    const client = new Client();
    await assert.rejects(
      new AgentControl(client).answer(ref, "enter", {
        ...guard(),
        beforeWrite: async () => {
          if (change === "screen") client.text = "A replacement menu";
          if (change === "terminal") client.agent.terminalId = "replacement";
          if (change === "session") client.agent.sessionId = "replacement";
        },
      }),
      { code: "stale_guard" },
    );
    assert.deepEqual(client.strokes, []);
  });
}

test("synchronous task veto after the final native read prevents any key", async () => {
  const client = new Client();
  let veto = false;
  client.onRead = () => {
    if (client.reads === 3) veto = true;
  };
  await assert.rejects(
    new AgentControl(client).answer(ref, "enter", {
      ...guard(),
      assertCurrent: () => {
        if (veto) throw new Error("task stop requested during last read");
      },
    }),
  );
  assert.deepEqual(client.strokes, []);
});
