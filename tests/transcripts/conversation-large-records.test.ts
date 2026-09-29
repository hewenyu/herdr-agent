import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionRef, TranscriptEntry } from "../../src/core/types.js";
import { TranscriptReader } from "../../src/transcripts/reader.js";
import { TranscriptResolver } from "../../src/transcripts/resolver.js";

const receipt = `HERDR_RECEIPT_${"c".repeat(32)}`;

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "progress-large-record-"));
  const directory = join(home, ".claude/projects/code");
  await mkdir(directory, { recursive: true });
  const ref: ExecutionRef = {
    workspaceId: "w",
    paneId: "p",
    kind: "claude",
    cwd: "/code",
    sessionId: "session",
  };
  const row = (type: string, content: unknown) =>
    JSON.stringify({ type, cwd: ref.cwd, sessionId: ref.sessionId, message: { content } });
  const file = join(directory, "session.jsonl");
  await writeFile(
    file,
    `${row("assistant", "不属于本任务的旧记录")}\n${row("user", `初始要求\n${receipt}`)}\n`,
  );
  const reader = new TranscriptReader(new TranscriptResolver(home));
  const scheduling = await reader.page(ref);
  return {
    ref,
    reader,
    scheduling,
    append: (records: unknown[]) =>
      appendFile(file, `${records.map((content) => row("assistant", content)).join("\n")}\n`),
    close: () => rm(home, { recursive: true, force: true }),
  };
}

function largeRecord(label: string, length = 0) {
  const prose = Array.from(
    { length: 55 },
    (_, index) => `${label} 内容 ${index}${"字".repeat(length)}`,
  );
  const paths = prose.map((_, index) => `docs/${label}-${index}${"a".repeat(length)}.md`);
  return {
    content: prose.flatMap((text, index) => [
      { type: "text", text },
      { type: "tool_use", name: "Read", input: { file_path: paths[index] } },
    ]),
    expected: [prose.join("\n\n"), paths.map((path) => `Read(${path.slice(0, 180)})`).join("\n")],
  };
}

test("a single native record with over 40 alternating prose/tool blocks remains readable", async () => {
  const h = await fixture();
  try {
    const record = largeRecord("唯一记录");
    assert.ok(record.content.length > 40);
    await h.append([record.content]);
    const page = await h.reader.conversation(h.ref, receipt);
    // The real native parser coalesces all prose and all tool blocks into two
    // entries; do not mock a per-block parser that the reader does not use.
    assert.equal(page.entries.length, 2);
    assert.deepEqual(
      page.entries.map((entry) => entry.text),
      record.expected,
    );
    assert.equal(page.entries[1]?.id, `${page.entries[0]?.id}:tools`);
    assert.equal(page.truncated, false);
    assert.equal(page.cursor, undefined);
    const scheduled = await h.reader.page(h.ref, h.scheduling.cursor);
    assert.deepEqual(scheduled.entries, page.entries);
  } finally {
    await h.close();
  }
});

test("large native records keep their before/after neighbours through multiple progress pages", async () => {
  const h = await fixture();
  try {
    const records: unknown[] = [];
    const expected: string[] = [];
    for (let index = 0; index < 115; index++) {
      if ([9, 57, 111].includes(index)) {
        const record = largeRecord(`记录${index}`);
        records.push(record.content);
        expected.push(...record.expected);
      } else {
        records.push(`相邻记录 ${index}`);
        expected.push(`相邻记录 ${index}`);
      }
    }
    await h.append(records);
    const pages: TranscriptEntry[][] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await h.reader.conversation(h.ref, receipt, cursor);
      assert.ok(page.entries.length > 0 && page.entries.length <= 40);
      for (const entry of page.entries.filter((entry) => entry.role === "tool")) {
        assert.ok(page.entries.some((other) => `${other.id}:tools` === entry.id));
      }
      pages.push(page.entries);
      assert.ok(pages.length <= 4, "pagination must advance through all records");
      cursor = page.cursor;
      if (cursor) {
        assert.equal(cursors.has(cursor), false);
        cursors.add(cursor);
      }
    } while (cursor);
    assert.ok(pages.length >= 3);
    const entries = pages.reverse().flat();
    assert.deepEqual(
      entries.map((entry) => entry.text),
      expected,
    );
    assert.equal(new Set(entries.map((entry) => entry.id)).size, expected.length);
    const scheduled = await h.reader.page(h.ref, h.scheduling.cursor);
    assert.deepEqual(scheduled.entries, entries, "progress must not consume the scheduler cursor");
    const cursorFromFirstPage = cursors.values().next().value;
    assert.ok(cursorFromFirstPage);
    await assert.rejects(
      h.reader.conversation(
        { ...h.ref, paneId: "another-participant" },
        receipt,
        cursorFromFirstPage,
      ),
      { code: "invalid_cursor" },
    );
  } finally {
    await h.close();
  }
});

test("a truncated single native record returns its text without an empty continuation page", async () => {
  const h = await fixture();
  try {
    const record = largeRecord("长记录", 200);
    await h.append([record.content]);
    const page = await h.reader.conversation(h.ref, receipt);
    assert.deepEqual(
      page.entries.map((entry) => entry.text),
      record.expected.map((text) => text.slice(0, 4000)),
    );
    assert.equal(page.truncated, true);
    assert.equal(page.cursor, undefined, "clipped text is not an earlier native record");
    const scheduled = await h.reader.page(h.ref, h.scheduling.cursor);
    assert.deepEqual(
      scheduled.entries.map((entry) => entry.text),
      record.expected,
    );
  } finally {
    await h.close();
  }
});

test("the character budget pages around a long native record without losing or repeating entries", async () => {
  const h = await fixture();
  try {
    const before = Array.from({ length: 7 }, (_, index) => `之前 ${index}${"前".repeat(4500)}`);
    const after = Array.from({ length: 8 }, (_, index) => `之后 ${index}${"后".repeat(4500)}`);
    const large = largeRecord("中间长记录", 200);
    await h.append([...before, large.content, ...after]);
    const pages: TranscriptEntry[][] = [];
    let cursor: string | undefined;
    do {
      const page = await h.reader.conversation(h.ref, receipt, cursor);
      assert.ok(page.entries.length > 0);
      assert.ok(page.entries.every((entry) => entry.text.length <= 4000));
      assert.ok(page.entries.reduce((sum, entry) => sum + entry.text.length, 0) <= 24_000);
      assert.equal(page.truncated, true);
      pages.push(page.entries);
      assert.ok(pages.length <= 3, "text clipping must not create an extra empty page");
      cursor = page.cursor;
    } while (cursor);
    assert.equal(pages.length, 3);
    const entries = pages.reverse().flat();
    const expected = [...before, ...large.expected, ...after];
    assert.deepEqual(
      entries.map((entry) => entry.text),
      expected.map((text) => text.slice(0, 4000)),
    );
    assert.equal(new Set(entries.map((entry) => entry.id)).size, expected.length);
    const scheduled = await h.reader.page(h.ref, h.scheduling.cursor);
    assert.deepEqual(
      scheduled.entries.map((entry) => entry.text),
      expected,
    );
  } finally {
    await h.close();
  }
});
