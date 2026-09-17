import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { atomicWrite } from "../../src/storage/atomic.js";
import { Operations } from "../../src/storage/operations.js";
import { Store } from "../../src/storage/store.js";

test("SQLite durably reopens and secures database, WAL and SHM before writes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  await writeFile(path, "", { mode: 0o644 });
  const store = new Store(path);
  store.set("tasks", "one", { result: "durable" });
  for (const suffix of ["", "-wal", "-shm"])
    assert.equal((await stat(path + suffix)).mode & 0o777, 0o600);
  assert.throws(() =>
    store.transaction(() => {
      store.set("tasks", "two", {});
      store.transaction(() => store.set("tasks", "three", {}));
      throw new Error("rollback");
    }),
  );
  assert.equal(store.get("tasks", "two"), undefined);
  assert.equal(store.get("tasks", "three"), undefined);
  assert.throws(() => store.transaction(() => Promise.resolve()), /synchronous/);
  store.close();
  const reopened = new Store(path);
  assert.deepEqual(reopened.get("tasks", "one"), { result: "durable" });
  reopened.close();
});

test("operation ledger caches successful results, rejects parameter changes and freezes unknown effects", async () => {
  const store = new Store(":memory:");
  try {
    const operations = new Operations(store);
    let count = 0;
    const execute = () =>
      operations.run("task:send", { text: "do work" }, async () => {
        count++;
        return { sent: true };
      });
    assert.deepEqual(await Promise.all([execute(), execute()]), [{ sent: true }, { sent: true }]);
    assert.equal(count, 1);
    await assert.rejects(
      operations.run("task:send", { text: "different" }, async () => {}),
      { code: "operation_conflict" },
    );
    await assert.rejects(
      operations.run("task:unknown", {}, async () => {
        throw new Error("lost response");
      }),
    );
    let replayed = false;
    await assert.rejects(
      operations.run("task:unknown", {}, async () => {
        replayed = true;
      }),
      { code: "operation_uncertain" },
    );
    assert.equal(replayed, false);
    assert.throws(() => operations.resetFailed("task:"), { code: "operation_uncertain" });
    await assert.rejects(
      operations.run("other:known", {}, async () => {
        throw new OperationError("refused", "Not executed");
      }),
    );
    operations.resetFailed("other:");
    assert.equal(await operations.run("other:known", {}, async () => "retried"), "retried");
  } finally {
    store.close();
  }
});

test("atomic file replacement keeps private permissions and preserves prior data on pre-rename failure", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-atomic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "config");
  await atomicWrite(path, "first");
  await atomicWrite(path, "second");
  assert.equal(await readFile(path, "utf8"), "second");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const directory = join(dir, "existing-directory");
  await mkdir(directory);
  await writeFile(join(directory, "retained"), "old");
  await assert.rejects(atomicWrite(directory, "cannot replace"));
  assert.equal(await readFile(join(directory, "retained"), "utf8"), "old");
});
