import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { canonical, stableId } from "../../src/core/ids.js";
import {
  type OperationReceipt,
  type OperationResolution,
  Operations,
} from "../../src/storage/operations.js";
import { Store } from "../../src/storage/store.js";

const treatDone: OperationResolution = {
  choice: "treat_done",
  decidedBy: "user",
  reason: "人工核对现场",
  at: "2026-10-01T00:00:00.000Z",
};

function receipt(
  id: string,
  state: OperationReceipt["state"],
  // Legacy receipts may predate the explicit `outcome` field.
  error?: { code: string; message: string; outcome?: "not_executed" | "unknown" },
): OperationReceipt {
  return {
    id,
    fingerprint: "fingerprint",
    state,
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...(error ? { error: error as OperationReceipt["error"] } : {}),
  };
}

/** Read the stored text without going through the typed Store decoding path. */
function rawValue(path: string, id: string): string | undefined {
  const database = new DatabaseSync(path);
  try {
    const row = database
      .prepare("SELECT value FROM records WHERE namespace='operations' AND key=?")
      .get(id) as { value: string } | undefined;
    return row?.value;
  } finally {
    database.close();
  }
}

/** Overwrite one row exactly as a damaged disk or an older writer could have. */
function corruptReceipt(path: string, id: string, value: string): void {
  const database = new DatabaseSync(path);
  try {
    database
      .prepare(
        `INSERT INTO records(namespace,key,value,updated_at) VALUES('operations',?,?,?)
         ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value`,
      )
      .run(id, value, "2026-10-01T00:00:00.000Z");
  } finally {
    database.close();
  }
}

async function fixture(t: TestContext): Promise<{ store: Store; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "herdr-operations-integrity-"));
  const path = join(directory, "state.sqlite");
  const store = new Store(path);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, path };
}

test("unparseable persisted operation receipt refuses every decision path and keeps raw evidence", async (t) => {
  const { store, path } = await fixture(t);
  corruptReceipt(path, "task:broken", "{oops");
  const operations = new Operations(store);
  let performed = 0;
  await assert.rejects(
    operations.run("task:broken", { attempt: 1 }, async () => {
      performed++;
      return "effect";
    }),
    (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "state_invalid");
      assert.equal(error.outcome, "unknown");
      assert.match(error.message, /task:broken/);
      // The parser message would echo the payload; the diagnostic must not.
      assert.doesNotMatch(error.message, /oops/);
      return true;
    },
  );
  assert.equal(performed, 0);
  assert.throws(() => operations.resolve("task:broken", treatDone), {
    code: "state_invalid",
    outcome: "unknown",
  });
  assert.throws(() => operations.resetFailed("task:"), {
    code: "state_invalid",
    outcome: "unknown",
  });
  // Scanning another prefix must not silently skip the unknown-effect row.
  assert.throws(() => operations.resetFailed("other:"), {
    code: "state_invalid",
    outcome: "unknown",
  });
  assert.equal(rawValue(path, "task:broken"), "{oops");
});

for (const value of [null, false, 0, "", [], "unexpected"] as const) {
  test(`receipt persisted as ${JSON.stringify(value)} blocks replay instead of reading as absent`, async (t) => {
    const { store, path } = await fixture(t);
    const id = "op:malformed";
    store.set("operations", id, value);
    const encoded = rawValue(path, id);
    assert.ok(encoded !== undefined);
    const operations = new Operations(store);
    let performed = 0;
    await assert.rejects(
      operations.run(id, { retry: true }, async () => {
        performed++;
        return "duplicate effect";
      }),
      { code: "state_invalid", outcome: "unknown" },
    );
    assert.equal(performed, 0);
    assert.throws(() => operations.resolve(id, treatDone), {
      code: "state_invalid",
      outcome: "unknown",
    });
    assert.throws(() => operations.resetFailed("op:"), {
      code: "state_invalid",
      outcome: "unknown",
    });
    assert.equal(rawValue(path, id), encoded);
  });
}

