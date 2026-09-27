import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { Participant, Task } from "../../src/core/types.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import {
  directoriesConflict,
  normalizedDirectories,
  workspaceAvailable,
  workspaceRevision,
} from "../../src/orchestration/workspace.js";
import { Store } from "../../src/storage/store.js";

const execute = promisify(execFile);
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "myrix-workspace-"));
  const cwd = join(dir, "repo");
  await mkdir(cwd);
  const store = new Store(":memory:");
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, cwd, store };
}

test("workspace revision includes working tree bytes, untracked and deleted files while excluding ignored dependencies", async (t) => {
  const { cwd } = await fixture(t);
  await execute("git", ["init", "--", cwd]);
  await writeFile(join(cwd, ".gitignore"), "node_modules/\nignored.txt\n");
  await writeFile(join(cwd, "source.ts"), "one");
  await execute("git", ["-C", cwd, "add", ".gitignore", "source.ts"]);
  const initial = await workspaceRevision([cwd]);
  await writeFile(join(cwd, "source.ts"), "two");
  const changed = await workspaceRevision([cwd]);
  assert.notEqual(changed, initial);
  await writeFile(join(cwd, "source.ts"), "one");
  assert.equal(await workspaceRevision([cwd]), initial);
  await writeFile(join(cwd, "new.ts"), "untracked");
  assert.notEqual(await workspaceRevision([cwd]), initial);
  await rm(join(cwd, "new.ts"));
  await mkdir(join(cwd, "node_modules"));
  await writeFile(join(cwd, "node_modules", "dependency.js"), "ignored");
  await writeFile(join(cwd, "ignored.txt"), "ignored");
  assert.equal(await workspaceRevision([cwd]), initial);
  await rm(join(cwd, "source.ts"));
  assert.notEqual(await workspaceRevision([cwd]), initial);
});

test("non-Git hashing stays within symlink boundaries and Git parent-symlink replacements fail closed", async (t) => {
  const { dir, cwd } = await fixture(t);
  const outside = join(dir, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "private.txt"), "private");
  await symlink(outside, join(cwd, "linked"));
  await writeFile(join(cwd, "code.ts"), "source");
  const before = await workspaceRevision([cwd]);
  await writeFile(join(outside, "private.txt"), "changed");
  assert.equal(await workspaceRevision([cwd]), before);
  await rm(join(cwd, "linked"));
  await mkdir(join(cwd, "linked"));
  await writeFile(join(cwd, "linked", "private.txt"), "tracked");
  await execute("git", ["init", "--", cwd]);
  await execute("git", ["-C", cwd, "add", "linked/private.txt"]);
  await rm(join(cwd, "linked"), { recursive: true });
  await symlink(outside, join(cwd, "linked"));
  await assert.rejects(workspaceRevision([cwd]), { code: "workspace_path" });
});

test("canonical directory overlap recognizes aliases and nested roots without shared-prefix false positives", async (t) => {
  const { dir, cwd } = await fixture(t);
  const alias = join(dir, "alias");
  await symlink(cwd, alias);
  const canonical = await normalizedDirectories([cwd, alias]);
  assert.equal(canonical.length, 1);
  assert.equal(
    directoriesConflict(canonical, await normalizedDirectories([join(alias, "new-dir")])),
    true,
  );
  assert.equal(
    directoriesConflict(canonical, await normalizedDirectories([join(dir, "repo-other")])),
    false,
  );
});

test("workspace admission considers working, awaiting and unknown facts across tasks with read/read compatibility", async (t) => {
  const { dir, cwd, store } = await fixture(t);
  const task = {
    id: "target",
    kind: "development",
    directories: [cwd],
    participantIds: [],
  } as unknown as Task;
  const other = {
    id: "other",
    kind: "development",
    directories: [cwd],
    participantIds: ["p"],
  } as unknown as Task;
  const participant = { id: "p", taskId: "other", status: "working" } as Participant;
  store.set("tasks", task.id, task);
  store.set("tasks", other.id, other);
  store.set("participants", participant.id, participant);
  assert.equal(await workspaceAvailable(store, task, "write"), false);
  assert.equal(await workspaceAvailable(store, task, "read"), false);
  store.set(WORKFLOWS, other.id, {
    plan: { nodes: [{ id: "review", access: "read" }] },
    nodes: { review: { participantId: "p", status: "dispatched", operationId: "other:review" } },
  } as unknown as WorkflowState);
  assert.equal(await workspaceAvailable(store, task, "read"), true);
  assert.equal(await workspaceAvailable(store, task, "write"), false);
  store.set("participants", participant.id, { ...participant, status: "done" });
  store.set("participant_awaiting_output", participant.id, { operationId: "other:review" });
  assert.equal(await workspaceAvailable(store, task, "write"), false);
  store.delete("participant_awaiting_output", participant.id);
  assert.equal(await workspaceAvailable(store, task, "write"), true);
  store.set("operations", "other:send-unknown", { state: "uncertain" });
  assert.equal(await workspaceAvailable(store, task, "read"), false);
  store.delete("operations", "other:send-unknown");
  store.set("participants", participant.id, { ...participant, status: "unknown" });
  assert.equal(await workspaceAvailable(store, task, "write"), false);
  const separate = join(dir, "separate");
  await mkdir(separate);
  store.set("tasks", other.id, { ...other, directories: [separate] });
  assert.equal(await workspaceAvailable(store, task, "write"), true);
  assert.equal(await workspaceAvailable(store, task, "read", [join(cwd, "nested")]), false);
});
