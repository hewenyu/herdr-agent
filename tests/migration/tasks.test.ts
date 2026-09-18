import assert from "node:assert/strict";
import { readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Participant, Task } from "../../src/core/types.js";
import { migrateLegacy } from "../../src/migration/index.js";
import { Operations } from "../../src/storage/operations.js";
import { fixture, task } from "./fixtures.js";

test("dry-run has no writes; apply snapshots originals and preserves native resources and close intent", async (t) => {
  const { dir, store, write } = await fixture(t);
  const records = {
    done: task("done", { status: "completed", completed_at: "1780000000000" }),
    closing: task("closing", { status: "destroying", close_requested: true }),
  };
  await write("tasks.json", { version: 1, records });
  await writeFile(join(dir, ".env"), "FEISHU_APP_SECRET=offline-fixture\n");
  const original = await readFile(join(dir, "tasks.json"));
  const preview = await migrateLegacy(dir, store, { dryRun: true });
  assert.equal(preview.state, "planned");
  assert.equal(preview.counts.tasks, 2);
  assert.deepEqual(store.list("tasks"), []);
  assert.deepEqual((await readdir(dir)).sort(), [".env", "tasks.json"]);
  const applied = await migrateLegacy(dir, store);
  assert.equal(applied.state, "migrated");
  assert.ok(applied.backupDir);
  assert.deepEqual(await readFile(join(applied.backupDir, "tasks.json")), original);
  assert.deepEqual(await readFile(join(dir, "tasks.json")), original);
  assert.equal((await stat(join(applied.backupDir, ".env"))).mode & 0o777, 0o600);
  assert.equal((await stat(applied.backupDir)).mode & 0o777, 0o700);
  const manifest = await readFile(join(applied.backupDir, "manifest.json"), "utf8");
  assert.ok(!manifest.includes("offline-fixture"));
  assert.ok(applied.rollback.some((line) => line.includes("WAL/SHM")));
  const done = store.get<Task>("tasks", "done");
  assert.ok(done);
  assert.equal(done.status, "completed");
  assert.equal(done.closeRequested, false);
  assert.equal(done.keepGroup, false);
  assert.equal(done.bypass, true);
  assert.deepEqual(done.directories, ["/project", "/second"]);
  assert.equal(store.get<Task>("tasks", "closing")?.closeRequested, true);
  const participant = store.get<Participant>("participants", done.participantIds[0] ?? "");
  assert.deepEqual(participant?.execution, {
    workspaceId: "workspace",
    paneId: "pane-done",
    kind: "codex",
    cwd: "/agent-worktree",
    sessionId: "native-done",
  });
  assert.equal(participant?.initialSent, true);
  assert.equal(participant?.cursor, undefined);
  assert.deepEqual(store.get("legacy_imports", participant?.id ?? ""), {
    taskId: "done",
    promptSent: true,
    resultDelivered: true,
    lastResult: "旧结果",
  });
  assert.equal((await migrateLegacy(dir, store)).state, "already_migrated");
  assert.equal(store.list("tasks").length, 2);
  assert.equal((await readdir(join(dir, "backups"))).length, 1);
  await write("tasks.json", { version: 1, records: {} });
  await assert.rejects(migrateLegacy(dir, store), { code: "migration_source_changed" });
  assert.equal(store.list("tasks").length, 2);
});

test("interrupted legacy effects freeze task and cannot be cleared by retry", async (t) => {
  const { dir, store, write } = await fixture(t);
  await write("tasks.json", {
    version: 1,
    records: { uncertain: task("uncertain", { pending: "send_prompt", status: "starting" }) },
  });
  const result = await migrateLegacy(dir, store);
  assert.equal(store.get<Task>("tasks", "uncertain")?.status, "attention");
  assert.equal(store.get<Task>("tasks", "uncertain")?.pending, "send_prompt");
  assert.equal(result.warnings.length, 1);
  assert.throws(() => new Operations(store).resetFailed("uncertain:"), {
    code: "operation_uncertain",
  });
});

test("invalid task version, identity, directories and execution bindings refuse atomically", async (t) => {
  const mutations = [
    { version: 2, records: {} },
    { version: 1, records: null },
    ...[
      { id: "wrong" },
      { directories: ["relative"] },
      { workspace_id: "" },
      { started: "true" },
      { agent_cwd: "relative" },
      { status: "invented" },
    ].map((change) => ({ version: 1, records: { "task-1": task("task-1", change) } })),
    {
      version: 1,
      records: { "task-1": task(), "task-2": task("task-2", { pane_id: "pane-task-1" }) },
    },
  ];
  for (const data of mutations) {
    const { dir, store, write } = await fixture(t);
    await write("tasks.json", data);
    await assert.rejects(migrateLegacy(dir, store), { code: "migration_invalid" });
    assert.deepEqual(store.list("tasks"), []);
    assert.deepEqual(store.list("migrations"), []);
    assert.deepEqual(await readdir(dir), ["tasks.json"]);
  }
});

test("existing SQLite facts are not overwritten", async (t) => {
  const { dir, store, write } = await fixture(t);
  await write("tasks.json", { version: 1, records: { "task-1": task() } });
  store.set("tasks", "task-1", { current: true });
  await assert.rejects(migrateLegacy(dir, store), { code: "migration_conflict" });
  assert.deepEqual(store.get("tasks", "task-1"), { current: true });
  assert.deepEqual(await readdir(dir), ["tasks.json"]);
});

test("source and backup directory symlinks are refused before database mutation", async (t) => {
  const source = await fixture(t);
  const outside = await fixture(t);
  await outside.write("tasks.json", { version: 1, records: {} });
  await symlink(join(outside.dir, "tasks.json"), join(source.dir, "tasks.json"));
  await assert.rejects(migrateLegacy(source.dir, source.store), { code: "migration_invalid" });
  const target = await fixture(t);
  await target.write("tasks.json", { version: 1, records: {} });
  await symlink(outside.dir, join(target.dir, "backups"));
  await assert.rejects(migrateLegacy(target.dir, target.store), { code: "migration_invalid" });
  assert.deepEqual(storeFacts(target.store), []);
  assert.deepEqual(await readdir(outside.dir), ["tasks.json"]);
});
function storeFacts(store: { list(namespace: string): unknown[] }) {
  return store.list("migrations");
}
