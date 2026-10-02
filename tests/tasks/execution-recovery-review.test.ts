import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import type { InputDelivery } from "../../src/tasks/input-delivery.js";
import { assertDefined } from "../helpers/assertions.js";
import { actor, createPersistedTask, discussion, setup } from "./helpers.js";

test("late input proof for a surviving peer cannot undo the execution repair scheduling pause", async () => {
  const f = setup();
  try {
    const task = await createPersistedTask(f, actor, discussion, {
      orchestration: { mode: "model" },
    });
    await f.service.tick();
    const [missing, survivor] = f.service.get(actor, task.id).participants;
    assert.ok(missing?.execution && survivor?.execution);
    f.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    await assert.rejects(
      f.service.send({ ...actor, source: "system" }, task.id, survivor.id, "Existing peer work"),
    );
    const oldInput = assertDefined(
      f.store.list<InputDelivery>("input_deliveries")[0],
      "the send recorded an input delivery",
    );
    assert.equal(oldInput.discussionWasPaused, false);
    f.herdr.agents.delete(missing.execution.paneId);
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).participants[0]?.recoveryPending, true);
    assert.equal(f.service.get(actor, task.id).discussion.paused, true);
    Object.assign(f.herdr, {
      initialInput: async (ref: { paneId: string }) => {
        const survivorPane = assertDefined(
          survivor.execution,
          "the surviving participant has an execution",
        ).paneId;
        return ref.paneId === survivorPane ? oldInput.prompt : undefined;
      },
    });
    await f.service.tick();
    const latest = f.service.get(actor, task.id);
    assert.equal(latest.participants[0]?.recoveryPending, true);
    assert.equal(latest.discussion.paused, true);
    assert.equal(f.herdr.sends.length, 1);
  } finally {
    f.close();
  }
});

test("exact fresh-generation proof is not blocked by identical unknown historical text", async () => {
  const f = setup();
  try {
    const task = await createPersistedTask(
      f,
      actor,
      { ...discussion, participants: [{ kind: "codex", name: "Codex" }] },
      { orchestration: { mode: "model" } },
    );
    await f.service.tick();
    const before = assertDefined(
      f.service.get(actor, task.id).participants[0],
      "the task has a first participant",
    );
    f.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    const text = "Read the existing document and propose next steps";
    await assert.rejects(
      f.service.send({ ...actor, messageId: "old-request" }, task.id, before.id, text),
    );
    const oldInput = assertDefined(
      f.store.list<InputDelivery>("input_deliveries")[0],
      "the send recorded an input delivery",
    );
    const oldReceipt = f.store.get<OperationReceipt>("operations", oldInput.operationId);
    f.herdr.agents.delete(
      assertDefined(before.execution, "the participant has an execution").paneId,
    );
    await f.service.tick();
    await assert.rejects(
      f.service.send({ ...actor, messageId: "fresh-request" }, task.id, before.id, text),
    );
    const fresh = assertDefined(
      f.store
        .list<InputDelivery>("input_deliveries")
        .find((entry) => entry.generation !== undefined),
      "a fresh-generation input delivery is recorded",
    );
    assert.notEqual(fresh.receipt, oldInput.receipt);
    Object.assign(f.herdr, {
      initialInput: async (_ref: unknown, receipt: string) =>
        receipt === fresh.receipt ? fresh.prompt : undefined,
    });
    await f.service.tick();
    const resolved = f.store.get<OperationReceipt>("operations", fresh.operationId);
    assert.equal(resolved?.resolution?.decidedBy, "evidence");
    assert.equal(f.service.get(actor, task.id).participants[0]?.recoveryPending, false);
    assert.deepEqual(f.store.get("operations", oldInput.operationId), oldReceipt);
    assert.equal(f.service.get(actor, task.id).discussion.paused, false);
    assert.equal(f.herdr.sends.length, 2);
  } finally {
    f.close();
  }
});

test("arranging one repaired participant does not release peers still awaiting fresh input", async () => {
  const f = setup();
  try {
    const task = await createPersistedTask(f, actor, discussion, {
      orchestration: { mode: "model" },
    });
    await f.service.tick();
    const before = f.service.get(actor, task.id).participants;
    for (const participant of before) {
      f.herdr.agents.delete(
        assertDefined(participant.execution, "every participant has an execution").paneId,
      );
    }
    await f.service.tick();
    assert.ok(f.service.get(actor, task.id).participants.every((p) => p.recoveryPending));
    await f.service.send(
      { ...actor, messageId: "fresh-first" },
      task.id,
      assertDefined(before[0], "the first participant exists").id,
      "New work",
    );
    const current = f.service.get(actor, task.id);
    assert.equal(current.participants[0]?.recoveryPending, false);
    assert.equal(current.participants[1]?.recoveryPending, true);
    assert.equal(current.discussion.paused, true);
    assert.equal(f.herdr.sends.length, 1);
  } finally {
    f.close();
  }
});

