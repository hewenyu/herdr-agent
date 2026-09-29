import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openFileLog } from "../../src/app/file-log.js";
import { createLogger } from "../../src/app/logger.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "myrix-file-log-"));
  const path = join(directory, "log", "myrix.log");
  const output: string[] = [];
  return { directory, path, output, fallback: (line: string) => output.push(line) };
}

test("file logs append across restarts, preserve NDJSON and restrict file permissions", () => {
  const h = fixture();
  try {
    const first = openFileLog(h.directory, h.fallback);
    createLogger(first.write).info("开始", { event: "first" });
    assert.equal(first.path, h.path);
    first.close();
    first.close();
    const second = openFileLog(h.directory, h.fallback);
    createLogger(second.write).info("再次开始", { event: "second" });
    second.close();
    assert.deepEqual(
      readFileSync(h.path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event),
      ["first", "second"],
    );
    assert.equal(statSync(h.path).mode & 0o777, 0o600);
    assert.deepEqual(h.output, []);
  } finally {
    rmSync(h.directory, { recursive: true, force: true });
  }
});

test("rotation uses UTF-8 byte boundaries and retains only the configured recent backups", () => {
  const h = fixture();
  const log = openFileLog(h.directory, h.fallback, { maxBytes: 7, backups: 2 });
  try {
    log.write("你好"); // Seven bytes including newline; no premature rotation.
    assert.equal(existsSync(`${h.path}.1`), false);
    log.write("二");
    assert.equal(readFileSync(`${h.path}.1`, "utf8"), "你好\n");
    log.write("三");
    log.write("四");
    assert.equal(readFileSync(h.path, "utf8"), "四\n");
    assert.equal(readFileSync(`${h.path}.1`, "utf8"), "三\n");
    assert.equal(readFileSync(`${h.path}.2`, "utf8"), "二\n");
    assert.deepEqual(readdirSync(join(h.directory, "log")).sort(), [
      "myrix.log",
      "myrix.log.1",
      "myrix.log.2",
    ]);
    assert.ok(
      [h.path, `${h.path}.1`, `${h.path}.2`].every(
        (path) => (statSync(path).mode & 0o777) === 0o600,
      ),
    );
  } finally {
    log.close();
    rmSync(h.directory, { recursive: true, force: true });
  }
});

test("an existing full log rotates on the first appended record without truncating it", () => {
  const h = fixture();
  mkdirSync(join(h.directory, "log"));
  writeFileSync(h.path, "previous\n", { mode: 0o644 });
  const log = openFileLog(h.directory, h.fallback, { maxBytes: 8, backups: 1 });
  try {
    assert.equal(statSync(h.path).mode & 0o777, 0o600);
    log.write("new");
    assert.equal(readFileSync(`${h.path}.1`, "utf8"), "previous\n");
    assert.equal(readFileSync(h.path, "utf8"), "new\n");
    assert.equal(statSync(`${h.path}.1`).mode & 0o777, 0o600);
  } finally {
    log.close();
    rmSync(h.directory, { recursive: true, force: true });
  }
});

test("rotation failure downgrades once, preserves business logging and closes the descriptor", () => {
  const h = fixture();
  const log = openFileLog(h.directory, h.fallback, { maxBytes: 8, backups: 1 });
  try {
    log.write("before");
    mkdirSync(`${h.path}.1`);
    assert.doesNotThrow(() => log.write("after"));
    assert.equal(log.path, undefined);
    assert.match(h.output[0] ?? "", /日志文件不可用，已切换到控制台/);
    assert.equal(h.output[1], "after");
    log.write("later");
    assert.equal(h.output.length, 3);
    log.close();
    log.write("closed");
    assert.equal(h.output.at(-1), "closed");
    assert.equal(readFileSync(h.path, "utf8"), "before\n");
  } finally {
    log.close();
    rmSync(h.directory, { recursive: true, force: true });
  }
});

test("unavailable log directory falls back without leaking filesystem error details", () => {
  const h = fixture();
  writeFileSync(join(h.directory, "log"), "not a directory");
  const log = openFileLog(h.directory, h.fallback);
  try {
    assert.equal(log.path, undefined);
    assert.doesNotThrow(() => createLogger(log.write).error("诊断失败", { event: "test.failed" }));
    assert.equal(h.output.length, 2);
    assert.doesNotMatch(h.output[0] ?? "", new RegExp(h.directory));
    assert.equal(JSON.parse(h.output[1] ?? "{}").event, "test.failed");
  } finally {
    log.close();
    rmSync(h.directory, { recursive: true, force: true });
  }
});

for (const target of ["directory", "file", "hardlink"] as const) {
  test(`file logging refuses ${target} links without appending to their target`, () => {
    const h = fixture();
    const other = mkdtempSync(join(tmpdir(), "myrix-unrelated-"));
    const original = join(other, "original.log");
    writeFileSync(original, "unrelated\n", { mode: 0o644 });
    if (target === "directory") symlinkSync(other, join(h.directory, "log"));
    else {
      mkdirSync(join(h.directory, "log"));
      if (target === "file") symlinkSync(original, h.path);
      else linkSync(original, h.path);
    }
    const log = openFileLog(h.directory, h.fallback);
    try {
      assert.equal(log.path, undefined);
      log.write("must not append");
      assert.equal(readFileSync(original, "utf8"), "unrelated\n");
      assert.equal(statSync(original).mode & 0o777, 0o644);
      assert.equal(existsSync(join(other, "myrix.log")), false);
    } finally {
      log.close();
      rmSync(h.directory, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
}

test("file and fallback logs use the same primitive-only redaction", () => {
  const h = fixture();
  const log = openFileLog(h.directory, h.fallback);
  const logger = createLogger(log.write);
  const emit = () =>
    logger.error("请求失败 https://api.test/?key=private-key", {
      event: "test.failed",
      error: new Error("private-key private-prompt"),
      prompt: "private-prompt",
      apiKey: "private-key",
      response: "private-prompt",
      detail: "https://api.test/?key=private-key",
      code: "request_failed",
    });
  try {
    emit();
    log.close();
    emit();
    for (const output of [readFileSync(h.path, "utf8"), h.output.join("\n")]) {
      assert.doesNotMatch(output, /private-key|private-prompt|api\.test/);
      assert.equal(JSON.parse(output).code, "request_failed");
    }
    const broken = openFileLog(join(h.directory, "log", "myrix.log"), () => {
      throw new Error("closed console");
    });
    assert.doesNotThrow(() => broken.write("business result already committed"));
    assert.doesNotThrow(() => broken.close());
  } finally {
    log.close();
    rmSync(h.directory, { recursive: true, force: true });
  }
});
