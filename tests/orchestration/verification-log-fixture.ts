import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { defaultLogTailIo, verificationLogTails } from "./verification-log-tail.js";

/** Owned filesystem fixture, separate from the strictly read-only diagnostic. */
export async function logTailFixture() {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "herdr-log-tail-"));
  const identity = await lstat(root);
  const stateDir = join(root, "state"),
    taskId = "task-log",
    id = "a".repeat(64);
  const directory = join(stateDir, "tasks", taskId, "verification", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stdoutPath = join(directory, "stdout.log"),
    stderrPath = join(directory, "stderr.log");
  writeFileSync(stdoutPath, "log-head\nTAIL-MARKER\n");
  writeFileSync(stderrPath, "");
  const row = { id, taskId, status: "failed", exitConfirmed: true, stdoutPath, stderrPath };
  return {
    root,
    stateDir,
    taskId,
    row,
    directory,
    stdoutPath,
    stderrPath,
    read: (io = defaultLogTailIo) => verificationLogTails(stateDir, taskId, row, io),
    async remove(path: string) {
      assert.ok(path.startsWith(`${root}${sep}`));
      const parentPath = await realpath(dirname(path));
      assert.ok(parentPath === root || parentPath.startsWith(`${root}${sep}`));
      await rm(path, { recursive: true });
    },
    async close() {
      assert.equal(await realpath(root), root);
      assert.equal(dirname(root), parent);
      assert.match(basename(root), /^herdr-log-tail-[A-Za-z0-9]+$/);
      const current = await lstat(root);
      assert.equal(current.dev, identity.dev);
      assert.equal(current.ino, identity.ino);
      await rm(root, { recursive: true });
    },
  };
}