for (const explicitPause of [false, true])
  test(`native proof of a fresh repair arrangement releases only automatic pause (${explicitPause})`, async () => {
    const f = setup();
    try {
      const task = await createPersistedTask(
        f,
        actor,
        { ...discussion, participants: [{ kind: "codex", name: "Codex" }] },
        { orchestration: { mode: "model" } },
      );
      await f.service.tick();
      const before = assertDefined(
        f.service.get(actor, task.id).participants[0],
        "the task has a first participant",
      );
      f.herdr.agents.delete(
        assertDefined(before.execution, "the participant has an execution").paneId,
      );
      await f.service.tick();
      f.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
      await assert.rejects(
        f.service.send({ ...actor, messageId: "fresh-input" }, task.id, before.id, "New work"),
      );
      const fresh = assertDefined(
        f.store.list<InputDelivery>("input_deliveries")[0],
        "the send recorded a fresh input delivery",
      );
      assert.ok(fresh.generation);
      if (explicitPause)
        await f.service.action({ ...actor, messageId: "pause-again" }, task.id, "pause");
      Object.assign(f.herdr, { initialInput: async () => fresh.prompt });
      await f.service.tick();
      const current = f.service.get(actor, task.id);
      assert.equal(current.participants[0]?.recoveryPending, false);
      assert.equal(current.discussion.paused, explicitPause);
      assert.equal(f.herdr.sends.length, 1);
    } finally {
      f.close();
    }
  });

test("a salvaged old final cannot settle the replacement's fresh arrangement", async () => {
  const f = setup();
  try {
    const task = await createPersistedTask(
      f,
      actor,
      { ...discussion, participants: [{ kind: "codex", name: "Codex" }] },
      { orchestration: { mode: "model" } },
    );
    await f.service.tick();
    const before = f.service.get(actor, task.id).participants[0];
    assert.ok(before?.execution);
    await f.service.send({ ...actor, messageId: "old-turn" }, task.id, before.id, "Old work");
    f.herdr.finish(before.execution.paneId, "OLD GENERATION FINAL");
    f.herdr.agents.delete(before.execution.paneId);
    const start = f.herdr.startAgent.bind(f.herdr);
    f.herdr.startAgent = async (...args) => {
      const agent = await start(...args);
      const blocked = { ...agent, status: "blocked" as const };
      f.herdr.agents.set(agent.paneId, blocked);
      return blocked;
    };
    await f.service.tick();
    const rebuilt = f.service.get(actor, task.id).participants[0];
    assert.ok(rebuilt?.execution);
    const native = f.herdr.agents.get(rebuilt.execution.paneId);
    assert.ok(native);
    f.herdr.agents.set(native.paneId, { ...native, status: "idle" });
    await f.service.send({ ...actor, messageId: "fresh-turn" }, task.id, rebuilt.id, "New work");
    const awaiting = f.store.get("participant_awaiting_output", rebuilt.id);
    assert.ok(awaiting);
    f.herdr.agents.set(native.paneId, { ...native, status: "idle" });
    await f.service.tick();
    assert.deepEqual(f.store.get("participant_awaiting_output", rebuilt.id), awaiting);
    assert.equal(f.service.get(actor, task.id).status, "running");
    assert.equal(f.store.list("task_settled_outputs").length, 0);
    assert.equal(f.store.list("task_outputs").length, 1, "old final remains in history");
    assert.equal(f.herdr.sends.length, 2);
  } finally {
    f.close();
  }
});

// Independent reviewer regressions: starting a replacement is not evidence of task delivery.
// These cases intentionally exercise old-format receipt compatibility as well as fresh state.
test("replacement projection does not claim historical initial delivery reached the new executor", async () => {
  const f = setup();
  try {
    const task = await createPersistedTask(
      f,
      actor,
      { ...discussion, participants: [{ kind: "codex", name: "Codex" }] },
      { discussionMode: "manual" },
    );
    await f.service.tick();
    const before = assertDefined(
      f.service.get(actor, task.id).participants[0],
      "the task has a first participant",
    );
    assert.equal(before.initialDelivery, "confirmed");
    f.herdr.agents.delete(
      assertDefined(before.execution, "the participant has an execution").paneId,
    );
    await f.service.tick();
    const after = assertDefined(
      f.service.get(actor, task.id).participants[0],
      "the task has a first participant",
    );
    assert.notEqual(after.execution?.paneId, before.execution?.paneId);
    assert.equal(after.recoveryPending, true);
    assert.equal(after.initialDelivery, "pending");
    assert.equal(f.herdr.sends.length, 1);
  } finally {
    f.close();
  }
});

