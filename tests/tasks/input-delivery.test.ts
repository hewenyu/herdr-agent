import assert from "node:assert/strict";
import test from "node:test";
import type { HerdrPort } from "../../src/core/ports.js";
import type { Task } from "../../src/core/types.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import type { InputDelivery } from "../../src/tasks/input-delivery.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

test("a later round lost acknowledgement resumes from exact native input after restart", async () => {
  const outputs: string[] = [];
  const f = setup({
    output: async (_task, _participant, entry) => {
      outputs.push(entry.text);
    },
  });
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const [first, second] = f.service.get(actor, task.id).participants;
    assert.ok(first?.execution && second?.execution);
    f.herdr.finish(first.execution.paneId, "first round A");
    await f.service.tick();
    f.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    f.herdr.finish(second.execution.paneId, "first round B");
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 3);
    const [id, delivery] =
      f.store
        .entries<InputDelivery>("input_deliveries")
        .find(([, entry]) => entry.participantId === first.id && !entry.initial) ?? [];
    assert.ok(id && delivery);
    assert.notEqual(delivery.receipt, first.initialReceipt);
    assert.equal(delivery.prompt, f.herdr.sends[2]?.text);
    assert.equal(f.store.get<OperationReceipt>("operations", id)?.state, "uncertain");
    assert.equal(f.service.get(actor, task.id).discussion.paused, true);
    (f.herdr as HerdrPort).initialInput = async (_ref, receipt) =>
      receipt === delivery.receipt ? delivery.prompt : undefined;
    f.herdr.delivery = { status: "delivered", acked: true, verified: true, attempts: 1 };
    const restarted = new TaskService(f.options);
    await restarted.tick();
    assert.equal(f.store.get<OperationReceipt>("operations", id)?.state, "done");
    assert.equal(f.herdr.sends.length, 3, "readback never resends the same turn");
    assert.equal(restarted.get(actor, task.id).discussion.paused, false);
    f.herdr.finish(first.execution.paneId, "second round A");
    await restarted.tick();
    assert.equal(f.herdr.sends.length, 4, "the next participant continues automatically");
    assert.equal(f.herdr.sends[3]?.pane, second.execution.paneId);
    assert.deepEqual(outputs, ["first round A", "first round B", "second round A"]);
  } finally {
    f.close();
  }
});

for (const evidence of ["exact", "wrong_body", "changed_session", "paused"] as const) {
  test(`follow-up input recovery is exact and preserves user control (${evidence})`, async () => {
    const f = setup();
    try {
      const task = await f.service.create(actor, {
        ...discussion,
        participants: [{ kind: "claude", name: "Claude" }],
      });
      await f.service.tick();
      const participant = f.service.get(actor, task.id).participants[0];
      assert.ok(participant?.execution);
      f.herdr.finish(participant.execution.paneId, "first answer");
      await f.service.tick();
      f.herdr.delivery = { status: "unconfirmed", acked: false, verified: false, attempts: 1 };
      await assert.rejects(
        f.service.send({ ...actor, messageId: "later" }, task.id, participant.id, "continue"),
      );
      const [id, delivery] =
        f.store.entries<InputDelivery>("input_deliveries").find(([, entry]) => !entry.initial) ??
        [];
      assert.ok(id && delivery);
      (f.herdr as HerdrPort).initialInput = async (_ref, receipt) =>
        receipt === delivery.receipt
          ? `${delivery.prompt}${evidence === "wrong_body" ? "changed" : ""}`
          : undefined;
      if (evidence === "changed_session") {
        const current = f.service.get(actor, task.id).participants[0];
        assert.ok(current?.execution);
        current.execution.sessionId = "another-session";
        f.store.set("participants", current.id, current);
      }
      if (evidence === "paused") {
        const current = f.store.get<Task>("tasks", task.id);
        assert.ok(current);
        current.status = "paused";
        f.store.set("tasks", task.id, current);
      }
      await new TaskService(f.options).tick();
      assert.equal(
        f.store.get<OperationReceipt>("operations", id)?.state,
        evidence === "wrong_body" || evidence === "changed_session" ? "uncertain" : "done",
      );
      assert.equal(f.herdr.sends.length, 2);
      assert.equal(f.service.get(actor, task.id).discussion.paused, true);
      if (evidence === "paused") assert.equal(f.service.get(actor, task.id).status, "paused");
    } finally {
      f.close();
    }
  });
}

