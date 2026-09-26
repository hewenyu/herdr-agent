import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLock, inspectStateLock } from "../../src/storage/lock.js";
import { flockBinding } from "../../src/storage/native.js";

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

test("read-only lock inspection does not create missing state or change a stale PID", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-lock-inspect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = join(directory, "not-created");
  assert.equal(inspectStateLock(missing).state, "unlocked");
  await assert.rejects(stat(missing), { code: "ENOENT" });
  const path = join(directory, "herdr-agent.pid");
  await writeFile(path, "9999999\n", { mode: 0o640 });
  const before = await stat(path);
  const result = inspectStateLock(directory);
  assert.equal(result.state, "unlocked");
  assert.equal(result.pid, undefined, "stale PID data cannot claim a running process");
  assert.equal(await readFile(path, "utf8"), "9999999\n");
  const after = await stat(path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode, before.mode);
});

test("read-only inspection reports the held kernel lock and duplicate startup gives an actionable diagnostic", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-lock-active-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = acquireLock(directory);
  try {
    const before = await stat(lock.path);
    assert.deepEqual(inspectStateLock(directory), {
      state: "locked",
      stateDir: directory,
      path: lock.path,
      pid: process.pid,
    });
    assert.equal((await stat(lock.path)).mtimeMs, before.mtimeMs);
    assert.throws(
      () => acquireLock(directory),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "already_running");
        assert.ok(error.message.includes(String(process.pid)));
        assert.ok(error.message.includes(directory));
        assert.match(error.message, /myrix status --state-dir/);
        return true;
      },
    );
  } finally {
    lock.release();
  }
});

test("lock inspection rejects symlinks and directories without reading their contents", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-lock-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "herdr-agent.pid");
  const target = join(directory, "private-data");
  await writeFile(target, "SECRET-MUST-NOT-APPEAR");
  await symlink(target, path);
  assert.equal(inspectStateLock(directory).state, "unknown");
  assert.doesNotMatch(JSON.stringify(inspectStateLock(directory)), /SECRET/);
  await rm(path);
  await mkdir(path);
  assert.equal(inspectStateLock(directory).state, "unknown");
  assert.equal(await readFile(target, "utf8"), "SECRET-MUST-NOT-APPEAR");
});

test("lock inspection rejects a FIFO without waiting for a writer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-lock-fifo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("mkfifo", [join(directory, "herdr-agent.pid")]);
  assert.equal(inspectStateLock(directory).state, "unknown");
});

test("lock replacement during inspection is unknown, never evidence of an unlocked service", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-lock-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "herdr-agent.pid");
  await writeFile(path, "9999999\n");
  const binding = flockBinding();
  const flock = binding.flock;
  binding.flock = (fd, operation) => {
    flock(fd, operation);
    if (operation === (binding.constants.LOCK_EX | binding.constants.LOCK_NB)) {
      renameSync(path, `${path}.previous`);
      writeFileSync(path, "8888888\n");
    }
  };
  try {
    assert.equal(inspectStateLock(directory).state, "unknown");
    assert.equal(await readFile(path, "utf8"), "8888888\n");
  } finally {
    binding.flock = flock;
  }
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