test("legacy cached send receipt cannot mark a replacement as having received input", async () => {
  const f = setup();
  try {
    const task = await createPersistedTask(
      f,
      actor,
      { ...discussion, participants: [{ kind: "codex", name: "Codex" }] },
      { discussionMode: "manual" },
    );
    await f.service.tick();
    const before = assertDefined(
      f.service.get(actor, task.id).participants[0],
      "the task has a first participant",
    );
    const request = { ...actor, messageId: "legacy-arrangement" };
    await f.service.send(request, task.id, before.id, "Old arrangement");
    const oldDelivery = assertDefined(
      f.store
        .entries<{ prompt: string }>("input_deliveries")
        .find(([, entry]) => entry.prompt.includes("Old arrangement")),
      "the old arrangement delivery is recorded",
    );
    // Old releases can have a done receipt without the newer delivery/applied records.
    f.store.delete("input_deliveries", oldDelivery[0]);
    f.store.delete("task_input_applied", oldDelivery[0]);
    // Manual send pauses scheduling; explicitly resume before disappearance.
    await f.service.action({ ...actor, messageId: "resume" }, task.id, "resume");
    f.herdr.agents.delete(
      assertDefined(before.execution, "the participant has an execution").paneId,
    );
    await f.service.tick();
    const rebuilt = assertDefined(
      f.service.get(actor, task.id).participants[0],
      "the task has a first participant",
    );
    assert.equal(rebuilt.recoveryPending, true);
    const count = f.herdr.sends.length;
    // Returning a historical result or refusing the old id are both safe; applying it anew is not.
    await f.service.send(request, task.id, before.id, "Old arrangement").catch(() => undefined);
    const after = assertDefined(
      f.service.get(actor, task.id).participants[0],
      "the task has a first participant",
    );
    assert.equal(f.herdr.sends.length, count);
    assert.equal(after.recoveryPending, true);
    assert.notEqual(after.status, "working");
  } finally {
    f.close();
  }
});

test("late old input proof cannot clear a durable repair barrier before workspace replacement", async () => {
  const f = setup();
  try {
    const task = await createPersistedTask(
      f,
      actor,
      { ...discussion, participants: [{ kind: "codex", name: "Codex" }] },
      { orchestration: { mode: "model" } },
    );
    await f.service.tick();
    const before = assertDefined(
      f.service.get(actor, task.id).participants[0],
      "the task has a first participant",
    );
    f.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    await assert.rejects(f.service.send(actor, task.id, before.id, "Old uncertain input"));
    const oldInput = assertDefined(
      f.store.list<{ prompt: string }>("input_deliveries")[0],
      "the uncertain send recorded an input delivery",
    );
    f.herdr.agents.delete(
      assertDefined(before.execution, "the participant has an execution").paneId,
    );
    f.herdr.createError = new OperationError("timeout", "Unknown workspace creation", "unknown");
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).participants[0]?.recoveryPending, true);
    await f.service.action({ ...actor, messageId: "pause" }, task.id, "pause");
    Object.assign(f.herdr, { initialInput: async () => oldInput.prompt });
    await f.service.tick();
    const latest = f.service.get(actor, task.id);
    assert.equal(latest.status, "paused");
    assert.equal(latest.discussion.paused, true);
    assert.equal(latest.participants[0]?.recoveryPending, true);
    assert.equal(f.herdr.sends.length, 1);
  } finally {
    f.close();
  }
});

test("unsolicited native output before a fresh arrangement is not settled as recovered task work", async () => {
  const f = setup();
  try {
    const task = await createPersistedTask(
      f,
      actor,
      { ...discussion, participants: [{ kind: "codex", name: "Codex" }] },
      { discussionMode: "manual" },
    );
    await f.service.tick();
    const before = assertDefined(
      f.service.get(actor, task.id).participants[0],
      "the task has a first participant",
    );
    f.herdr.agents.delete(
      assertDefined(before.execution, "the participant has an execution").paneId,
    );
    await f.service.tick();
    const rebuilt = assertDefined(
      f.service.get(actor, task.id).participants[0],
      "the task has a first participant",
    );
    const originalResult = f.service.get(actor, task.id).result;
    f.herdr.finish(
      assertDefined(rebuilt.execution, "the rebuilt participant has an execution").paneId,
      "Startup output, no new task input received.",
    );
    await f.service.tick();
    const current = f.service.get(actor, task.id);
    assert.equal(current.participants[0]?.recoveryPending, true);
    assert.equal(current.result, originalResult);
    assert.equal(f.store.list("task_settled_outputs").length, 0);
    assert.equal(f.herdr.sends.length, 1);
  } finally {
    f.close();
  }
});
