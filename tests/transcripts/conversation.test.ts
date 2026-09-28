import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionRef } from "../../src/core/types.js";
import { TranscriptReader } from "../../src/transcripts/reader.js";
import { TranscriptResolver } from "../../src/transcripts/resolver.js";

const receipt = `HERDR_RECEIPT_${"a".repeat(32)}`;

test("progress reads a verified task conversation, excludes earlier dialogue and paginates independently", async () => {
  const home = await mkdtemp(join(tmpdir(), "progress-session-"));
  try {
    const dir = join(home, ".claude/projects/code");
    await mkdir(dir, { recursive: true });
    const ref: ExecutionRef = {
      workspaceId: "w",
      paneId: "p",
      kind: "claude",
      cwd: "/code",
      sessionId: "session",
    };
    const row = (type: string, content: string) =>
      JSON.stringify({ type, cwd: ref.cwd, sessionId: ref.sessionId, message: { content } });
    const file = join(dir, "session.jsonl");
    await writeFile(
      file,
      `${[
        row("assistant", "旧任务隐私"),
        row("user", `完整初始要求\n${receipt}`),
        ...Array.from({ length: 45 }, (_, index) => row("assistant", `当前进度 ${index}`)),
      ].join("\n")}\n`,
    );
    const reader = new TranscriptReader(new TranscriptResolver(home));
    const scheduling = await reader.page(ref);
    const page = await reader.conversation(ref, receipt);
    assert.equal(page.entries.length, 40);
    assert.equal(page.entries.at(-1)?.text, "当前进度 44");
    assert.ok(page.cursor);
    assert.ok(page.entries.every((entry) => !entry.text.includes("旧任务")));
    const earlier = await reader.conversation(ref, receipt, page.cursor);
    assert.equal(earlier.entries.length, 5);
    assert.equal(earlier.entries[0]?.text, "当前进度 0");
    assert.deepEqual((await reader.page(ref, scheduling.cursor)).entries, []);
    await assert.rejects(reader.conversation({ ...ref, cwd: "/other" }, receipt));
    await assert.rejects(reader.conversation(ref, `HERDR_RECEIPT_${"b".repeat(32)}`));
    await assert.rejects(
      reader.conversation(
        ref,
        receipt,
        Buffer.from(JSON.stringify({ binding: "other", before: 2 })).toString("base64url"),
      ),
    );
    await writeFile(
      file,
      row("user", `foreign\n${receipt}`).replace('"sessionId":"session"', '"sessionId":"foreign"') +
        "\n",
    );
    await assert.rejects(reader.conversation(ref, receipt));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex progress requires matching session metadata and returns prose/tools without reasoning", async () => {
  const home = await mkdtemp(join(tmpdir(), "progress-codex-"));
  try {
    const directory = join(home, ".codex/sessions");
    await mkdir(directory, { recursive: true });
    const ref: ExecutionRef = {
      workspaceId: "w",
      paneId: "p",
      kind: "codex",
      cwd: "/code",
      sessionId: "session",
    };
    const file = join(directory, "rollout-session.jsonl");
    const rows = [
      { type: "session_meta", payload: { id: "session", cwd: "/code" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "earlier task" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `task input\n${receipt}` }],
        },
      },
      { type: "response_item", payload: { type: "reasoning", content: "private reasoning" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "read_file",
          arguments: '{"path":"docs/DESIGN.md"}',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "正在复核设计文档" }],
        },
      },
    ];
    await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const reader = new TranscriptReader(new TranscriptResolver(home));
    const page = await reader.conversation(ref, receipt);
    assert.deepEqual(
      page.entries.map((entry) => entry.text),
      ["read_file(docs/DESIGN.md)", "正在复核设计文档"],
    );
    assert.equal(page.entries[1]?.final, false);
    await assert.rejects(reader.conversation({ ...ref, cwd: "/other" }, receipt));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
