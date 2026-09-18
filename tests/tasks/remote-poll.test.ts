import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

const start = Date.parse("2026-09-18T00:00:00Z");

function countReads(h: ReturnType<typeof setup>) {
  const counts = new Map<string, number>();
  const get = h.platform.getTask.bind(h.platform);
  h.platform.getTask = async (id) => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
    return get(id);
  };
  return (id?: string) =>
    id ? (counts.get(id) ?? 0) : [...counts.values()].reduce((a, b) => a + b, 0);
}

test("one-second herdr ticks keep first execution immediate but poll each Feishu task at its own configured interval", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const h = setup();
  const reads = countReads(h);
  try {
    assert.equal(h.config.tasks.pollIntervalMs, 30_000);
    const first = await h.service.create(actor, discussion);
    await h.service.tick();
    const firstId = h.service.get(actor, first.id).remoteTaskId;
    assert.equal(reads(firstId), 1, "first poll is never skipped");
    assert.equal(h.herdr.starts, 2);
    assert.equal(h.herdr.sends.length, 1);
    t.mock.timers.tick(1_000);
    h.herdr.finish("p1", "herdr output remains prompt between remote polls");
    const second = await h.service.create({ ...actor, messageId: "second" }, discussion);
    await h.service.tick();
    const secondId = h.service.get(actor, second.id).remoteTaskId;
    assert.equal(reads(firstId), 1);
    assert.equal(reads(secondId), 1);
    assert.match(h.service.get(actor, first.id).result, /herdr output remains prompt/);
    assert.equal(h.herdr.starts, 4);
    for (let second = 2; second <= 29; second++) {
      t.mock.timers.tick(1_000);
      await h.service.tick();
    }
    assert.equal(reads(), 2);
    t.mock.timers.tick(1_000);
    await h.service.tick();
    assert.equal(reads(firstId), 2);
    assert.equal(reads(secondId), 1);
    t.mock.timers.tick(1_000);
    await h.service.tick();
    assert.equal(reads(secondId), 2);
    assert.equal(h.herdr.starts, 4);
  } finally {
    h.close();
  }
});

test("failed remote GET attempts remain throttled across restart while herdr observation and error visibility continue", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const h = setup();
  h.config.tasks.pollIntervalMs = 10_000;
  const reads = countReads(h);
  try {
    const task = await h.service.create(actor, discussion);
    h.platform.getError = new OperationError("offline", "remote read offline");
    await h.service.tick();
    assert.equal(reads(), 1);
    assert.match(h.service.get(actor, task.id).syncError ?? "", /remote read offline/);
    t.mock.timers.tick(1_000);
    h.herdr.finish("p1", "local progress during network outage");
    await h.service.tick();
    assert.match(h.service.get(actor, task.id).result, /local progress/);
    assert.match(h.service.get(actor, task.id).syncError ?? "", /remote read offline/);
    const restored = new TaskService(h.options);
    t.mock.timers.tick(8_999);
    await restored.tick();
    assert.equal(reads(), 1);
    h.platform.getError = undefined;
    t.mock.timers.tick(1);
    await restored.tick();
    assert.equal(reads(), 2);
    assert.equal(restored.get(actor, task.id).syncError, undefined);
    assert.equal(h.herdr.starts, 2);
  } finally {
    h.close();
  }
});

test("group status failures also respect the task interval without starving local observation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const h = setup();
  let groupReads = 0;
  let offline = true;
  Object.assign(h.platform, {
    getGroupStatus: async () => {
      groupReads++;
      if (offline) throw new OperationError("offline", "group read offline");
      return "normal";
    },
  });
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    assert.equal(h.herdr.starts, 2);
    t.mock.timers.tick(1_000);
    await h.service.tick();
    assert.equal(groupReads, 1);
    h.herdr.finish("p1", "local output despite group query outage");
    t.mock.timers.tick(1_000);
    await h.service.tick();
    assert.equal(groupReads, 1);
    assert.match(h.service.get(actor, task.id).result, /local output/);
    assert.match(h.service.get(actor, task.id).syncError ?? "", /group read offline/);
    offline = false;
    t.mock.timers.tick(29_000);
    await h.service.tick();
    assert.equal(groupReads, 2);
    assert.equal(h.service.get(actor, task.id).syncError, undefined);
  } finally {
    h.close();
  }
});

