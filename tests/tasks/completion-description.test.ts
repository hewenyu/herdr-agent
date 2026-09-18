import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { actor, discussion, setup } from "./helpers.js";

test("confirmed completion description supersedes an older unknown projection after new participant output", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    h.platform.updateError = new OperationError("lost", "PATCH未确认", "unknown");
    await h.service.tick();
    const old = h.store.get<{ text: string; state: string }>("description_sync", task.id);
    assert.equal(old?.state, "uncertain");
    h.platform.updateError = undefined;
    h.herdr.finish("p1", "新增结果");
    await h.service.tick();
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete", {
      keepExecution: true,
      keepGroup: true,
    });
    const receipt = h.store.get<{ text: string; state: string }>("description_sync", task.id);
    assert.equal(receipt?.state, "done");
    assert.notEqual(receipt?.text, old?.text);
    assert.match(receipt?.text ?? "", /新增结果/);
    await h.service.tick();
    assert.equal(h.service.get(actor, task.id).status, "completed");
    assert.equal(h.service.get(actor, task.id).syncError, undefined);
    const writes = h.platform.updates;
    await h.service.tick();
    assert.equal(h.platform.updates, writes);
  } finally {
    h.close();
  }
});

test("confirmation of completedAt alone cannot resolve an unknown description or trigger a replay", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    h.platform.updateError = new OperationError("lost", "PATCH未确认", "unknown");
    await h.service.tick();
    h.platform.updateError = undefined;
    const remoteId = h.service.get(actor, task.id).remoteTaskId;
    assert.ok(remoteId);
    const remote = h.platform.tasks.get(remoteId);
    assert.ok(remote);
    h.platform.updateTask = async (_id, _description, completedAt) => {
      h.platform.updates++;
      if (completedAt !== undefined) remote.completedAt = completedAt;
    };
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete", {
      keepExecution: true,
      keepGroup: true,
    });
    assert.equal(h.service.get(actor, task.id).status, "completed");
    assert.equal(h.store.get<{ state: string }>("description_sync", task.id)?.state, "uncertain");
    const writes = h.platform.updates;
    await h.service.tick();
    await h.service.tick();
    assert.equal(h.platform.updates, writes);
    assert.match(h.service.get(actor, task.id).syncError ?? "", /只读核对/);
  } finally {
    h.close();
  }
});

test("uncertain completion keeps its submitted description immutable and resolves it only by exact readback", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    h.platform.updateError = new OperationError("lost", "PATCH未确认", "unknown");
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete", {
      keepExecution: true,
      keepGroup: true,
    });
    const target = h.store.get<{ description: string; completedAt: string }>(
      "completion_sync",
      task.id,
    );
    assert.ok(target);
    const changed = h.service.get(actor, task.id);
    changed.result = "本地后续变化";
    h.service.records.save(changed);
    h.platform.updateError = undefined;
    const writes = h.platform.updates;
    await h.service.tick();
    assert.equal(h.platform.updates, writes);
    const remote = h.platform.tasks.get(changed.remoteTaskId ?? "");
    assert.ok(remote);
    remote.completedAt = target.completedAt;
    remote.description = target.description;
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete", {
      keepExecution: true,
      keepGroup: true,
    });
    assert.equal(h.platform.updates, writes);
    assert.equal(h.service.get(actor, task.id).status, "completed");
    assert.deepEqual(h.store.get("description_sync", task.id), {
      text: target.description,
      state: "done",
    });
    assert.equal(
      h.store.get<{ description: string }>("completion_sync", task.id)?.description,
      target.description,
    );
  } finally {
    h.close();
  }
});