test("valid receipts keep their semantics: missing executes, done replays, conflict refuses", async (t) => {
  const { store, path } = await fixture(t);
  const operations = new Operations(store);
  let performed = 0;
  const perform = async () => {
    performed++;
    return { ok: true };
  };
  assert.deepEqual(await operations.run("op:new", { a: 1 }, perform), { ok: true });
  assert.deepEqual(await operations.run("op:new", { a: 1 }, perform), { ok: true });
  assert.equal(performed, 1);
  assert.equal(store.get<OperationReceipt>("operations", "op:new")?.state, "done");
  assert.ok(rawValue(path, "op:new"));
  await assert.rejects(operations.run("op:new", { a: 2 }, perform), {
    code: "operation_conflict",
  });
  assert.equal(performed, 1);
  // A definitely refused attempt stays retryable after resetFailed.
  await assert.rejects(
    operations.run("op:refused", {}, async () => {
      throw new OperationError("not_ready", "未执行");
    }),
    { code: "not_ready" },
  );
  operations.resetFailed("op:refused");
  assert.equal(store.get("operations", "op:refused"), undefined);
  assert.equal(await operations.run("op:refused", {}, async () => "retried"), "retried");
});

test("a failed receipt whose outcome is unknown is never retry authorization", async (t) => {
  const { store } = await fixture(t);
  const operations = new Operations(store);
  const parameters = {};
  store.set("operations", "op:unknown-failure", {
    ...receipt("op:unknown-failure", "failed", {
      code: "lost",
      message: "未知",
      outcome: "unknown",
    }),
    // The matching fingerprint isolates the outcome guard from a conflict.
    fingerprint: stableId(canonical(parameters)),
  });
  let performed = 0;
  await assert.rejects(
    operations.run("op:unknown-failure", parameters, async () => {
      performed++;
      return "duplicate effect";
    }),
    { code: "lost", outcome: "unknown" },
  );
  assert.equal(performed, 0);
});

test("malformed resolution input is refused before dereferencing or persisting it", async (t) => {
  const { store, path } = await fixture(t);
  const id = "op:resolution-input";
  store.set("operations", id, receipt(id, "uncertain"));
  const before = rawValue(path, id);
  for (const invalid of [
    null,
    1,
    {},
    { ...treatDone, reason: null },
    { ...treatDone, reason: {} },
    { ...treatDone, attempt: Number.NaN },
    { ...treatDone, attempt: Number.POSITIVE_INFINITY },
    { ...treatDone, attempt: -1 },
    { ...treatDone, attempt: 0.5 },
  ]) {
    assert.throws(() => new Operations(store).resolve(id, invalid as OperationResolution), {
      code: "operation_resolution_invalid",
    });
    assert.equal(rawValue(path, id), before);
  }
});

test("malformed retry identity and spent authorization cannot perform or replace evidence", async (t) => {
  const { store, path } = await fixture(t);
  const id = "op:retry-integrity";
  const retry = { ...treatDone, choice: "retry" as const };
  const valid = {
    ...receipt(id, "uncertain"),
    fingerprint: stableId(canonical({})),
    resolution: retry,
  };
  let performed = 0;
  for (const invalid of [
    { ...valid, id: "another-operation" },
    { ...valid, resolution: { ...retry, attempt: -1 } },
    { ...valid, resolution: { ...retry, attempt: 0.5 } },
    { ...valid, history: [valid] },
  ]) {
    store.set("operations", id, invalid);
    const before = rawValue(path, id);
    await assert.rejects(
      new Operations(store).run(id, {}, async () => {
        performed++;
        return "duplicate";
      }),
      { code: "state_invalid", outcome: "unknown" },
    );
    assert.equal(performed, 0);
    assert.equal(rawValue(path, id), before);
  }
});

