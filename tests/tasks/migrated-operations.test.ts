import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { stableId } from "../../src/core/ids.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

async function legacyParticipant(h: ReturnType<typeof setup>) {
  const task = await h.service.create(actor, discussion);
  const participant = h.service.records.participants(task)[0];
  assert.ok(participant);
  h.store.delete("participants", participant.id);
  participant.id = `legacy_p_${stableId(task.id)}`;
  task.participantIds = [participant.id];
  h.service.records.saveParticipant(participant);
  h.service.records.save(task);
  return { task, participant };
}

for (const state of ["pending", "uncertain"] as const) {
  test(`migrated ${state} initial input is visible and prevents retry from erasing any receipts`, async () => {
    const h = setup();
    try {
      const { task, participant } = await legacyParticipant(h);
      h.herdr.delivery = { status: "unconfirmed", acked: false, verified: false, attempts: 1 };
      await h.service.reconcile(task.id);
      let current = h.service.get(actor, task.id);
      assert.equal(current.status, "attention");
      assert.match(current.error ?? "", /未确认/);
      assert.match(current.pending ?? "", /未确认/);
      assert.equal(current.participants[0]?.error, undefined);
      const key = `${participant.id}:initial`;
      const receipt = h.store.get<OperationReceipt>("operations", key);
      assert.ok(receipt);
      h.store.set("operations", key, { ...receipt, state });
      const failedId = `${task.id}:other`;
      h.store.set("operations", failedId, {
        ...receipt,
        id: failedId,
        state: "failed",
        error: { code: "not_executed", message: "未执行", outcome: "not_executed" },
      });
      const before = h.store.entries("operations");
      const restored = new TaskService(h.options);
      await assert.rejects(restored.action({ ...actor, messageId: "retry" }, task.id, "retry"), {
        code: "operation_uncertain",
      });
      assert.deepEqual(h.store.entries("operations"), before);
      await restored.reconcile(task.id);
      current = restored.get(actor, task.id);
      assert.equal(current.status, "attention");
      assert.match(current.pending ?? "", /未确认/);
      assert.equal(h.herdr.sends.length, 1);
    } finally {
      h.close();
    }
  });
}

test("explicit retry resets a migrated definitely unexecuted input and leaves unrelated receipts", async () => {
  const h = setup();
  try {
    const { task, participant } = await legacyParticipant(h);
    h.herdr.sendError = new OperationError("not_ready", "尚未执行");
    await h.service.reconcile(task.id);
    const key = `${participant.id}:initial`;
    const receipt = h.store.get<OperationReceipt>("operations", key);
    assert.equal(receipt?.state, "failed");
    const otherKey = `${participant.id}-other:initial`;
    const other = { ...receipt, id: otherKey, state: "uncertain" };
    h.store.set("operations", otherKey, other);
    h.herdr.sendError = undefined;
    await h.service.action({ ...actor, messageId: "retry" }, task.id, "retry");
    assert.equal(h.store.get("operations", key), undefined);
    assert.deepEqual(h.store.get("operations", otherKey), other);
    await h.service.reconcile(task.id);
    assert.equal(h.store.get<OperationReceipt>("operations", key)?.state, "done");
    assert.equal(h.service.get(actor, task.id).participants[0]?.initialSent, true);
    assert.equal(h.herdr.sends.length, 2);
  } finally {
    h.close();
  }
});

test("readback of migrated initial input preserves an independent uncertain participant close", async () => {
  const h = setup();
  try {
    const { task, participant } = await legacyParticipant(h);
    h.herdr.delivery = { status: "unconfirmed", acked: false, verified: false, attempts: 1 };
    await h.service.reconcile(task.id);
    h.herdr.closeError = new OperationError("close_unknown", "关闭未确认", "unknown");
    await assert.rejects(h.service.removeParticipant(actor, task.id, participant.id), {
      code: "close_unknown",
    });
    const closeKey = `${participant.id}:close`;
    const close = h.store.get<OperationReceipt>("operations", closeKey);
    assert.equal(close?.state, "uncertain");
    (h.herdr as HerdrPort).initialInput = async () => h.herdr.sends[0]?.text;
    const restored = new TaskService(h.options);
    await restored.reconcile(task.id);
    assert.equal(
      h.store.get<OperationReceipt>("operations", `${participant.id}:initial`)?.state,
      "done",
    );
    assert.equal(restored.get(actor, task.id).participants[0]?.initialSent, true);
    assert.match(restored.get(actor, task.id).pending ?? "", /未确认/);
    assert.deepEqual(h.store.get("operations", closeKey), close);
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.herdr.closes, 1);
  } finally {
    h.close();
  }
});
