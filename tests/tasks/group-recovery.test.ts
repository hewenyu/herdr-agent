import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { canonical, stableId } from "../../src/core/ids.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

async function lostDeletion(h: ReturnType<typeof setup>) {
  let dissolved = false;
  Object.assign(h.platform, {
    getGroupStatus: async () => (dissolved ? "dissolved" : "normal"),
  });
  const task = await h.service.create(actor, discussion);
  await h.service.reconcile(task.id);
  h.platform.deleteGroup = async () => {
    h.platform.deletions++;
    dissolved = true;
    throw new OperationError("lost_delete_ack", "删除成功但回执丢失", "unknown");
  };
  await h.service.action({ ...actor, messageId: "destroy" }, task.id, "destroy");
  await h.service.reconcile(task.id);
  const id = `${task.id}:delete-group`;
  const receipt = h.store.get<OperationReceipt>("operations", id);
  assert.equal(receipt?.state, "uncertain");
  assert.equal(h.service.get(actor, task.id).groupDeleted, false);
  return { task, id, receipt: receipt as OperationReceipt };
}

for (const state of ["pending", "uncertain"] as const) {
  test(`dissolved GET resolves matching ${state} deletion after restart without another DELETE`, async () => {
    const h = setup();
    try {
      const { task, id, receipt } = await lostDeletion(h);
      if (state === "pending") {
        h.store.set("operations", id, { ...receipt, state, error: undefined });
        const current = h.service.records.get(actor, task.id);
        current.error = undefined;
        h.service.records.save(current);
      }
      h.service.stop();
      const restored = new TaskService(h.options);
      await restored.reconcile(task.id);
      const current = restored.get(actor, task.id);
      const recovered = h.store.get<OperationReceipt>("operations", id);
      assert.equal(current.status, "destroyed");
      assert.equal(current.groupDeleted, true);
      assert.equal(current.error, undefined);
      assert.equal(current.completedAt, undefined, "resource cleanup is not task acceptance");
      assert.equal(recovered?.state, "done");
      assert.equal(recovered?.fingerprint, stableId(canonical({ chat: current.chatId })));
      assert.equal(recovered?.error, undefined);
      const result = recovered?.result as Record<string, unknown>;
      assert.equal(result.confirmedBy, "group_status");
      assert.equal(result.chatId, current.chatId);
      assert.equal(result.status, "dissolved");
      assert.equal(result.previousState, state);
      assert.deepEqual(result.previousError, state === "pending" ? undefined : receipt.error);
      assert.equal(typeof result.observedAt, "string");
      await restored.reconcile(task.id);
      await restored.tick();
      assert.deepEqual(h.store.get("operations", id), recovered);
      assert.equal(h.platform.deletions, 1);
      assert.equal(h.herdr.closes, 2);
    } finally {
      h.close();
    }
  });
}

test("external dissolution without a delete attempt creates no deletion receipt", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.reconcile(task.id);
    Object.assign(h.platform, { getGroupStatus: async () => "dissolved" });
    await h.service.reconcile(task.id);
    assert.equal(h.service.get(actor, task.id).status, "destroyed");
    assert.equal(h.store.get("operations", `${task.id}:delete-group`), undefined);
    assert.equal(h.platform.deletions, 0);
  } finally {
    h.close();
  }
});

for (const mismatch of ["fingerprint", "id"] as const) {
  test(`dissolved GET refuses a deletion receipt with mismatched ${mismatch}`, async () => {
    const h = setup();
    try {
      const { task, id, receipt } = await lostDeletion(h);
      const invalid = {
        ...receipt,
        ...(mismatch === "fingerprint"
          ? { fingerprint: stableId(canonical({ chat: "other-group" })) }
          : { id: "other-task:delete-group" }),
      };
      h.store.set("operations", id, invalid);
      const restored = new TaskService(h.options);
      await restored.reconcile(task.id);
      assert.deepEqual(h.store.get("operations", id), invalid);
      const current = restored.get(actor, task.id);
      assert.equal(current.groupDeleted, false);
      assert.equal(current.status, "destroying");
      assert.match(current.error ?? "", /不匹配/);
      assert.equal(h.platform.deletions, 1);
    } finally {
      h.close();
    }
  });
}

for (const read of ["normal", "unavailable"] as const) {
  test(`group ${read} cannot confirm an uncertain delete or repeat it`, async () => {
    const h = setup();
    try {
      const { task, id, receipt } = await lostDeletion(h);
      Object.assign(h.platform, {
        getGroupStatus: async () => {
          if (read === "unavailable") throw new OperationError("read_unavailable", "读失败");
          return "normal";
        },
      });
      const restored = new TaskService(h.options);
      await restored.reconcile(task.id);
      assert.deepEqual(h.store.get("operations", id), receipt);
      assert.equal(restored.get(actor, task.id).status, "destroying");
      assert.equal(restored.get(actor, task.id).groupDeleted, false);
      assert.equal(h.platform.deletions, 1);
    } finally {
      h.close();
    }
  });
}

