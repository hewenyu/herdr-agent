import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { actor, discussion, setup } from "./helpers.js";

test("unchanged remote descriptions do not PATCH on every polling timestamp", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.reconcile(task.id);
    const writes = h.platform.updates;
    await h.service.reconcile(task.id);
    await h.service.reconcile(task.id);
    assert.equal(h.platform.updates, writes);
  } finally {
    h.close();
  }
});

test("unknown description PATCH is query-only until exact projected content is observed", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    h.platform.updateError = new OperationError("disconnected", "PATCH未确认", "unknown");
    await h.service.reconcile(task.id);
    const writes = h.platform.updates;
    h.platform.updateError = undefined;
    await h.service.reconcile(task.id);
    assert.equal(h.platform.updates, writes);
    const receipt = h.store.get<{ text: string }>("description_sync", task.id);
    const current = h.service.get(actor, task.id);
    assert.ok(receipt);
    const remote = h.platform.tasks.get(current.remoteTaskId ?? "");
    assert.ok(remote);
    remote.description = receipt.text;
    await h.service.reconcile(task.id);
    assert.equal(h.platform.updates, writes);
    assert.equal(h.service.get(actor, task.id).syncError, undefined);
    assert.equal(h.store.get<{ state: string }>("description_sync", task.id)?.state, "done");
  } finally {
    h.close();
  }
});
