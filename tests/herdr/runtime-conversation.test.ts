import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { canonical, stableId } from "../../src/core/ids.js";
import type { AgentKind, AgentSnapshot, ExecutionRef } from "../../src/core/types.js";
import { HerdrRuntime } from "../../src/herdr/runtime.js";

const receipt = `HERDR_RECEIPT_${"a".repeat(32)}`;
const otherReceipt = `HERDR_RECEIPT_${"b".repeat(32)}`;
const liveSession = "11111111-1111-1111-1111-111111111111";
const otherSession = "22222222-2222-2222-2222-222222222222";

async function fixture(kind: AgentKind) {
  const home = await mkdtemp(join(tmpdir(), "runtime-conversation-"));
  const ref: ExecutionRef = { kind, paneId: "w:p", workspaceId: "w", cwd: "/code/project" };
  const directory = join(
    home,
    kind === "claude" ? ".claude/projects/-code-project" : ".codex/sessions",
  );
  await mkdir(directory, { recursive: true });
  const path = (sessionId: string) =>
    join(
      directory,
      kind === "claude" ? `${sessionId}.jsonl` : `rollout-2026-09-28T00-00-00-${sessionId}.jsonl`,
    );
  const record = (sessionId: string, cwd: string, role: "user" | "assistant", text: string) =>
    kind === "claude"
      ? { type: role, sessionId, cwd, message: { content: text } }
      : {
          type: "response_item",
          payload: {
            type: "message",
            role,
            content: [{ type: role === "user" ? "input_text" : "output_text", text }],
          },
        };
  const rows = (sessionId: string, marker: string, cwd = ref.cwd, count = 45) => [
    ...(kind === "codex" ? [{ type: "session_meta", payload: { id: sessionId, cwd } }] : []),
    record(sessionId, cwd, "assistant", "其他任务的历史记录"),
    record(sessionId, cwd, "user", `本任务初始要求\n${marker}`),
    ...Array.from({ length: count }, (_, index) =>
      record(sessionId, cwd, "assistant", `当前进度 ${index}`),
    ),
  ];
  const write = (sessionId: string, values: unknown[]) =>
    writeFile(path(sessionId), `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
  await write(liveSession, rows(liveSession, receipt));
  const runtime = new HerdrRuntime({ homeDir: home, socket: join(home, "unused.sock") });
  const agent: AgentSnapshot = {
    ...ref,
    sessionId: liveSession,
    terminalId: "terminal",
    status: "done",
    stateSeq: "1",
    interactiveReady: true,
    launchPending: false,
  };
  runtime.client.get = async () => ({ ...agent });
  runtime.client.pane = async () => ({
    pane_id: ref.paneId,
    workspace_id: ref.workspaceId,
    terminal_id: "terminal",
  });
  runtime.client.transport.call = async () =>
    assert.fail("progress must not write to native agents");
  return {
    home,
    ref,
    runtime,
    agent,
    rows,
    write,
    path,
    close: () => rm(home, { recursive: true, force: true }),
  };
}

for (const kind of ["claude", "codex"] as const) {
  test(`live ${kind} progress discovers the missing stored session only from its observed identity and verified receipt`, async () => {
    const h = await fixture(kind);
    try {
      const original = structuredClone(h.ref);
      const scheduling = await h.runtime.transcript(h.ref);
      const latest = await h.runtime.conversation(h.ref, receipt);
      assert.equal(latest.entries.length, 40);
      assert.equal(latest.entries[0]?.text, "当前进度 5");
      assert.equal(latest.entries.at(-1)?.text, "当前进度 44");
      assert.ok(latest.cursor);
      const earlier = await h.runtime.conversation(h.ref, receipt, latest.cursor);
      assert.deepEqual(
        earlier.entries.map((entry) => entry.text),
        Array.from({ length: 5 }, (_, index) => `当前进度 ${index}`),
      );
      assert.equal(earlier.cursor, undefined);
      assert.deepEqual(h.ref, original, "a read must not mutate the participant's stored binding");
      assert.deepEqual((await h.runtime.transcript(h.ref, scheduling.cursor)).entries, []);
      assert.deepEqual(
        (await h.runtime.conversation({ ...h.ref, sessionId: liveSession }, receipt)).entries,
        latest.entries,
      );
    } finally {
      await h.close();
    }
  });

  test(`${kind} progress still rejects a known session mismatch, wrong cwd and wrong initial receipt`, async () => {
    const h = await fixture(kind);
    try {
      await assert.rejects(h.runtime.conversation({ ...h.ref, sessionId: otherSession }, receipt), {
        code: "target_changed",
      });
      await assert.rejects(h.runtime.conversation({ ...h.ref, cwd: "/other-project" }, receipt), {
        code: "target_changed",
      });
      await assert.rejects(h.runtime.conversation(h.ref, otherReceipt), {
        code: "transcript_unverified",
      });
      await h.write(liveSession, h.rows(liveSession, receipt, "/other-project"));
      await assert.rejects(h.runtime.conversation(h.ref, receipt), {
        code: "transcript_unverified",
      });
      await h.write(liveSession, h.rows(otherSession, receipt));
      await assert.rejects(h.runtime.conversation(h.ref, receipt), {
        code: "transcript_unverified",
      });
    } finally {
      await h.close();
    }
  });

  test(`${kind} progress cannot fall back to another historical session when the live session lacks this task receipt`, async () => {
    const h = await fixture(kind);
    try {
      await h.write(liveSession, h.rows(liveSession, otherReceipt));
      await h.write(otherSession, h.rows(otherSession, receipt));
      await assert.rejects(h.runtime.conversation(h.ref, receipt), {
        code: "transcript_unverified",
      });
      assert.equal(h.ref.sessionId, undefined);
    } finally {
      await h.close();
    }
  });

  test(`${kind} missing-session progress rejects live identity changes during the transcript read`, async () => {
    const h = await fixture(kind);
    try {
      for (const change of [
        { sessionId: otherSession },
        { cwd: "/other-project" },
        { terminalId: "replacement-terminal" },
        { paneId: "replacement-pane" },
        { workspaceId: "replacement-workspace" },
        { kind: kind === "claude" ? ("codex" as const) : ("claude" as const) },
      ]) {
        let reads = 0;
        h.runtime.client.get = async () => (reads++ ? { ...h.agent, ...change } : { ...h.agent });
        await assert.rejects(h.runtime.conversation(h.ref, receipt), { code: "target_changed" });
      }
    } finally {
      await h.close();
    }
  });

  test(`${kind} progress cannot reuse a missing-session cursor after the live native session changes`, async () => {
    const h = await fixture(kind);
    try {
      const page = await h.runtime.conversation(h.ref, receipt);
      assert.ok(page.cursor);
      await h.write(otherSession, h.rows(otherSession, receipt));
      h.runtime.client.get = async () => ({ ...h.agent, sessionId: otherSession });
      await assert.rejects(h.runtime.conversation(h.ref, receipt, page.cursor), {
        code: "invalid_cursor",
      });
    } finally {
      await h.close();
    }
  });

  test(`${kind} progress keeps paginating the same verified session after its native agent exits`, async () => {
    const h = await fixture(kind);
    try {
      const original = structuredClone(h.ref);
      const latest = await h.runtime.conversation(h.ref, receipt);
      assert.ok(latest.cursor);
      assert.equal(
        JSON.parse(Buffer.from(latest.cursor, "base64url").toString("utf8")).binding,
        stableId(canonical({ ...h.ref, sessionId: liveSession }), receipt),
        "the cursor retains the existing live-session binding format",
      );
      h.runtime.client.get = async () => {
        throw new OperationError("agent_not_found", "native agent exited");
      };
      const restarted = new HerdrRuntime({ homeDir: h.home, socket: join(h.home, "unused.sock") });
      restarted.client.get = h.runtime.client.get;
      restarted.client.pane = h.runtime.client.pane;
      restarted.client.transport.call = h.runtime.client.transport.call;
      const earlier = await restarted.conversation(h.ref, receipt, latest.cursor);
      assert.deepEqual(
        earlier.entries.map((entry) => entry.text),
        Array.from({ length: 5 }, (_, index) => `当前进度 ${index}`),
      );
      assert.equal(earlier.cursor, undefined);
      assert.deepEqual(h.ref, original);
    } finally {
      await h.close();
    }
  });

  test(`exited ${kind} progress accepts only its exact legacy sessionless cursor and upgrades subsequent pages`, async () => {
    const h = await fixture(kind);
    try {
      await h.write(liveSession, h.rows(liveSession, receipt, h.ref.cwd, 85));
      h.runtime.client.get = async () => {
        throw new OperationError("agent_not_found", "native agent exited");
      };
      const latest = await h.runtime.conversation(h.ref, receipt);
      assert.ok(latest.cursor);
      const legacy = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(latest.cursor, "base64url").toString("utf8")),
          // Legacy runtime cursors bind the sessionless ref and verified file/receipt only.
          binding: stableId(canonical({ ...h.ref, sessionId: undefined }), receipt),
        }),
      ).toString("base64url");
      for (const change of [
        { inode: "different-file" },
        { device: "different-device" },
        { before: Number.MAX_SAFE_INTEGER },
        { binding: stableId(canonical({ ...h.ref, sessionId: undefined }), otherReceipt) },
      ]) {
        const invalid = Buffer.from(
          JSON.stringify({
            ...JSON.parse(Buffer.from(legacy, "base64url").toString("utf8")),
            ...change,
          }),
        ).toString("base64url");
        await assert.rejects(h.runtime.conversation(h.ref, receipt, invalid), {
          code: "invalid_cursor",
        });
      }
      const middle = await h.runtime.conversation(h.ref, receipt, legacy);
      assert.deepEqual(
        middle.entries.map((entry) => entry.text),
        Array.from({ length: 40 }, (_, index) => `当前进度 ${index + 5}`),
      );
      assert.ok(middle.cursor);
      assert.equal(
        JSON.parse(Buffer.from(middle.cursor, "base64url").toString("utf8")).binding,
        stableId(canonical({ ...h.ref, sessionId: liveSession }), receipt),
      );
      await assert.rejects(
        h.runtime.conversation({ ...h.ref, sessionId: liveSession }, receipt, legacy),
        { code: "invalid_cursor" },
      );
      h.runtime.client.get = async () => ({ ...h.agent });
      await assert.rejects(h.runtime.conversation(h.ref, receipt, legacy), {
        code: "invalid_cursor",
      });
      const earlier = await h.runtime.conversation(h.ref, receipt, middle.cursor);
      assert.equal(earlier.entries[0]?.text, "当前进度 0");
      assert.equal(earlier.entries.length, 5);
      assert.equal(earlier.cursor, undefined);
      assert.equal(h.ref.sessionId, undefined);
    } finally {
      await h.close();
    }
  });

  for (const change of ["receipt", "session", "cwd", "inode"] as const)
    test(`${kind} progress cursor rejects a changed ${change} after its native agent exits`, async () => {
      const h = await fixture(kind);
      try {
        const latest = await h.runtime.conversation(h.ref, receipt);
        assert.ok(latest.cursor);
        h.runtime.client.get = async () => {
          throw new OperationError("agent_not_found", "native agent exited");
        };
        let target = h.ref;
        let requestedReceipt = receipt;
        if (change === "receipt") {
          await h.write(liveSession, h.rows(liveSession, otherReceipt));
          requestedReceipt = otherReceipt;
        } else if (change === "session") {
          // Keep the inode and receipt while replacing the native session itself.
          await rename(h.path(liveSession), h.path(otherSession));
          await h.write(otherSession, h.rows(otherSession, receipt));
        } else if (change === "cwd") {
          await h.write(liveSession, h.rows(liveSession, receipt, "/other-project"));
          target = { ...h.ref, sessionId: liveSession, cwd: "/other-project" };
        } else {
          await rename(h.path(liveSession), `${h.path(liveSession)}.retired`);
          await h.write(liveSession, h.rows(liveSession, receipt));
        }
        await assert.rejects(h.runtime.conversation(target, requestedReceipt, latest.cursor), {
          code: "invalid_cursor",
        });
        assert.equal(h.ref.sessionId, undefined);
      } finally {
        await h.close();
      }
    });

  test(`exited ${kind} progress keeps the existing unique-receipt recovery without inventing a live session`, async () => {
    const h = await fixture(kind);
    try {
      h.runtime.client.get = async () => {
        throw new OperationError("agent_not_found", "native agent exited");
      };
      const page = await h.runtime.conversation(h.ref, receipt);
      assert.equal(page.entries.length, 40);
      assert.equal(h.ref.sessionId, undefined);
      await h.write(otherSession, h.rows(otherSession, receipt));
      await assert.rejects(h.runtime.conversation(h.ref, receipt), {
        code: "transcript_unverified",
      });
    } finally {
      await h.close();
    }
  });
}
