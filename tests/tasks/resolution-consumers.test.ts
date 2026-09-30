import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { Delivery } from "../../src/core/types.js";
import type { OperationReceipt, OperationResolution } from "../../src/storage/operations.js";
import { TaskService } from "../../src/tasks/service.js";
import {
  applyUncertainResolution,
  listUncertainEffects,
} from "../../src/tasks/uncertain-effects.js";
import { actor, discussion, setup } from "./helpers.js";

async function uncertainInitial(f: ReturnType<typeof setup>) {
  f.herdr.delivery = { status: "unconfirmed", verified: false, acked: true, attempts: 1 };
  const task = await f.service.create(actor, {
    ...discussion,
    participants: [{ kind: "claude", name: "Claude" }],
  });
  await f.service.tick();
  const participant = f.service.get(actor, task.id).participants[0];
  assert.ok(participant?.execution);
  assert.equal(participant.initialSent, false);
  const id = `${participant.id}:initial`;
  const original = f.store.get<OperationReceipt>("operations", id);
  assert.equal(original?.state, "uncertain");
  assert.ok(f.store.get("input_deliveries", id));
  return { task, participant, id, original: original as OperationReceipt };
}

for (const decidedBy of ["evidence", "pi", "user"] as const) {
  test(`${decidedBy} treat_done advances an uncertain input once without claiming verification`, async () => {
    const outputs: string[] = [];
    const f = setup({
      output: async (_task, _participant, entry) => {
        outputs.push(entry.text);
      },
    });
    try {
      const { task, participant, id, original } = await uncertainInitial(f);
      const effect = listUncertainEffects(f.store, f.service.records.get(actor, task.id)).find(
        (entry) => entry.id === id,
      );
      assert.equal(effect?.kind, "input_delivery");
      applyUncertainResolution(f.store, effect as NonNullable<typeof effect>, {
        choice: "treat_done",
        decidedBy,
        reason: `${decidedBy} accepted the input as delivered`,
      });
      (f.herdr as HerdrPort).initialInput = async () =>
        assert.fail("a resolved input must not require another native read");
      await new TaskService(f.options).tick();
      const receipt = f.store.get<OperationReceipt>("operations", id);
      assert.equal(receipt?.state, original.state);
      assert.deepEqual(receipt?.error, original.error);
      assert.equal(receipt?.updatedAt, original.updatedAt);
      const resolution = receipt?.resolution as OperationResolution;
      assert.equal(resolution.decidedBy, decidedBy);
      assert.equal((resolution.result as Delivery).verified, decidedBy === "evidence");
      const current = f.service.get(actor, task.id);
      assert.equal(current.participants[0]?.initialSent, true);
      assert.equal(current.discussion.activeParticipant, participant.id);
      assert.equal(current.pending, undefined);
      const applied = f.store.get<{ at: string }>("task_input_applied", id);
      assert.ok(applied);
      assert.equal(
        f.store.get<{ operationId: string }>("participant_awaiting_output", participant.id)
          ?.operationId,
        id,
      );
      // A second recovery pass must not advance the participant again.
      const snapshot = f.store.get<OperationReceipt>("operations", id);
      await new TaskService(f.options).tick();
      assert.deepEqual(f.store.get("operations", id), snapshot);
      assert.deepEqual(f.store.get("task_input_applied", id), applied);
      assert.equal(f.herdr.sends.length, 1);
      // Scheduling continues: the participant's reply is observed and relayed once.
      f.herdr.finish(participant.execution?.paneId as string, "answered");
      await f.service.tick();
      await new TaskService(f.options).tick();
      assert.deepEqual(outputs, ["answered"]);
      assert.equal(f.herdr.sends.length, 1);
    } finally {
      f.close();
    }
  });
}

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
  const receipt = h.store.get<OperationReceipt>("operations", `${task.id}:delete-group`);
  assert.equal(receipt?.state, "uncertain");
  assert.equal(h.service.get(actor, task.id).error, receipt?.error?.message);
  return { task, receipt: receipt as OperationReceipt };
}

const decisions: Array<[string, OperationResolution | undefined, boolean]> = [
  ["pi treat_done", { choice: "treat_done", decidedBy: "pi", reason: "r", at: "" }, true],
  ["user treat_done", { choice: "treat_done", decidedBy: "user", reason: "r", at: "" }, true],
  ["user abandon", { choice: "abandon", decidedBy: "user", reason: "r", at: "" }, true],
  ["pi abandon", { choice: "abandon", decidedBy: "pi", reason: "r", at: "" }, false],
  ["user retry", { choice: "retry", decidedBy: "user", reason: "r", at: "" }, false],
  ["no resolution", undefined, false],
];
for (const [label, resolution, settles] of decisions) {
  test(`group deletion confirmation with another uncertain receipt (${label})`, async () => {
    const h = setup();
    try {
      const { task, receipt } = await lostDeletion(h);
      const otherId = `${task.id}:other`;
      const other: OperationReceipt = {
        ...receipt,
        id: otherId,
        ...(resolution ? { resolution: { ...resolution, at: new Date().toISOString() } } : {}),
      };
      h.store.set("operations", otherId, other);
      const restored = new TaskService(h.options);
      await restored.reconcile(task.id);
      const current = restored.get(actor, task.id);
      assert.equal(current.groupDeleted, true);
      assert.equal(current.error, settles ? undefined : receipt.error?.message);
      const confirmed = h.store.get<OperationReceipt>("operations", receipt.id);
      assert.equal(confirmed?.state, receipt.state);
      assert.deepEqual(confirmed?.error, receipt.error);
      assert.equal(confirmed?.updatedAt, receipt.updatedAt);
      assert.equal(confirmed?.resolution?.choice, "treat_done");
      assert.equal(confirmed?.resolution?.decidedBy, "evidence");
      assert.equal(
        (confirmed?.resolution?.result as { confirmedBy?: string } | undefined)?.confirmedBy,
        "group_status",
      );
      // The other receipt's history is never rewritten.
      assert.deepEqual(h.store.get("operations", otherId), other);
      assert.equal(h.platform.deletions, 1);
    } finally {
      h.close();
    }
  });
}
