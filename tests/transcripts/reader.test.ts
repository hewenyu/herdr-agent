import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionRef } from "../../src/core/types.js";
import { injected, parseLines, parseRecord } from "../../src/transcripts/parser.js";
import { TranscriptReader } from "../../src/transcripts/reader.js";
import { TranscriptResolver } from "../../src/transcripts/resolver.js";

const claude = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const ref: ExecutionRef = {
  workspaceId: "w1",
  paneId: "w1:p1",
  kind: "claude",
  cwd: "/code",
  sessionId: "test-session",
};

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "transcript-test-"));
  const directory = join(home, ".claude/projects/code");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "test-session.jsonl");
  const reader = new TranscriptReader(new TranscriptResolver(home));
  return { home, path, reader, close: () => rm(home, { recursive: true, force: true }) };
}

test("new cursor starts at EOF; partial UTF-8 lines wait for newline", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, `${claude("history")}\n`);
    const first = await f.reader.page(ref);
    assert.deepEqual(first.entries, []);
    const next = Buffer.from(`${claude("新答案")}\n`);
    const cut = next.indexOf(Buffer.from("答")) + 1;
    await appendFile(f.path, next.subarray(0, cut));
    const partial = await f.reader.page(ref, first.cursor);
    assert.deepEqual(partial.entries, []);
    await appendFile(f.path, next.subarray(cut));
    const complete = await f.reader.page(ref, partial.cursor);
    assert.deepEqual(
      complete.entries.map((entry) => entry.text),
      ["新答案"],
    );
    assert.deepEqual((await f.reader.page(ref, complete.cursor)).entries, []);
    assert.equal((await f.reader.sampleLastReply(ref))?.text, "新答案");
  } finally {
    await f.close();
  }
});

test("initial partial record is discarded, replacement skips history, truncation restarts", async () => {
  const f = await fixture();
  try {
    const old = claude("old");
    await writeFile(f.path, old.slice(0, 20));
    const first = await f.reader.page(ref);
    await appendFile(f.path, `${old.slice(20)}\n${claude("new")}\n`);
    const page = await f.reader.page(ref, first.cursor);
    assert.deepEqual(
      page.entries.map((entry) => entry.text),
      ["new"],
    );
    await writeFile(`${f.path}.new`, `${claude("restored history")}\n`);
    await rename(`${f.path}.new`, f.path);
    const replaced = await f.reader.page(ref, page.cursor);
    assert.deepEqual(replaced.entries, []);
    await writeFile(f.path, `${claude("x")}\n`);
    assert.deepEqual(
      (await f.reader.page(ref, replaced.cursor)).entries.map((entry) => entry.text),
      ["x"],
    );
  } finally {
    await f.close();
  }
});

test("Claude skips sidechains, tool outputs, reasoning and machine user context", () => {
  const lines = `${[
    { type: "user", message: { content: [{ type: "tool_result", content: "secret output" }] } },
    { type: "assistant", isSidechain: true, message: { content: "subagent private" } },
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "public" },
          { type: "tool_use", name: "Bash", input: { command: "pwd" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content:
          "<command-name>/clear</command-name><local-command-stdout>cleared</local-command-stdout>",
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`;
  const entries = parseLines("claude", Buffer.from(lines), 0, "test").entries;
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ["public", "Bash(pwd)"],
  );
  assert.equal(entries[0]?.final, false);
});

test("Codex emits response_item once and filters injected context and reasoning", () => {
  const records = [
    { type: "event_msg", payload: { type: "agent_message", message: "duplicate" } },
    { type: "response_item", payload: { type: "reasoning", content: "private" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions\nsecret" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "done" }],
      },
    },
  ];
  const entries = records.flatMap((record, index) =>
    parseRecord("codex", JSON.stringify(record), index, "test"),
  );
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ["done"],
  );
  assert.equal(entries[0]?.final, true);
  assert.equal(injected("fix <div>markup</div>", "codex"), false);
  assert.equal(
    injected("<environment_context>x</environment_context> actual text", "codex"),
    false,
  );
});

test("unknown and malformed records cannot stop later valid output", () => {
  const data = Buffer.from(
    `not json\n{"type":"vendor_new_type"}\n${claude("answer")}\n{"partial":`,
  );
  const result = parseLines("claude", data, 100, "test");
  assert.deepEqual(
    result.entries.map((entry) => entry.text),
    ["answer"],
  );
  assert.equal(data.subarray(result.consumed).toString(), '{"partial":');
});
