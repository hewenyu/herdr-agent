import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

test("completion projects completed immediately and cleaned resources in the final remote description", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    h.herdr.finish("p1", "最终讨论结论");
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete");
    const current = h.service.get(actor, task.id);
    const remote = h.platform.tasks.get(current.remoteTaskId ?? "");
    assert.ok(remote);
    assert.match(remote.description, /状态：completed/);
    const completedAt = remote.completedAt;
    await h.service.tick();
    assert.equal(h.service.get(actor, task.id).status, "destroyed");
    assert.match(remote.description, /状态：destroyed/);
    assert.match(remote.description, /Claude\(claude\): gone；Codex\(codex\): gone/);
    assert.match(remote.description, /最终讨论结论/);
    assert.doesNotMatch(remote.description, /会话：https/);
    assert.equal(remote.completedAt, completedAt);
    assert.equal(
      h.platform.updateCalls.filter((entry) => entry.completedAt !== undefined).length,
      1,
    );
    assert.equal(h.platform.updateCalls.at(-1)?.completedAt, undefined);
    assert.equal(h.herdr.closes, 2);
    assert.equal(h.platform.deletions, 1);
    const calls = h.platform.updates;
    h.platform.getTask = async () => {
      throw new Error("finished projections must not poll");
    };
    await h.service.tick();
    assert.equal(h.platform.updates, calls);
    assert.equal(h.service.get(actor, task.id).syncError, undefined);
  } finally {
    h.close();
  }
});

test("manual Feishu completion projects closed resources without writing the completion field", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-18T00:00:00Z") });
  for (const keepGroup of [false, true]) {
    const h = setup();
    try {
      const task = await h.service.create(actor, { ...discussion, keepGroup });
      await h.service.tick();
      const remote = h.platform.tasks.get(h.service.get(actor, task.id).remoteTaskId ?? "");
      assert.ok(remote);
      remote.completedAt = "1234";
      t.mock.timers.tick(h.config.tasks.pollIntervalMs);
      await h.service.tick();
      await h.service.tick();
      assert.equal(h.service.get(actor, task.id).status, "destroyed");
      assert.match(remote.description, /状态：destroyed/);
      assert.match(remote.description, /Claude\(claude\): gone/);
      assert.equal(remote.description.includes("会话：https"), keepGroup);
      assert.equal(remote.completedAt, "1234");
      assert.equal(
        h.platform.updateCalls.some((entry) => entry.completedAt !== undefined),
        false,
      );
      assert.equal(h.platform.deletions, keepGroup ? 0 : 1);
    } finally {
      h.close();
    }
  }
});

test("final description GET and known-not-executed PATCH failures do not block cleanup and recover after restart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-18T00:00:00Z") });
  for (const stage of ["get", "patch"]) {
    const h = setup();
    try {
      const task = await h.service.create(actor, discussion);
      await h.service.tick();
      await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete");
      const failure = new OperationError("offline", "最终描述暂时不可用");
      if (stage === "get") h.platform.getError = failure;
      else h.platform.updateError = failure;
      await h.service.tick();
      const current = h.service.get(actor, task.id);
      assert.equal(current.status, "destroyed");
      assert.match(current.syncError ?? "", /最终描述暂时不可用/);
      assert.equal(h.herdr.closes, 2);
      assert.equal(h.platform.deletions, 1);
      const starts = h.herdr.starts;
      const sends = h.herdr.sends.length;
      h.platform.getError = undefined;
      h.platform.updateError = undefined;
      const restored = new TaskService(h.options);
      t.mock.timers.tick(h.config.tasks.pollIntervalMs);
      await restored.tick();
      assert.equal(restored.get(actor, task.id).syncError, undefined);
      assert.match(
        h.platform.tasks.get(current.remoteTaskId ?? "")?.description ?? "",
        /状态：destroyed/,
      );
      assert.deepEqual(
        [h.herdr.starts, h.herdr.sends.length, h.herdr.closes, h.platform.deletions],
        [starts, sends, 2, 1],
      );
      assert.equal(
        h.platform.updateCalls.filter((entry) => entry.completedAt !== undefined).length,
        1,
      );
    } finally {
      h.close();
    }
  }
});

test("unknown final description is never replayed and exact GET resolves it across restart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-18T00:00:00Z") });
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete");
    h.platform.updateError = new OperationError("lost", "最终描述未确认", "unknown");
    await h.service.tick();
    const writes = h.platform.updates;
    const submitted = h.platform.updateCalls.at(-1);
    assert.ok(submitted);
    assert.equal(submitted.completedAt, undefined);
    assert.equal(h.service.get(actor, task.id).status, "destroyed");
    h.platform.updateError = undefined;
    const restored = new TaskService(h.options);
    t.mock.timers.tick(h.config.tasks.pollIntervalMs);
    await restored.tick();
    await restored.tick();
    assert.equal(h.platform.updates, writes);
    assert.match(restored.get(actor, task.id).syncError ?? "", /只读核对/);
    const remote = h.platform.tasks.get(submitted.id);
    assert.ok(remote);
    remote.description = submitted.description;
    t.mock.timers.tick(h.config.tasks.pollIntervalMs);
    await restored.tick();
    assert.equal(restored.get(actor, task.id).syncError, undefined);
    assert.equal(h.platform.updates, writes);
    let reads = 0;
    h.platform.getTask = async () => {
      reads++;
      return { ...remote };
    };
    await new TaskService(h.options).tick();
    assert.equal(reads, 0);
    assert.deepEqual([h.herdr.closes, h.platform.deletions], [2, 1]);
  } finally {
    h.close();
  }
});

