import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptEntry } from "../../src/core/types.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

test("automatic handoff waits for a native turn to settle and uses its latest final record", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const [first, second] = f.service.get(actor, task.id).participants;
    assert.ok(first?.execution && second?.execution);
    f.herdr.finish(first.execution.paneId, "interim prose before more tools");
    const native = f.herdr.agents.get(first.execution.paneId);
    assert.ok(native);
    native.status = "working";
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 1);
    assert.equal(f.store.list("pending_relays").length, 1);
    assert.equal(f.store.list("task_settled_outputs").length, 0);
    f.herdr.finish(first.execution.paneId, "actual final answer");
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 2);
    assert.equal(f.herdr.sends[1]?.pane, second.execution.paneId);
    assert.ok(f.herdr.sends[1]?.text.includes("actual final answer"));
    assert.ok(!f.herdr.sends[1]?.text.includes("interim prose"));
    const outputs = f.store.list<{ entry: TranscriptEntry }>("task_settled_outputs");
    assert.deepEqual(
      outputs.map((entry) => entry.entry.text),
      ["actual final answer"],
    );
  } finally {
    f.close();
  }
});

test("multiple final records in one native transcript page cause only the latest handoff", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const first = f.service.get(actor, task.id).participants[0];
    assert.ok(first?.execution);
    f.herdr.finish(first.execution.paneId, "old final candidate");
    f.herdr.finish(first.execution.paneId, "latest final candidate");
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 2);
    assert.ok(f.herdr.sends[1]?.text.includes("latest final candidate"));
    assert.ok(!f.herdr.sends[1]?.text.includes("old final candidate"));
  } finally {
    f.close();
  }
});

for (const state of ["blocked", "working", "launching"] as const) {
  test(`pending handoff survives restart while next participant is ${state}, then resumes once ready`, async () => {
    const f = setup();
    try {
      const task = await f.service.create(actor, discussion);
      await f.service.tick();
      const [first, second] = f.service.get(actor, task.id).participants;
      assert.ok(first?.execution && second?.execution);
      const next = f.herdr.agents.get(second.execution.paneId);
      assert.ok(next);
      next.status = state === "launching" ? "idle" : state;
      next.launchPending = state === "launching";
      f.herdr.finish(first.execution.paneId, "handoff survives temporary native wait");
      await f.service.tick();
      assert.equal(f.herdr.sends.length, 1);
      assert.equal(f.store.list("pending_relays").length, 1);
      assert.equal(f.service.get(actor, task.id).discussion.paused, false);
      const restored = new TaskService(f.options);
      await restored.tick();
      assert.equal(f.herdr.sends.length, 1);
      next.status = "idle";
      next.launchPending = false;
      await restored.tick();
      await restored.tick();
      assert.equal(f.herdr.sends.length, 2);
      assert.equal(f.store.list("pending_relays").length, 0);
    } finally {
      f.close();
    }
  });
}

test("explicit user pause retains the settled handoff until resume", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const first = f.service.get(actor, task.id).participants[0];
    assert.ok(first?.execution);
    await f.service.action({ ...actor, messageId: "pause" }, task.id, "pause");
    f.herdr.finish(first.execution.paneId, "paused result");
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 1);
    assert.equal(f.store.list("pending_relays").length, 1);
    await f.service.action({ ...actor, messageId: "resume" }, task.id, "resume");
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 2);
  } finally {
    f.close();
  }
});