test("resetFailed clears definite failures and preserves resolved historical receipts", async (t) => {
  const { store } = await fixture(t);
  const operations = new Operations(store);
  const rows: OperationReceipt[] = [
    receipt("task:definite", "failed", {
      code: "not_executed",
      message: "未执行",
      outcome: "not_executed",
    }),
    // Legacy definite failure without an explicit outcome field.
    receipt("task:legacy-failed", "failed", { code: "not_ready", message: "未执行" }),
    { ...receipt("task:resolved-pending", "pending"), resolution: treatDone },
    {
      ...receipt("task:resolved-uncertain", "uncertain", {
        code: "lost",
        message: "未知",
        outcome: "unknown",
      }),
      resolution: { ...treatDone, choice: "retry" },
    },
    {
      ...receipt("task:resolved-abandon", "uncertain", {
        code: "lost",
        message: "未知",
        outcome: "unknown",
      }),
      resolution: { ...treatDone, choice: "abandon" },
    },
    { ...receipt("other:resolved", "uncertain"), resolution: treatDone },
  ];
  for (const row of rows) store.set("operations", row.id, row);
  const before = new Map(store.entries<OperationReceipt>("operations"));
  operations.resetFailed("task:");
  assert.equal(store.get("operations", "task:definite"), undefined);
  assert.equal(store.get("operations", "task:legacy-failed"), undefined);
  for (const row of rows) {
    if (row.id === "task:definite" || row.id === "task:legacy-failed") continue;
    assert.deepEqual(store.get("operations", row.id), before.get(row.id));
  }
  // One-retry authorization survives the reset: the resolved retry receipt and
  // its history are still the durable evidence the retry cap reads.
  assert.equal(store.list<OperationReceipt>("operations").length, rows.length - 2);
});

test("resetFailed refuses unresolved and unknown-outcome receipts without deleting anything", async (t) => {
  const { store } = await fixture(t);
  const operations = new Operations(store);
  // A definitely failed-but-unknown row is interleaved with each case so a
  // reset that refuses the unknown row must refuse before deleting anything.
  store.set(
    "operations",
    "task:failed-unknown",
    receipt("task:failed-unknown", "failed", { code: "lost", message: "未知", outcome: "unknown" }),
  );
  const cases: OperationReceipt[] = [
    receipt("task:pending", "pending", { code: "lost", message: "未知", outcome: "unknown" }),
    receipt("task:uncertain", "uncertain", { code: "lost", message: "未知", outcome: "unknown" }),
  ];
  for (const row of cases) {
    store.set("operations", row.id, row);
    const before = store.entries<OperationReceipt>("operations");
    assert.throws(() => operations.resetFailed("task:"), {
      code: "operation_uncertain",
      outcome: "unknown",
    });
    assert.deepEqual(store.entries<OperationReceipt>("operations"), before);
  }
  for (const id of ["task:pending", "task:uncertain"]) store.delete("operations", id);
  const before = store.entries<OperationReceipt>("operations");
  assert.throws(() => operations.resetFailed("task:"), {
    code: "operation_uncertain",
    outcome: "unknown",
  });
  assert.deepEqual(store.entries<OperationReceipt>("operations"), before);
});

test("resetFailed leaves an in-flight operation protected", async (t) => {
  const { store } = await fixture(t);
  const operations = new Operations(store);
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = operations.run("task:live", {}, async () => {
    started();
    await waiting;
    return "done";
  });
  try {
    await admitted;
    assert.equal(operations.inFlight("task:live"), true);
    // An unresolved in-flight receipt stays protected even beside a definite
    // failure that a reset would otherwise clear.
    store.set(
      "operations",
      "task:definite",
      receipt("task:definite", "failed", {
        code: "not_executed",
        message: "未执行",
        outcome: "not_executed",
      }),
    );
    assert.throws(() => operations.resetFailed("task:"), {
      code: "operation_uncertain",
      outcome: "unknown",
    });
    assert.ok(store.get<OperationReceipt>("operations", "task:definite"));
    assert.equal(store.get<OperationReceipt>("operations", "task:live")?.state, "pending");
    // An inconsistent on-disk resolution cannot override the live execution guard.
    const live = store.get<OperationReceipt>("operations", "task:live");
    store.set("operations", "task:live", { ...live, resolution: treatDone });
    assert.throws(() => operations.resetFailed("task:"), {
      code: "operation_uncertain",
      outcome: "unknown",
    });
    assert.ok(store.get<OperationReceipt>("operations", "task:definite"));
  } finally {
    release();
    assert.equal(await running, "done");
  }
  assert.equal(store.get<OperationReceipt>("operations", "task:live")?.state, "done");
});