test("explicit complete and reopen synchronize immediately inside the ordinary polling cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const h = setup();
  const reads = countReads(h);
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    t.mock.timers.tick(1_000);
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete", {
      keepGroup: true,
      keepExecution: true,
    });
    assert.equal(h.service.get(actor, task.id).status, "completed");
    assert.equal(reads(), 3, "completion GET, PATCH and confirmation are immediate");
    await h.service.action({ ...actor, messageId: "reopen" }, task.id, "reopen");
    assert.equal(h.service.get(actor, task.id).status, "review");
    assert.equal(reads(), 5);
    await h.service.tick();
    assert.equal(reads(), 5, "ordinary tick does not repeat the explicit action's read");
    assert.equal(h.platform.updateCalls.filter((call) => call.completedAt !== undefined).length, 2);
  } finally {
    h.close();
  }
});

test("unknown completion reads retry on the interval without replaying its PATCH", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const h = setup();
  const reads = countReads(h);
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    t.mock.timers.tick(1_000);
    h.platform.updateError = new OperationError("lost", "completion outcome unknown", "unknown");
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete", {
      keepGroup: true,
      keepExecution: true,
    });
    assert.equal(reads(), 2);
    const writes = h.platform.updates;
    h.platform.updateError = undefined;
    t.mock.timers.tick(1_000);
    const restored = new TaskService(h.options);
    await restored.tick();
    assert.equal(reads(), 2);
    t.mock.timers.tick(29_000);
    await restored.tick();
    assert.equal(reads(), 3);
    assert.equal(h.platform.updates, writes);
    const remote = h.platform.tasks.get(restored.get(actor, task.id).remoteTaskId ?? "");
    const submitted = h.platform.updateCalls.at(-1);
    assert.ok(remote && submitted?.completedAt);
    remote.completedAt = submitted.completedAt;
    remote.description = submitted.description;
    t.mock.timers.tick(30_000);
    await restored.tick();
    assert.equal(reads(), 4, "completion read is not followed by a duplicate ordinary GET");
    assert.equal(restored.get(actor, task.id).status, "completed");
    assert.equal(h.platform.updates, writes);
  } finally {
    h.close();
  }
});

test("a task update event forces refresh inside cooldown and final cleanup projection is immediate", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const h = setup();
  const reads = countReads(h);
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    const remote = h.platform.tasks.get(h.service.get(actor, task.id).remoteTaskId ?? "");
    assert.ok(remote);
    remote.completedAt = "external-confirmation";
    t.mock.timers.tick(1_000);
    await h.service.tick();
    assert.equal(reads(), 1);
    assert.equal(h.service.get(actor, task.id).completedAt, undefined);
    // Application's durable task/group event handler calls this immediate entry point.
    await h.service.reconcile(task.id);
    assert.equal(reads(), 3, "completion and final projection finish in the same reconciliation");
    assert.equal(h.service.get(actor, task.id).completedAt, "external-confirmation");
    assert.equal(h.service.get(actor, task.id).status, "destroyed");
    await h.service.tick();
    assert.equal(reads(), 3, "new final projection is not delayed behind the ordinary cooldown");
    assert.match(remote.description, /状态：destroyed/);
    assert.equal(h.herdr.closes, 2);
    assert.equal(h.platform.deletions, 1);
  } finally {
    h.close();
  }
});

test("terminal projection failures retry on schedule across restart without delaying or repeating cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const h = setup();
  const reads = countReads(h);
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete");
    h.platform.getError = new OperationError("offline", "final projection offline");
    await h.service.tick();
    assert.equal(reads(), 4);
    assert.equal(h.service.get(actor, task.id).status, "destroyed");
    assert.equal(h.herdr.closes, 2);
    assert.equal(h.platform.deletions, 1);
    const restored = new TaskService(h.options);
    t.mock.timers.tick(29_999);
    await restored.tick();
    assert.equal(reads(), 4);
    assert.match(restored.get(actor, task.id).syncError ?? "", /final projection offline/);
    h.platform.getError = undefined;
    t.mock.timers.tick(1);
    await restored.tick();
    assert.equal(reads(), 5);
    assert.equal(restored.get(actor, task.id).syncError, undefined);
    assert.deepEqual([h.herdr.starts, h.herdr.closes, h.platform.deletions], [2, 2, 1]);
    t.mock.timers.tick(30_000);
    await restored.tick();
    assert.equal(reads(), 5, "finished final projection stops polling");
  } finally {
    h.close();
  }
});

test("a backwards wall clock does not freeze remote polling behind a future attempt timestamp", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const h = setup();
  const reads = countReads(h);
  try {
    await h.service.create(actor, discussion);
    await h.service.tick();
    t.mock.timers.setTime(start - 60_000);
    await h.service.tick();
    assert.equal(reads(), 2);
    await h.service.tick();
    assert.equal(reads(), 2);
  } finally {
    h.close();
  }
});
