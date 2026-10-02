import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionRef } from "../../src/core/types.js";
import { TranscriptReader } from "../../src/transcripts/reader.js";
import type { TranscriptSource } from "../../src/transcripts/receipt.js";
import { TranscriptResolver } from "../../src/transcripts/resolver.js";

const RECEIPT = `HERDR_RECEIPT_${"ab".repeat(16)}`;
const cwd = "/code";
const sessionId = "offset-session";
const ref: ExecutionRef = {
  workspaceId: "w1",
  paneId: "w1:p1",
  kind: "claude",
  cwd,
  transcriptReceipt: RECEIPT,
};

/** One Claude-native record; the receipt marker must appear as its own trimmed line. */
const record = (type: "user" | "assistant", text: string): string =>
  `${JSON.stringify({ type, cwd, sessionId, message: { content: [{ type: "text", text }] } })}\n`;

/** Stands in for the resolver during the resolve()->stat() window: the receipt boundary
 * comes from a snapshot of the file, while the file on disk may already be shorter. */
class FixedSourceResolver extends TranscriptResolver {
  constructor(private readonly source: TranscriptSource) {
    super();
  }
  override async resolve(): Promise<TranscriptSource | undefined> {
    return this.source;
  }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "transcript-offset-"));
  const directory = join(home, ".claude/projects/-code");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${sessionId}.jsonl`);
  const reader = new TranscriptReader(new TranscriptResolver(home));
  return { home, path, reader, close: () => rm(home, { recursive: true, force: true }) };
}

const texts = (page: { entries: Array<{ text: string }> }) =>
  page.entries.map((entry) => entry.text);

test("a receipt boundary beyond EOF yields a bounded empty page, never a RangeError", async () => {
  const f = await fixture();
  try {
    const head = record("user", RECEIPT);
    await writeFile(f.path, `${head}${record("assistant", "after-receipt")}`);
    const reader = new TranscriptReader(
      new FixedSourceResolver({ path: f.path, afterOffset: Buffer.byteLength(head) }),
    );
    const baseline = await reader.page(ref);
    assert.deepEqual(texts(baseline), []);
    // The writer truncates the same inode after the boundary snapshot was taken,
    // leaving a valid but receipt-forbidden record shorter than afterOffset.
    await writeFile(f.path, record("assistant", "pre-secret"));
    const shrunk = await reader.page(ref, baseline.cursor);
    assert.deepEqual(texts(shrunk), []);
    const again = await reader.page(ref, shrunk.cursor);
    assert.deepEqual(texts(again), []);
    assert.ok(again.entries.every((entry) => entry.text !== RECEIPT));
    // Grow while still below the boundary: nothing before afterOffset becomes visible.
    await writeFile(f.path, record("assistant", "pre-secret"));
    const below = await reader.page(ref, again.cursor);
    assert.deepEqual(texts(below), []);
    // Growth back across the boundary resumes at the receipt boundary: the new
    // post-receipt record is read once, while bytes the boundary forbids stay invisible.
    await writeFile(f.path, `${head}${record("assistant", "regrown")}`);
    const grown = await reader.page(ref, below.cursor);
    assert.deepEqual(texts(grown), ["regrown"]);
    assert.ok(grown.entries.every((entry) => entry.text !== RECEIPT));
    assert.deepEqual(texts(await reader.page(ref, grown.cursor)), []);
  } finally {
    await f.close();
  }
});

test("growth past a receipt boundary clears a partial baseline without losing the first output", async () => {
  const f = await fixture();
  try {
    const head = record("user", RECEIPT);
    const reader = new TranscriptReader(
      new FixedSourceResolver({ path: f.path, afterOffset: Buffer.byteLength(head) }),
    );
    // The verified snapshot ended at a newline, but the writer removed that byte
    // before the reader baselined the file. Its cursor now carries skipPartial.
    await writeFile(f.path, head.slice(0, -1));
    const baseline = await reader.page(ref);
    assert.deepEqual(texts(baseline), []);
    await appendFile(f.path, `\n${record("assistant", "first-after-boundary")}`);
    const grown = await reader.page(ref, baseline.cursor);
    assert.deepEqual(texts(grown), ["first-after-boundary"]);
    assert.deepEqual(texts(await reader.page(ref, grown.cursor)), []);
  } finally {
    await f.close();
  }
});

test("same-inode truncation restarts at the receipt boundary, never at offset 0", async () => {
  const f = await fixture();
  try {
    const head = record("user", RECEIPT);
    await writeFile(f.path, head);
    const baseline = await f.reader.page(ref);
    await appendFile(f.path, record("assistant", "first"));
    const first = await f.reader.page(ref, baseline.cursor);
    assert.deepEqual(texts(first), ["first"]);
    // Truncate to exactly the boundary: only bytes at or after it may ever be read.
    await writeFile(f.path, head);
    const shrunk = await f.reader.page(ref, first.cursor);
    assert.deepEqual(texts(shrunk), []);
    await appendFile(f.path, record("assistant", "recovered"));
    const grown = await f.reader.page(ref, shrunk.cursor);
    assert.deepEqual(texts(grown), ["recovered"]);
  } finally {
    await f.close();
  }
});

test("receipt-scanned incremental pages surface only post-receipt output", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, record("user", RECEIPT));
    const baseline = await f.reader.page(ref);
    assert.deepEqual(texts(baseline), []);
    await appendFile(f.path, record("assistant", "first"));
    const first = await f.reader.page(ref, baseline.cursor);
    assert.deepEqual(texts(first), ["first"]);
    await appendFile(f.path, record("assistant", "second"));
    const second = await f.reader.page(ref, first.cursor);
    assert.deepEqual(texts(second), ["second"]);
    assert.ok(second.entries.every((entry) => entry.text !== RECEIPT));
  } finally {
    await f.close();
  }
});

test("a partial trailing record is withheld until its newline arrives", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, record("user", RECEIPT));
    const baseline = await f.reader.page(ref);
    const line = record("assistant", "complete-me");
    await appendFile(f.path, line.slice(0, -1));
    const partial = await f.reader.page(ref, baseline.cursor);
    assert.deepEqual(texts(partial), []);
    await appendFile(f.path, line.slice(-1));
    const complete = await f.reader.page(ref, partial.cursor);
    assert.deepEqual(texts(complete), ["complete-me"]);
  } finally {
    await f.close();
  }
});

test("a replaced inode is baselined, not crossed, even at the receipt boundary", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, record("user", RECEIPT));
    const baseline = await f.reader.page(ref);
    await appendFile(f.path, record("assistant", "old"));
    const old = await f.reader.page(ref, baseline.cursor);
    assert.deepEqual(texts(old), ["old"]);
    await writeFile(`${f.path}.new`, `${record("user", RECEIPT)}${record("assistant", "new")}`);
    await rename(`${f.path}.new`, f.path);
    const replaced = await f.reader.page(ref, old.cursor);
    assert.deepEqual(texts(replaced), []);
    await appendFile(f.path, record("assistant", "after-new"));
    const after = await f.reader.page(ref, replaced.cursor);
    assert.deepEqual(texts(after), ["after-new"]);
  } finally {
    await f.close();
  }
});
