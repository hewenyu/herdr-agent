import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

test("new tasks distinguish explicit retention from the configured default", async () => {
  const h = setup();
  try {
    h.config.runtime.groupRetention = "retain";
    const inherited = await h.service.create(actor, discussion);
    const explicit = await h.service.create(
      { ...actor, messageId: "explicit" },
      { ...discussion, keepGroup: true },
    );
    assert.equal(inherited.groupRetentionSource, "default");
    assert.equal(explicit.groupRetentionSource, "explicit");
    assert.equal(inherited.keepGroup, true);
    assert.equal(explicit.keepGroup, true);
  } finally {
    h.close();
  }
});

test("legacy active retention stays unchanged until explicit complete, close or destroy adopts the new default", async () => {
  for (const action of ["complete", "close", "destroy"] as const) {
    const h = setup();
    try {
      const task = await h.service.create(actor, { ...discussion, keepGroup: true });
      await h.service.tick();
      const legacy = h.service.get(actor, task.id);
      delete legacy.groupRetentionSource;
      h.service.records.save(legacy);
      const restored = new TaskService(h.options);
      await restored.tick();
      assert.equal(restored.get(actor, task.id).keepGroup, true);
      assert.equal(restored.get(actor, task.id).groupRetentionSource, undefined);
      assert.equal(h.herdr.closes, 0);
      await restored.action({ ...actor, messageId: action }, task.id, action);
      await restored.tick();
      assert.equal(restored.get(actor, task.id).status, "destroyed");
      assert.equal(restored.get(actor, task.id).keepGroup, false);
      assert.equal(restored.get(actor, task.id).groupRetentionSource, "default");
      assert.equal(h.herdr.closes, 2);
      assert.equal(h.platform.deletions, 1);
    } finally {
      h.close();
    }
  }
});

test("external completion also removes legacy default retention while explicit retention remains", async () => {
  for (const explicit of [false, true]) {
    const h = setup();
    try {
      const task = await h.service.create(actor, { ...discussion, keepGroup: true });
      await h.service.tick();
      const legacy = h.service.get(actor, task.id);
      if (!explicit) delete legacy.groupRetentionSource;
      h.service.records.save(legacy);
      const remote = h.platform.tasks.get(legacy.remoteTaskId ?? "");
      assert.ok(remote);
      remote.completedAt = "external-user-completion";
      await h.service.tick();
      await h.service.tick();
      assert.equal(h.service.get(actor, task.id).status, "destroyed");
      assert.equal(h.herdr.closes, 2);
      assert.equal(h.platform.deletions, explicit ? 0 : 1);
    } finally {
      h.close();
    }
  }
});

test("legacy completed tasks preserve durable explicit group and execution choices without rewriting their evidence", async () => {
  for (const choice of ["none", "group", "execution"] as const) {
    const h = setup();
    try {
      const task = await h.service.create(actor, { ...discussion, keepGroup: true });
      await h.service.tick();
      const legacy = h.service.get(actor, task.id);
      delete legacy.groupRetentionSource;
      legacy.status = "completed";
      legacy.completedAt = "already-completed";
      legacy.closeRequested = false;
      h.service.records.save(legacy);
      const receipt = {
        action: "complete",
        keepGroup: true,
        ...(choice === "execution" ? { keepExecution: true } : {}),
        at: "2026-09-01T00:00:00.000Z",
      };
      if (choice !== "none") h.store.set("task_actions", `${task.id}:historical`, receipt);
      await new TaskService(h.options).tick();
      const current = h.service.get(actor, task.id);
      assert.equal(current.status, choice === "execution" ? "completed" : "destroyed");
      assert.equal(current.keepGroup, choice !== "none");
      assert.equal(h.herdr.closes, choice === "execution" ? 0 : 2);
      assert.equal(h.platform.deletions, choice === "none" ? 1 : 0);
      if (choice !== "none")
        assert.deepEqual(h.store.get("task_actions", `${task.id}:historical`), receipt);
    } finally {
      h.close();
    }
  }
});

test("a current explicit retention choice overrides unknown legacy defaults", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    const legacy = h.service.get(actor, task.id);
    delete legacy.groupRetentionSource;
    h.service.records.save(legacy);
    await h.service.action({ ...actor, messageId: "retain" }, task.id, "complete", {
      keepGroup: true,
      keepExecution: true,
    });
    await h.service.tick();
    assert.equal(h.service.get(actor, task.id).status, "completed");
    assert.equal(h.service.get(actor, task.id).groupRetentionSource, "explicit");
    assert.equal(h.herdr.closes, 0);
    assert.equal(h.platform.deletions, 0);
  } finally {
    h.close();
  }
});
