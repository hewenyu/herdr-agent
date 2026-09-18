import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { actor, discussion, setup } from "./helpers.js";

test("a new user message cannot replay an uncertain completion or replace it with reopen", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    h.platform.updateError = new OperationError("timeout", "PATCH未确认", "unknown");
    await h.service.action({ ...actor, messageId: "complete-1" }, task.id, "complete");
    const receipt = h.store.get("completion_sync", task.id);
    const writes = h.platform.updates;
    await h.service.action({ ...actor, messageId: "complete-2" }, task.id, "complete");
    await h.service.action({ ...actor, messageId: "close" }, task.id, "close");
    assert.equal(h.platform.updates, writes);
    assert.deepEqual(h.store.get("completion_sync", task.id), receipt);
    await assert.rejects(
      h.service.action({ ...actor, messageId: "reopen" }, task.id, "reopen"),
      /同步|确认/,
    );
    assert.equal(h.platform.updates, writes);
    assert.equal(h.herdr.closes, 0);
  } finally {
    h.close();
  }
});

test("pause and resume cannot turn a completed task into a writable task", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete");
    for (const action of ["pause", "resume", "retry"] as const) {
      await assert.rejects(
        h.service.action({ ...actor, messageId: action }, task.id, action),
        /重开/,
      );
      assert.equal(h.service.get(actor, task.id).status, "completed");
    }
  } finally {
    h.close();
  }
});