for (const unresolved of [
  "different-error",
  "other-operation",
  "participant-error",
  "pending-delivery",
] as const) {
  test(`confirmed group deletion preserves ${unresolved}`, async () => {
    const h = setup();
    try {
      const { task, id, receipt } = await lostDeletion(h);
      const current = h.service.records.get(actor, task.id);
      if (unresolved === "different-error") {
        current.error = "另一项未解决问题";
        h.service.records.save(current);
      } else if (unresolved === "other-operation") {
        const otherId = `${task.id}:other`;
        h.store.set("operations", otherId, { ...receipt, id: otherId });
      } else if (unresolved === "participant-error") {
        const participant = h.service.records.participants(current)[0];
        assert.ok(participant);
        participant.error = "另一个执行器问题";
        h.service.records.saveParticipant(participant);
      } else {
        h.store.set("outbox", "pending-output", {
          chatId: current.chatId,
          state: "uncertain",
        });
      }
      const restored = new TaskService(h.options);
      await restored.reconcile(task.id);
      assert.equal(h.store.get<OperationReceipt>("operations", id)?.state, "done");
      assert.equal(restored.get(actor, task.id).error, current.error);
      assert.equal(h.platform.deletions, 1);
    } finally {
      h.close();
    }
  });
}

test("external dissolution never upgrades a definitely unexecuted delete", async () => {
  const h = setup();
  try {
    const { task, id, receipt } = await lostDeletion(h);
    const failed = {
      ...receipt,
      state: "failed" as const,
      error: { code: "denied", message: "未执行", outcome: "not_executed" as const },
    };
    h.store.set("operations", id, failed);
    const restored = new TaskService(h.options);
    await restored.reconcile(task.id);
    assert.equal(restored.get(actor, task.id).status, "destroyed");
    assert.deepEqual(h.store.get("operations", id), failed);
    assert.equal(h.platform.deletions, 1);
  } finally {
    h.close();
  }
});

for (const state of ["pending", "uncertain", "done"] as const) {
  test(`group recovery respects ${state} operations owned by a migrated participant`, async () => {
    const h = setup();
    try {
      let dissolved = false;
      Object.assign(h.platform, {
        getGroupStatus: async () => (dissolved ? "dissolved" : "normal"),
      });
      const task = await h.service.create(actor, discussion);
      const participant = h.service.records.participants(task)[0];
      assert.ok(participant);
      // Imported participant IDs are independent of the owning task ID.
      participant.id = `legacy_p_${stableId(task.id)}`;
      task.participantIds = [participant.id];
      h.service.records.saveParticipant(participant);
      h.service.records.save(task);
      h.herdr.delivery = { status: "unconfirmed", acked: false, verified: false, attempts: 1 };
      await h.service.reconcile(task.id);
      const initialId = `${participant.id}:initial`;
      const initial = h.store.get<OperationReceipt>("operations", initialId);
      assert.equal(initial?.state, "uncertain");
      assert.equal(h.service.records.participants(task)[0]?.error, undefined);
      const saved = { ...initial, state };
      h.store.set("operations", initialId, saved);
      h.platform.deleteGroup = async () => {
        h.platform.deletions++;
        dissolved = true;
        throw new OperationError("lost_delete_ack", "删除成功但回执丢失", "unknown");
      };
      await h.service.action({ ...actor, messageId: "destroy" }, task.id, "destroy");
      await h.service.reconcile(task.id);
      const id = `${task.id}:delete-group`;
      const deletion = h.store.get<OperationReceipt>("operations", id);
      assert.equal(deletion?.state, "uncertain");
      assert.equal(h.service.get(actor, task.id).error, deletion?.error?.message);
      h.service.stop();
      const restored = new TaskService(h.options);
      await restored.reconcile(task.id);
      const current = restored.get(actor, task.id);
      assert.equal(current.status, "destroyed");
      assert.equal(current.groupDeleted, true);
      assert.equal(current.error, state === "done" ? undefined : deletion?.error?.message);
      assert.equal(h.store.get<OperationReceipt>("operations", id)?.state, "done");
      assert.deepEqual(h.store.get("operations", initialId), saved);
      assert.equal(h.herdr.sends.length, 1);
      assert.equal(h.herdr.closes, 1);
      assert.equal(h.platform.deletions, 1);
    } finally {
      h.close();
    }
  });
}

test("cached groupDeleted without a fresh GET cannot confirm an uncertain receipt", async () => {
  const h = setup();
  try {
    const { task, id, receipt } = await lostDeletion(h);
    const current = h.service.records.get(actor, task.id);
    current.groupDeleted = true;
    h.service.records.save(current);
    Object.assign(h.platform, {
      getGroupStatus: async () => assert.fail("cached group state must not be used as a new GET"),
    });
    const restored = new TaskService(h.options);
    await restored.reconcile(task.id);
    assert.deepEqual(h.store.get("operations", id), receipt);
    assert.equal(restored.get(actor, task.id).error, current.error);
    assert.equal(h.platform.deletions, 1);
  } finally {
    h.close();
  }
});

test("group recovery rolls back receipt and task state together when persistence fails", async () => {
  const h = setup();
  try {
    const { task, id, receipt } = await lostDeletion(h);
    const write = h.store.set.bind(h.store);
    let failed = false;
    h.store.set = (namespace, key, value) => {
      if (namespace === "tasks" && key === task.id && !failed) {
        failed = true;
        throw new OperationError("storage_failure", "记录暂不可写");
      }
      return write(namespace, key, value);
    };
    const restored = new TaskService(h.options);
    await restored.reconcile(task.id);
    assert.equal(failed, true);
    assert.deepEqual(h.store.get("operations", id), receipt);
    assert.equal(restored.get(actor, task.id).groupDeleted, false);
    assert.equal(restored.get(actor, task.id).status, "destroying");
    await restored.reconcile(task.id);
    assert.equal(h.store.get<OperationReceipt>("operations", id)?.state, "done");
    assert.equal(restored.get(actor, task.id).status, "destroyed");
    assert.equal(restored.get(actor, task.id).error, "记录暂不可写");
    assert.equal(h.platform.deletions, 1);
  } finally {
    h.close();
  }
});
