import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import {
  type OperationReceipt,
  type OperationResolution,
  Operations,
} from "../../src/storage/operations.js";
import { Store } from "../../src/storage/store.js";

for (const choice of ["treat_done", "retry", "abandon"] as const) {
  test(`unknown operation resolution ${choice} preserves history and enforces fingerprint`, async () => {
    const store = new Store(":memory:");
    try {
      const operations = new Operations(store);
      let calls = 0;
      const perform = async () => {
        calls++;
        throw new OperationError("lost", "unknown", "unknown");
      };
      await assert.rejects(operations.run("op", { x: 1 }, perform));
      const before = store.get<OperationReceipt>("operations", "op");
      const resolution: OperationResolution = {
        choice,
        decidedBy: "user",
        reason: "accepted risk",
        at: new Date().toISOString(),
      };
      operations.resolve("op", resolution);
      const after = store.get<OperationReceipt>("operations", "op");
      assert.equal(after?.state, before?.state);
      assert.deepEqual(after?.error, before?.error);
      assert.equal(after?.updatedAt, before?.updatedAt);
      assert.throws(() => operations.resolve("op", resolution), {
        code: "operation_resolution_conflict",
      });
      await assert.rejects(operations.run("op", { x: 2 }, perform), { code: "operation_conflict" });
      if (choice === "treat_done") {
        assert.equal(await operations.run("op", { x: 1 }, perform), undefined);
        assert.equal(calls, 1);
      } else if (choice === "abandon") {
        await assert.rejects(operations.run("op", { x: 1 }, perform), {
          code: "operation_abandoned",
          outcome: "not_executed",
        });
        assert.equal(calls, 1);
      } else {
        await assert.rejects(operations.run("op", { x: 1 }, perform), { code: "lost" });
        await assert.rejects(operations.run("op", { x: 1 }, perform), {
          code: "operation_uncertain",
        });
        assert.equal(calls, 2);
        const current = store.get<OperationReceipt>("operations", "op");
        assert.equal(current?.resolution, undefined);
        assert.deepEqual(current?.history?.[0]?.resolution, resolution);
        assert.deepEqual(current?.history?.[0]?.error, before?.error);
        assert.throws(() => operations.resolve("op", resolution), {
          code: "operation_retry_exhausted",
        });
        operations.resolve("op", { ...resolution, choice: "treat_done", result: "target result" });
        assert.equal(await operations.run("op", { x: 1 }, perform), "target result");
      }
    } finally {
      store.close();
    }
  });
}

test("in-flight API is store-scoped, shared across instances, and blocks decisions", async () => {
  const store = new Store(":memory:");
  const other = new Store(":memory:");
  const operations = new Operations(store);
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    const running = operations.run("op", {}, async () => {
      started();
      await waiting;
      return "done";
    });
    await admitted;
    assert.equal(new Operations(store).inFlight("op"), true);
    assert.equal(new Operations(other).inFlight("op"), false);
    assert.throws(
      () =>
        operations.resolve("op", {
          choice: "treat_done",
          decidedBy: "user",
          reason: "racing",
          at: new Date().toISOString(),
        }),
      { code: "operation_resolution_invalid" },
    );
    release();
    await running;
    assert.equal(operations.inFlight("op"), false);
  } finally {
    release();
    store.close();
    other.close();
  }
});

test("pending receipts require explicit resolution; successful retry consumes only once", async () => {
  const store = new Store(":memory:");
  try {
    const operations = new Operations(store);
    await assert.rejects(
      operations.run("op", {}, async () => {
        throw new Error("lost");
      }),
    );
    const receipt = store.get<OperationReceipt>("operations", "op");
    store.set("operations", "op", { ...receipt, state: "pending" });
    await assert.rejects(
      operations.run("op", {}, async () => 42),
      { code: "operation_uncertain" },
    );
    operations.resolve("op", {
      choice: "retry",
      decidedBy: "pi",
      reason: "retry",
      at: new Date().toISOString(),
    });
    let calls = 0;
    const perform = async () => {
      calls++;
      return 42;
    };
    const results = await Promise.all([
      operations.run("op", {}, perform),
      operations.run("op", {}, perform),
    ]);
    assert.deepEqual(results, [42, 42]);
    assert.equal(calls, 1);
    assert.throws(
      () =>
        operations.resolve("op", {
          choice: "retry",
          decidedBy: "user",
          reason: "retry",
          at: new Date().toISOString(),
        }),
      { code: "operation_resolution_invalid" },
    );
  } finally {
    store.close();
  }
});