test("late native input readback cannot resurrect a turn whose answer already settled", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, {
      ...discussion,
      participants: [{ kind: "claude", name: "Claude" }],
    });
    await f.service.tick();
    const participant = f.service.get(actor, task.id).participants[0];
    assert.ok(participant?.execution);
    f.herdr.finish(participant.execution.paneId, "first answer");
    await f.service.tick();
    f.herdr.delivery = { status: "unconfirmed", acked: false, verified: false, attempts: 1 };
    await assert.rejects(
      f.service.send({ ...actor, messageId: "later" }, task.id, participant.id, "continue"),
    );
    const [id, delivery] =
      f.store.entries<InputDelivery>("input_deliveries").find(([, entry]) => !entry.initial) ?? [];
    assert.ok(id && delivery);
    f.herdr.finish(participant.execution.paneId, "final answer");
    await f.service.tick();
    assert.equal(f.store.get("participant_awaiting_output", participant.id), undefined);
    (f.herdr as HerdrPort).initialInput = async () => delivery.prompt;
    await new TaskService(f.options).tick();
    assert.equal(f.store.get<OperationReceipt>("operations", id)?.state, "done");
    assert.equal(f.store.get("participant_awaiting_output", participant.id), undefined);
    assert.equal(f.service.get(actor, task.id).status, "review");
    assert.equal(f.herdr.sends.length, 2);
  } finally {
    f.close();
  }
});

test("restart applies a confirmed receipt committed before participant state", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, {
      ...discussion,
      participants: [{ kind: "claude", name: "Claude" }],
    });
    await f.service.tick();
    const participant = f.service.get(actor, task.id).participants[0];
    assert.ok(participant?.execution);
    f.herdr.finish(participant.execution.paneId, "first answer");
    await f.service.tick();
    await f.service.send({ ...actor, messageId: "follow-up" }, task.id, participant.id, "continue");
    const [id] =
      f.store.entries<InputDelivery>("input_deliveries").find(([, entry]) => !entry.initial) ?? [];
    assert.ok(id);
    f.store.delete("task_input_applied", id);
    f.store.delete("participant_awaiting_output", participant.id);
    const current = f.service.get(actor, task.id).participants[0];
    assert.ok(current);
    current.status = "idle";
    f.store.set("participants", current.id, current);
    await new TaskService(f.options).tick();
    assert.ok(f.store.get("task_input_applied", id));
    assert.equal(
      f.store.get<{ operationId: string }>("participant_awaiting_output", participant.id)
        ?.operationId,
      id,
    );
    assert.equal(f.herdr.sends.length, 2);
  } finally {
    f.close();
  }
});

test("late delivery proof never resumes scheduling after an explicit interrupt", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const [first, second] = f.service.get(actor, task.id).participants;
    assert.ok(first?.execution && second?.execution);
    f.herdr.finish(first.execution.paneId, "first answer");
    await f.service.tick();
    f.herdr.delivery = { status: "unconfirmed", verified: false, acked: true, attempts: 1 };
    f.herdr.finish(second.execution.paneId, "second answer");
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).status, "attention");
    const [id, delivery] =
      f.store
        .entries<InputDelivery>("input_deliveries")
        .find(([, entry]) => entry.participantId === first.id && !entry.initial) ?? [];
    assert.ok(id && delivery);
    await f.service.interrupt({ ...actor, messageId: "stop" }, task.id, "all");
    (f.herdr as HerdrPort).initialInput = async (_ref, receipt) =>
      receipt === delivery.receipt ? delivery.prompt : undefined;
    f.herdr.delivery = { status: "delivered", verified: true, acked: true, attempts: 1 };
    f.herdr.finish(first.execution.paneId, "late answer after stop");
    await new TaskService(f.options).tick();
    assert.equal(f.store.get<OperationReceipt>("operations", id)?.state, "done");
    assert.equal(f.service.get(actor, task.id).discussion.paused, true);
    assert.equal(f.herdr.sends.length, 3);
  } finally {
    f.close();
  }
});