test("older unknown description survives resource destruction until its exact content is observed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-18T00:00:00Z") });
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    h.platform.updateError = new OperationError("lost", "描述未确认", "unknown");
    await h.service.tick();
    const previous = h.platform.updateCalls.at(-1);
    assert.ok(previous);
    h.platform.updateError = undefined;
    await h.service.action({ ...actor, messageId: "destroy" }, task.id, "destroy");
    const writes = h.platform.updates;
    await h.service.tick();
    assert.equal(h.service.get(actor, task.id).status, "destroyed");
    assert.equal(h.platform.updates, writes);
    const restored = new TaskService(h.options);
    await restored.tick();
    assert.equal(h.platform.updates, writes);
    const remote = h.platform.tasks.get(previous.id);
    assert.ok(remote);
    remote.description = previous.description;
    t.mock.timers.tick(h.config.tasks.pollIntervalMs);
    await restored.tick();
    assert.equal(h.platform.updates, writes + 1);
    assert.match(remote.description, /状态：destroyed/);
    assert.equal(remote.completedAt, "0");
    assert.equal(restored.get(actor, task.id).completedAt, undefined);
    assert.equal(h.platform.updateCalls.at(-1)?.completedAt, undefined);
  } finally {
    h.close();
  }
});

test("external group dissolution projects cleanup without accepting the task", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    const restored = new TaskService({
      ...h.options,
      platform: Object.assign(h.platform, {
        getGroupStatus: async () => "dissolved" as const,
      }),
    });
    await restored.tick();
    const current = restored.get(actor, task.id);
    const remote = h.platform.tasks.get(current.remoteTaskId ?? "");
    assert.ok(remote);
    assert.equal(current.status, "destroyed");
    assert.equal(current.completedAt, undefined);
    assert.equal(remote.completedAt, "0");
    assert.match(remote.description, /状态：destroyed/);
    assert.doesNotMatch(remote.description, /会话：https/);
    assert.equal(
      h.platform.updateCalls.some((entry) => entry.completedAt !== undefined),
      false,
    );
    assert.deepEqual([h.herdr.closes, h.platform.deletions], [2, 0]);
  } finally {
    h.close();
  }
});

test("historical destroyed tasks without a final projection intent remain untouched", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    const old = h.service.get(actor, task.id);
    old.status = "destroyed";
    h.service.records.save(old);
    let reads = 0;
    h.platform.getTask = async () => {
      reads++;
      throw new Error("historical task");
    };
    const writes = h.platform.updates;
    await new TaskService(h.options).tick();
    await h.service.reconcile(task.id);
    assert.equal(reads, 0);
    assert.equal(h.platform.updates, writes);
    assert.deepEqual([h.herdr.closes, h.platform.deletions], [0, 0]);
  } finally {
    h.close();
  }
});

test("abandoned unknown completion blocks a new terminal projection until exact readback, without accepting or replaying it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-18T00:00:00Z") });
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    h.platform.updateError = new OperationError("lost", "完成未确认", "unknown");
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete");
    const completion = h.store.get<{ id: string; completedAt: string; description: string }>(
      "completion_sync",
      task.id,
    );
    assert.ok(completion);
    h.platform.updateError = undefined;
    await h.service.action({ ...actor, messageId: "destroy" }, task.id, "destroy");
    const writes = h.platform.updates;
    await h.service.tick();
    assert.equal(h.service.get(actor, task.id).status, "destroyed");
    assert.equal(h.platform.updates, writes);
    const remote = h.platform.tasks.get(h.service.get(actor, task.id).remoteTaskId ?? "");
    assert.ok(remote);
    remote.completedAt = completion.completedAt;
    t.mock.timers.tick(h.config.tasks.pollIntervalMs);
    await new TaskService(h.options).tick();
    assert.equal(h.platform.updates, writes, "completion bit alone is insufficient");
    remote.description = completion.description;
    t.mock.timers.tick(h.config.tasks.pollIntervalMs);
    h.platform.updateError = new OperationError("lost", "最终描述未确认", "unknown");
    await h.service.tick();
    assert.equal(h.platform.updates, writes + 1);
    const terminal = h.platform.updateCalls.at(-1);
    assert.ok(terminal);
    assert.equal(terminal.completedAt, undefined);
    remote.description = terminal.description;
    t.mock.timers.tick(h.config.tasks.pollIntervalMs);
    h.platform.updateError = undefined;
    const restored = new TaskService(h.options);
    await restored.tick();
    assert.equal(h.platform.updates, writes + 1);
    assert.equal(restored.get(actor, task.id).syncError, undefined);
    assert.equal(restored.get(actor, task.id).completedAt, undefined);
    assert.equal(h.store.get<OperationReceipt>("operations", completion.id)?.state, "uncertain");
    assert.deepEqual([h.herdr.closes, h.platform.deletions], [2, 1]);
  } finally {
    h.close();
  }
});
