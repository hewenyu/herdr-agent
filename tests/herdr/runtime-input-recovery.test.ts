import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { AgentKind, AgentSnapshot, ExecutionRef } from "../../src/core/types.js";
import { HerdrRuntime } from "../../src/herdr/runtime.js";

const receipt = `HERDR_RECEIPT_${"a".repeat(32)}`;
const text = `原始任务正文\n${receipt}`;
const missing = () => new OperationError("not_found", "native agent exited");

async function fixture(kind: AgentKind = "codex", sessionId: string | undefined = "native-id") {
  const home = await mkdtemp(join(tmpdir(), "runtime-input-"));
  const ref: ExecutionRef = {
    kind,
    sessionId,
    paneId: "w:p",
    workspaceId: "w",
    cwd: "/code/project",
  };
  const directory = join(
    home,
    kind === "codex" ? ".codex/sessions" : ".claude/projects/-code-project",
  );
  const path = join(directory, "native-id.jsonl");
  await mkdir(directory, { recursive: true });
  const rows =
    kind === "codex"
      ? [
          { type: "session_meta", payload: { id: "native-id", cwd: ref.cwd } },
          {
            type: "response_item",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
          },
        ]
      : [{ type: "user", sessionId: "native-id", cwd: ref.cwd, message: { content: text } }];
  await writeFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const runtime = new HerdrRuntime({ homeDir: home, socket: join(home, "unused.sock") });
  const shell = { pane_id: ref.paneId, workspace_id: ref.workspaceId, terminal_id: "terminal" };
  const agent: AgentSnapshot = {
    ...ref,
    sessionId: "native-id",
    status: "done",
    terminalId: "terminal",
    stateSeq: "1",
    interactiveReady: true,
    launchPending: false,
  };
  runtime.client.get = async () => {
    throw missing();
  };
  runtime.client.pane = async () => shell;
  const writes: string[] = [];
  runtime.client.transport.call = async (method) => {
    writes.push(method);
    assert.equal(method, "pane.close");
    return {};
  };
  return {
    home,
    path,
    ref,
    rows,
    runtime,
    shell,
    agent,
    writes,
    close: () => rm(home, { recursive: true, force: true }),
  };
}

for (const kind of ["codex", "claude"] as const) {
  test(`exited ${kind} recovers only its exact native user input without mutating execution identity`, async () => {
    const f = await fixture(kind);
    try {
      const original = structuredClone(f.ref);
      assert.equal(await f.runtime.initialInput(f.ref, receipt), text);
      assert.deepEqual(f.ref, original);
      assert.deepEqual(f.writes, []);
      await rm(f.path);
      assert.equal(await f.runtime.initialInput(f.ref, receipt), undefined);
      await f.runtime.close(f.ref);
      assert.deepEqual(
        f.writes,
        ["pane.close"],
        "missing evidence does not block owned shell cleanup",
      );
    } finally {
      await f.close();
    }
  });
}

test("exited Claude can use unique receipt/cwd evidence without native ID; Codex cannot guess one", async () => {
  for (const kind of ["claude", "codex"] as const) {
    const f = await fixture(kind);
    try {
      const target = { ...f.ref, sessionId: undefined };
      assert.equal(
        await f.runtime.initialInput(target, receipt),
        kind === "claude" ? text : undefined,
      );
      assert.equal(target.sessionId, undefined);
      assert.deepEqual(f.writes, []);
    } finally {
      await f.close();
    }
  }
});

test("exited input fallback rejects wrong session, cwd, receipt, assistant echoes and malformed records", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.runtime.initialInput({ ...f.ref, cwd: "/other" }, receipt), undefined);
    assert.equal(
      await f.runtime.initialInput({ ...f.ref, sessionId: "other" }, receipt),
      undefined,
    );
    assert.equal(await f.runtime.initialInput(f.ref, `HERDR_RECEIPT_${"b".repeat(32)}`), undefined);
    for (const content of [
      `${JSON.stringify(f.rows[0])}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } })}\n`,
      `${JSON.stringify({ type: "session_meta", payload: { id: "different", cwd: f.ref.cwd } })}\n${JSON.stringify(f.rows[1])}\n`,
      `${f.rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify(f.rows[1])}\n`,
      "malformed\n",
    ]) {
      await writeFile(f.path, content);
      assert.equal(await f.runtime.initialInput(f.ref, receipt), undefined);
    }
    assert.deepEqual(f.writes, []);
  } finally {
    await f.close();
  }
});

test("input recovery preserves live before/after identity guards and rejects replacement shell ownership", async () => {
  const f = await fixture();
  try {
    for (const changed of [
      { cwd: "/other" },
      { sessionId: "replacement" },
      { terminalId: "new" },
    ]) {
      let reads = 0;
      f.runtime.client.get = async () => (reads++ ? { ...f.agent, ...changed } : f.agent);
      assert.equal(await f.runtime.initialInput(f.ref, receipt), undefined);
    }
    f.runtime.client.get = async () => ({ ...f.agent, workspaceId: "other" });
    await assert.rejects(f.runtime.initialInput(f.ref, receipt), { code: "target_changed" });
    f.runtime.client.get = async () => {
      throw missing();
    };
    for (const changed of [{ workspace_id: "other" }, { pane_id: "other" }, { agent: "codex" }]) {
      f.runtime.client.pane = async () => ({ ...f.shell, ...changed });
      await assert.rejects(f.runtime.initialInput(f.ref, receipt), { code: "target_changed" });
    }
    f.runtime.client.pane = async () => f.shell;
    let reads = 0;
    f.runtime.client.get = async () => {
      if (!reads++) throw missing();
      return f.agent;
    };
    await assert.rejects(f.runtime.initialInput(f.ref, receipt), { code: "target_changed" });
    assert.deepEqual(f.writes, []);
  } finally {
    await f.close();
  }
});

test("native exit during read can preserve exact evidence, but transport failures never become absence", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    f.runtime.client.get = async () => {
      if (reads++) throw missing();
      return f.agent;
    };
    assert.equal(await f.runtime.initialInput(f.ref, receipt), text);
    for (const phase of ["before", "after", "pane"] as const) {
      reads = 0;
      f.runtime.client.get = async () => {
        if (phase === "pane") throw missing();
        if (phase === "before" || reads++) throw new OperationError("transport", "RPC failed");
        return f.agent;
      };
      f.runtime.client.pane = async () => {
        throw new OperationError("transport", "pane RPC failed");
      };
      await assert.rejects(f.runtime.initialInput(f.ref, receipt), { code: "transport" });
    }
  } finally {
    await f.close();
  }
});

test("initial recovery distinguishes missing transcript roots from real filesystem failures", async () => {
  for (const kind of ["codex", "claude"] as const) {
    const f = await fixture(kind);
    try {
      const root = join(f.home, kind === "codex" ? ".codex" : ".claude");
      await rm(root, { recursive: true });
      assert.equal(await f.runtime.initialInput(f.ref, receipt), undefined);
      await writeFile(root, "a file is not a transcript directory");
      const runtime = new HerdrRuntime({ homeDir: f.home, socket: "/unused" });
      runtime.client.get = f.runtime.client.get;
      runtime.client.pane = f.runtime.client.pane;
      await assert.rejects(runtime.initialInput(f.ref, receipt), { code: "ENOTDIR" });
      if (kind === "claude")
        await assert.rejects(runtime.initialInput({ ...f.ref, sessionId: undefined }, receipt), {
          code: "ENOTDIR",
        });
      assert.equal(dirname(f.path).startsWith(root), true);
    } finally {
      await f.close();
    }
  }
});
