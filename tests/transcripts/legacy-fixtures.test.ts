import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseOptions, showsDialog } from "../../src/herdr/screen.js";
import { parseLines } from "../../src/transcripts/parser.js";

async function fixture(path: string): Promise<Buffer> {
  return readFile(new URL(`../fixtures/legacy/${path}`, import.meta.url));
}

test("Go-era native transcript captures preserve final outputs and suppress injected metadata", async () => {
  const commands = parseLines(
    "claude",
    await fixture("transcripts/claude-commands.jsonl"),
    0,
    "commands",
  ).entries;
  assert.deepEqual(
    commands.map(({ role, text }) => ({ role, text })),
    [
      { role: "user", text: "Reply with just: OK" },
      { role: "assistant", text: "OK" },
    ],
  );
  const claude = parseLines(
    "claude",
    await fixture("transcripts/claude-session.jsonl"),
    0,
    "claude",
  ).entries;
  assert.equal(claude.filter((entry) => entry.role === "assistant" && entry.final).length, 3);
  assert.equal(claude.filter((entry) => entry.role === "tool").length, 2);
  assert.ok(
    claude.every(
      (entry) => !/skill_listing|agent_listing|file-history|cache_read/.test(entry.text),
    ),
  );
  const codex = parseLines(
    "codex",
    await fixture("transcripts/codex-rollout.jsonl"),
    0,
    "codex",
  ).entries;
  assert.equal(codex.filter((entry) => entry.role === "user").length, 1);
  assert.deepEqual(
    codex.filter((entry) => entry.final).map((entry) => entry.text),
    ["There are **2 files**: `a.md` and `from-phone.txt`."],
  );
});

test("narrow and wide captured Claude permission screens keep the same guarded choices", async () => {
  for (const name of ["claude-53.txt", "claude-173.txt"]) {
    const screen = (await fixture(`screens/${name}`)).toString("utf8");
    assert.equal(showsDialog(screen), true);
    assert.deepEqual(
      parseOptions(screen).map((option) => option.key),
      ["1", "2", "3"],
    );
  }
  for (const name of ["codex-settled.txt", "codex-queued.txt"]) {
    const screen = (await fixture(`screens/${name}`)).toString("utf8");
    assert.equal(showsDialog(screen), false);
  }
});
