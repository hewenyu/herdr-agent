import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import {
  LEADER_OPERATIONS,
  readLeaderRecord,
} from "../../src/orchestration/leader-session-types.js";
import { Store } from "../../src/storage/store.js";

for (const value of [
  null,
  false,
  0,
  "",
  [],
  {},
  { version: "1" },
  { version: 2 },
  { version: { toString: null } },
  { version: [{ toString: null }] },
])
  test(`malformed Leader receipt ${JSON.stringify(value)} is not absence or replay permission`, () => {
    const root = realpathSync(tmpdir());
    const directory = mkdtempSync(join(root, "myrix-leader-malformed-"));
    const store = new Store(join(directory, "state.sqlite"));
    try {
      store.set(LEADER_OPERATIONS, "existing-operation", value);
      assert.throws(
        () => readLeaderRecord(store, LEADER_OPERATIONS, "existing-operation", "写操作"),
        (error: unknown) =>
          error instanceof OperationError && error.code === "leader_record_version_unsupported",
      );
      assert.deepEqual(store.get(LEADER_OPERATIONS, "existing-operation"), value);
      assert.equal(
        readLeaderRecord(store, LEADER_OPERATIONS, "absent-operation", "写操作"),
        undefined,
      );
    } finally {
      store.close();
      const resolved = realpathSync(directory);
      assert.equal(dirname(resolved), root);
      assert.ok(basename(resolved).startsWith("myrix-leader-malformed-"));
      rmSync(resolved, { recursive: true, force: true });
    }
  });