test("model orchestration provisions all agents and leaves participant choice to the model", async () => {
  const f = setup();
  f.config.ai.enabled = true;
  try {
    const task = await f.service.create(actor, { ...discussion, orchestration: { mode: "model" } });
    await f.service.tick();
    assert.equal(f.herdr.starts, 2);
    assert.equal(f.herdr.sends.length, 0);
    const second = f.service.get(actor, task.id).participants[1];
    assert.ok(second?.execution);
    const system = { ...actor, source: "system" as const, messageId: "model-choice" };
    await f.service.send(system, task.id, second.id, "ask second participant first");
    assert.equal(f.service.get(actor, task.id).discussion.paused, false);
    f.herdr.finish(second.execution.paneId, "ready for model to choose next action");
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 1);
    assert.equal(f.store.list("task_settled_outputs").length, 1);
    assert.equal(f.service.get(actor, task.id).status, "review");
    await f.service.send(system, task.id, second.id, "ask second participant first");
    assert.equal(f.herdr.sends.length, 1);
    assert.equal(f.service.get(actor, task.id).status, "review");
    assert.equal(f.store.get("participant_awaiting_output", second.id), undefined);
    await f.service.send(
      { ...actor, messageId: "user-followup" },
      task.id,
      second.id,
      "revise this",
    );
    assert.equal(f.service.get(actor, task.id).discussion.paused, false);
    await f.service.action({ ...actor, messageId: "model-pause" }, task.id, "pause");
    await assert.rejects(
      f.service.send({ ...system, messageId: "paused-send" }, task.id, second.id, "cannot send"),
      { code: "task_not_running" },
    );
    assert.equal(f.herdr.sends.length, 2);
  } finally {
    f.close();
  }
});

test("native idle without a final reply does not turn an acknowledged input into review", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const first = f.service.get(actor, task.id).participants[0];
    assert.ok(first?.execution);
    const native = f.herdr.agents.get(first.execution.paneId);
    assert.ok(native);
    native.status = "idle";
    f.herdr.outputs.set(first.execution.paneId, [
      {
        id: "commentary",
        role: "assistant",
        text: "still planning",
        final: false,
      },
    ]);
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).status, "running");
    assert.equal(f.store.list("task_settled_outputs").length, 0);
    assert.equal(f.herdr.sends.length, 1);
    const idle = f.store.get<{ operationId: string }>("participant_idle_wait", first.id);
    assert.ok(idle);
    f.store.set("participant_idle_wait", first.id, {
      ...idle,
      since: new Date(Date.now() - 61_000).toISOString(),
    });
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).status, "attention");
    assert.match(f.service.get(actor, task.id).error ?? "", /60 秒/);
    assert.equal(f.herdr.sends.length, 1);
    f.herdr.finish(first.execution.paneId, "delayed final arrived");
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 2);
    assert.equal(f.service.get(actor, task.id).error, undefined);
  } finally {
    f.close();
  }
});

test("a local model worker can access only its exact owner, task and entry chat", async () => {
  const f = setup();
  f.config.ai.enabled = true;
  try {
    const task = await f.service.create(actor, {
      ...discussion,
      orchestration: { mode: "model" },
      createGroup: false,
    });
    await f.service.tick();
    const system = {
      ...actor,
      source: "system" as const,
      taskId: task.id,
      chatId: task.entryChatId,
    };
    assert.equal(f.service.get(system, task.id).id, task.id);
    assert.throws(() => f.service.get({ ...system, ownerId: "other" }, task.id));
    assert.throws(() => f.service.get({ ...system, taskId: "other" }, task.id));
    assert.throws(() => f.service.get({ ...system, chatId: "other" }, task.id));
    assert.throws(() => f.service.get({ ...system, source: "feishu" }, task.id));
    const first = f.service.get(system, task.id).participants[0];
    assert.ok(first);
    await f.service.send(system, task.id, first.id, "local model dispatch");
    assert.equal(f.herdr.sends.length, 1);
  } finally {
    f.close();
  }
});

test("a model dispatch rechecks its event after waiting for the task mutation lock", async () => {
  const f = setup();
  f.config.ai.enabled = true;
  try {
    const task = await f.service.create(actor, { ...discussion, orchestration: { mode: "model" } });
    await f.service.tick();
    const [first, second] = f.service.get(actor, task.id).participants;
    assert.ok(first && second);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const send = f.herdr.send.bind(f.herdr);
    f.herdr.send = async (ref, text) => {
      started();
      await blocked;
      return send(ref, text);
    };
    const inFlight = f.service.send({ ...actor, messageId: "first" }, task.id, first.id, "work");
    await entered;
    let superseded = false;
    const queued = f.service.send(
      { ...actor, messageId: "second" },
      task.id,
      second.id,
      "old plan",
      () => {
        if (superseded) throw new Error("event superseded");
      },
    );
    superseded = true;
    release();
    await inFlight;
    await assert.rejects(queued, /event superseded/);
    assert.equal(f.herdr.sends.length, 1);
  } finally {
    f.close();
  }
});
