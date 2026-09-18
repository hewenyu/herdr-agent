import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLock } from "../../src/storage/lock.js";

test("POSIX flock excludes a second instance, recovers stale PID and releases once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "herdr-agent.pid");
  await writeFile(path, "9999999\n", { mode: 0o644 });
  const first = acquireLock(dir);
  try {
    assert.equal(await readFile(path, "utf8"), `${process.pid}\n`);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.throws(() => acquireLock(dir), { code: "already_running" });
  } finally {
    first.release();
  }
  first.release();
  await assert.rejects(stat(path), { code: "ENOENT" });
  acquireLock(dir).release();
});

test("release cannot unlink a replacement lock inode and symlinks are refused", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-lock-inode-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = acquireLock(dir);
  await rename(first.path, join(dir, "old-inode"));
  const next = acquireLock(dir);
  first.release();
  assert.equal(await readFile(next.path, "utf8"), `${process.pid}\n`);
  next.release();
  const target = join(dir, "unrelated");
  await writeFile(target, "do not truncate");
  await symlink(target, first.path);
  assert.throws(() => acquireLock(dir), { code: "state_lock" });
  assert.equal(await readFile(target, "utf8"), "do not truncate");
});
