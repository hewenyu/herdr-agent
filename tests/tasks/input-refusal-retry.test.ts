import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { Operations } from "../../src/storage/operations.js";
import { retryUnsentInput } from "../../src/tasks/input-delivery.js";
import { actor, discussion, setup } from "./helpers.js";

for (const code of ["agent_blocked", "transcript_unavailable"]) {
  test(`the same input resumes after a definite transient ${code} refusal`, async () => {
    const f = setup();
    f.config.ai.enabled = true;
    try {
      const task = await f.service.create(actor, {
        ...discussion,
        orchestration: { mode: "model" },
      });
      await f.service.tick();
      const first = f.service.get(actor, task.id).participants[0];
      assert.ok(first);
      const send = f.herdr.send.bind(f.herdr);
      let attempts = 0;
      f.herdr.send = async (ref, text) => {
        if (++attempts === 1) throw new OperationError(code, "definitely not sent");
        return send(ref, text);
      };
      await assert.rejects(f.service.send(actor, task.id, first.id, "same input"), { code });
      await f.service.send(actor, task.id, first.id, "same input");
      await f.service.send(actor, task.id, first.id, "same input");
      assert.equal(attempts, 2);
      assert.equal(f.herdr.sends.length, 1);
    } finally {
      f.close();
    }
  });
}

test("initial provisioning retries a transient pre-send read failure and preserves one actual input", async () => {
  const f = setup();
  try {
    const sample = f.herdr.sampleLastReply.bind(f.herdr);
    let failOnce = true;
    f.herdr.sampleLastReply = async (ref) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("temporary read failure");
      }
      return sample(ref);
    };
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 0);
    await f.service.tick();
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 1);
    assert.equal(f.service.get(actor, task.id).participants[0]?.initialSent, true);
  } finally {
    f.close();
  }
});

for (const outcome of ["not_executed", "unknown"] as const) {
  test(`input retry retains changed fingerprints and ${outcome} evidence`, async () => {
    const f = setup();
    try {
      const operations = new Operations(f.store);
      let calls = 0;
      const perform = async () => {
        calls++;
        throw new OperationError("agent_blocked", "blocked", outcome);
      };
      await assert.rejects(operations.run("input", { text: "original" }, perform));
      retryUnsentInput(f, "input", { text: "changed" });
      await assert.rejects(operations.run("input", { text: "changed" }, perform), {
        code: "operation_conflict",
      });
      if (outcome === "unknown") {
        retryUnsentInput(f, "input", { text: "original" });
        await assert.rejects(operations.run("input", { text: "original" }, perform), {
          code: "operation_uncertain",
        });
        assert.equal(f.store.get<OperationReceipt>("operations", "input")?.state, "uncertain");
      }
      assert.equal(calls, 1);
    } finally {
      f.close();
    }
  });
}

test("transient input refusals are bounded; validation failures are never automatically reset", async () => {
  const f = setup();
  try {
    const operations = new Operations(f.store);
    const parameters = { text: "input" };
    for (let attempt = 0; attempt < 3; attempt++) {
      retryUnsentInput(f, "input", parameters);
      await assert.rejects(
        operations.run("input", parameters, async () => {
          throw new OperationError("agent_blocked", "not sent");
        }),
      );
    }
    assert.throws(() => retryUnsentInput(f, "input", parameters), {
      code: "input_retry_exhausted",
    });
    await assert.rejects(
      operations.run("invalid", parameters, async () => {
        throw new OperationError("invalid_params", "invalid");
      }),
    );
    retryUnsentInput(f, "invalid", parameters);
    assert.equal(f.store.get<OperationReceipt>("operations", "invalid")?.state, "failed");
  } finally {
    f.close();
  }
});
