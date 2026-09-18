import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { ExecutionRef } from "../../src/core/types.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

test("explicit destroy cleans resources despite an uncertain completion and unavailable completion reads", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    h.platform.updateError = new OperationError("lost_response", "completion unknown", "unknown");
    await h.service.action({ ...actor, messageId: "close" }, task.id, "close");
    const intent = h.store.get<{ id: string }>("completion_sync", task.id);
    assert.ok(intent);
    assert.equal(h.store.get<OperationReceipt>("operations", intent.id)?.state, "uncertain");
    const writes = h.platform.updates;
    h.platform.getError = new OperationError("offline", "completion read unavailable");
    await h.service.action({ ...actor, messageId: "destroy" }, task.id, "destroy");
    const restored = new TaskService(h.options);
    await restored.tick();
    const current = restored.get(actor, task.id);
    assert.equal(current.status, "destroyed");
    assert.equal(current.completedAt, undefined, "destroy does not assert acceptance");
    assert.equal(current.completionRequest, undefined);
    assert.equal(h.herdr.closes, 2);
    assert.equal(h.platform.deletions, 1);
    assert.equal(h.platform.updates, writes, "abandoned completion is never replayed");
    assert.equal(
      h.store.get<OperationReceipt>("operations", intent.id)?.state,
      "uncertain",
      "the unresolved remote receipt remains auditable",
    );
    await restored.tick();
    assert.equal(h.herdr.starts, 2);
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    h.close();
  }
});

test("restarted cleanup cannot be reversed by an older pending completion intent", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    h.platform.updateError = new OperationError("lost_response", "completion unknown", "unknown");
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete");
    // State left by an earlier build after destroy was requested during uncertain completion.
    const pending = h.service.get(actor, task.id);
    pending.status = "destroying";
    pending.closeRequested = false;
    h.service.records.save(pending);
    const remote = h.platform.tasks.get(pending.remoteTaskId ?? "");
    assert.ok(remote);
    remote.completedAt = "eventually-completed";
    h.platform.updateError = undefined;
    const restored = new TaskService(h.options);
    await restored.tick();
    assert.equal(restored.get(actor, task.id).status, "destroyed");
    assert.equal(restored.get(actor, task.id).completionRequest, undefined);
    assert.equal(h.herdr.closes, 2);
    assert.equal(h.platform.deletions, 1);
  } finally {
    h.close();
  }
});

test("repeating close resumes partial pane and group cleanup without repeating confirmed effects", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    const attempts: string[] = [];
    let refuseSecond = true;
    let refuseGroup = true;
    h.herdr.close = async (ref: ExecutionRef) => {
      attempts.push(ref.paneId);
      if (ref.paneId === "p2" && refuseSecond) throw new OperationError("busy", "not executed");
      h.herdr.agents.delete(ref.paneId);
    };
    h.platform.deleteGroup = async () => {
      h.platform.deletions++;
      if (refuseGroup) throw new OperationError("rate_limited", "not executed");
    };
    await h.service.action({ ...actor, messageId: "close-1" }, task.id, "close");
    await h.service.tick();
    assert.equal(h.service.get(actor, task.id).status, "destroying");
    assert.deepEqual(attempts, ["p1", "p2"]);
    refuseSecond = false;
    await h.service.action({ ...actor, messageId: "close-2" }, task.id, "close");
    await h.service.tick();
    assert.equal(h.service.get(actor, task.id).status, "destroying");
    assert.deepEqual(attempts, ["p1", "p2", "p2"]);
    assert.equal(h.platform.deletions, 1);
    refuseGroup = false;
    const restored = new TaskService(h.options);
    await restored.action({ ...actor, messageId: "close-3" }, task.id, "close");
    await restored.tick();
    assert.equal(restored.get(actor, task.id).status, "destroyed");
    assert.deepEqual(attempts, ["p1", "p2", "p2"]);
    assert.equal(h.platform.deletions, 2);
    assert.equal(h.platform.updateCalls.filter((call) => call.completedAt !== undefined).length, 1);
    assert.equal(h.herdr.starts, 2);
  } finally {
    h.close();
  }
});

test("unknown pane deletion remains unconfirmed on explicit destroy retries and is never blindly repeated", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    h.herdr.closeError = new OperationError("lost_response", "close unknown", "unknown");
    await h.service.action({ ...actor, messageId: "destroy-1" }, task.id, "destroy");
    await h.service.tick();
    assert.equal(h.herdr.closes, 1);
    h.herdr.closeError = undefined;
    await h.service.action({ ...actor, messageId: "destroy-2" }, task.id, "destroy");
    await h.service.tick();
    assert.equal(h.service.get(actor, task.id).status, "destroying");
    assert.equal(h.herdr.closes, 1);
    assert.equal(h.platform.deletions, 0);
    assert.equal(h.herdr.starts, 2);
  } finally {
    h.close();
  }
});
