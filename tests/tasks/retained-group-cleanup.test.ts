import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import type { TaskAction } from "../../src/tasks/lifecycle.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

async function retainGroup(h: ReturnType<typeof setup>, accepted = true) {
  const task = await h.service.create(actor, { ...discussion, keepGroup: true });
  await h.service.reconcile(task.id);
  await h.service.action(
    { ...actor, messageId: "finish-retain" },
    task.id,
    accepted ? "complete" : "destroy",
    { keepGroup: true },
  );
  await h.service.reconcile(task.id);
  const retained = h.service.get(actor, task.id);
  assert.equal(retained.status, "destroyed");
  assert.equal(retained.groupDeleted, false);
  assert.equal(h.herdr.closes, 2);
  return retained;
}

for (const action of ["close", "destroy"] as const) {
  test(`explicit ${action} removes a retained group after restart without reopening execution`, async () => {
    const h = setup();
    try {
      const retained = await retainGroup(h);
      const completedAt = retained.completedAt;
      const completionWrites = h.platform.updateCalls.filter((call) => call.completedAt).length;
      const receipts = h.store.entries("operations").filter(([id]) => id.endsWith(":close"));
      const completion = h.store.get("completion_sync", retained.id);
      h.service.stop();
      const restored = new TaskService(h.options);
      const cleanupActor = { ...actor, messageId: "remove-retained-group" };
      await restored.action(cleanupActor, retained.id, action, { keepGroup: false });
      assert.equal(h.platform.deletions, 0, "deletion waits for reconciliation");
      await restored.reconcile(retained.id);
      await restored.action(cleanupActor, retained.id, action, { keepGroup: false });
      await restored.reconcile(retained.id);
      const cleaned = restored.get(actor, retained.id);
      assert.equal(cleaned.status, "destroyed");
      assert.equal(cleaned.groupDeleted, true);
      assert.equal(cleaned.completedAt, completedAt);
      assert.equal(h.platform.deletions, 1);
      assert.equal(h.herdr.closes, 2);
      assert.equal(h.herdr.starts, 2);
      assert.equal(h.herdr.agents.size, 0);
      assert.equal(
        h.platform.updateCalls.filter((call) => call.completedAt).length,
        completionWrites,
      );
      assert.deepEqual(h.store.get("completion_sync", retained.id), completion);
      assert.deepEqual(
        h.store.entries("operations").filter(([id]) => id.endsWith(":close")),
        receipts,
      );
    } finally {
      h.close();
    }
  });
}

test("retained group cleanup preserves an unaccepted task and rejects implicit or invalid reuse", async () => {
  const h = setup();
  try {
    const retained = await retainGroup(h, false);
    for (const action of [
      "complete",
      "close",
      "reopen",
      "retry",
      "pause",
      "resume",
    ] as TaskAction[]) {
      await assert.rejects(
        h.service.action({ ...actor, messageId: `invalid-${action}` }, retained.id, action, {
          keepGroup: false,
        }),
        { code: "task_destroyed" },
      );
    }
    await assert.rejects(h.service.action(actor, retained.id, "destroy"), {
      code: "task_destroyed",
    });
    await assert.rejects(
      h.service.action(actor, retained.id, "destroy", { keepGroup: "false" as unknown as boolean }),
      { code: "task_destroyed" },
    );
    await assert.rejects(
      h.service.action({ ...actor, ownerId: "other" }, retained.id, "destroy", {
        keepGroup: false,
      }),
      { code: "task_missing" },
    );
    assert.deepEqual(h.service.get(actor, retained.id), retained);
    await h.service.action({ ...actor, messageId: "cleanup" }, retained.id, "destroy", {
      keepGroup: false,
    });
    await h.service.reconcile(retained.id);
    assert.equal(h.service.get(actor, retained.id).completedAt, undefined);
    assert.equal(h.platform.tasks.get(retained.remoteTaskId as string)?.completedAt, "0");
    assert.equal(h.platform.deletions, 1);
    assert.equal(h.herdr.starts, 2);
    assert.equal(h.herdr.closes, 2);
  } finally {
    h.close();
  }
});

test("retained group cleanup waits for pending deliveries and keeps an unknown deletion frozen after restart", async () => {
  let ready = true;
  const h = setup({ canDeleteGroup: () => ready });
  try {
    const retained = await retainGroup(h);
    ready = false;
    const cleanupActor = { ...actor, messageId: "cleanup" };
    await h.service.action(cleanupActor, retained.id, "destroy", { keepGroup: false });
    await h.service.reconcile(retained.id);
    assert.equal(h.platform.deletions, 0);
    assert.equal(h.service.get(actor, retained.id).status, "destroying");
    ready = true;
    let dissolved = false;
    Object.assign(h.platform, { getGroupStatus: async () => (dissolved ? "dissolved" : "normal") });
    h.platform.deleteGroup = async () => {
      h.platform.deletions++;
      throw new OperationError("lost_ack", "删除结果未知", "unknown");
    };
    await h.service.reconcile(retained.id);
    const operationId = `${retained.id}:delete-group`;
    assert.equal(h.store.get<OperationReceipt>("operations", operationId)?.state, "uncertain");
    h.service.stop();
    const restored = new TaskService(h.options);
    await restored.action(cleanupActor, retained.id, "destroy", { keepGroup: false });
    await restored.reconcile(retained.id);
    assert.equal(h.platform.deletions, 1);
    assert.equal(restored.get(actor, retained.id).groupDeleted, false);
    dissolved = true;
    await restored.reconcile(retained.id);
    assert.equal(restored.get(actor, retained.id).status, "destroyed");
    assert.equal(restored.get(actor, retained.id).groupDeleted, true);
    assert.equal(h.store.get<OperationReceipt>("operations", operationId)?.state, "done");
    assert.equal(h.platform.deletions, 1);
    assert.equal(h.herdr.closes, 2);
  } finally {
    h.close();
  }
});

test("destroyed retained groups read external dissolution with polling throttle and no executor effect", async () => {
  const h = setup();
  try {
    const retained = await retainGroup(h);
    h.config.tasks.pollIntervalMs = 60_000;
    let reads = 0;
    let status: "normal" | "dissolved" = "normal";
    Object.assign(h.platform, {
      getGroupStatus: async () => {
        reads++;
        return status;
      },
    });
    await h.service.reconcile(retained.id, { forceRemote: false });
    assert.equal(reads, 1);
    assert.equal(h.service.get(actor, retained.id).groupDeleted, false);
    await h.service.reconcile(retained.id, { forceRemote: false });
    assert.equal(reads, 1, "background polling respects the per-task interval");
    status = "dissolved";
    await h.service.reconcile(retained.id);
    const closed = h.service.get(actor, retained.id);
    assert.equal(reads, 2, "a group event/manual reconciliation may force a fresh read");
    assert.equal(closed.status, "destroyed");
    assert.equal(closed.groupDeleted, true);
    assert.equal(h.herdr.closes, 2);
    assert.equal(h.platform.deletions, 0);
    assert.equal(h.herdr.starts, 2);
    await h.service.reconcile(retained.id, { forceRemote: true });
    assert.equal(reads, 2, "already deleted groups are not polled again");
    assert.equal(h.herdr.closes, 2);
  } finally {
    h.close();
  }
});

test("periodic polling observes a dissolved retained group and refreshes the terminal task projection", async () => {
  const h = setup();
  try {
    const retained = await retainGroup(h);
    const remote = h.platform.tasks.get(retained.remoteTaskId as string);
    assert.ok(remote);
    assert.match(remote.description, /applink\.feishu\.cn\/client\/chat/);
    // The first terminal projection was already read; this zero interval lets
    // the same periodic pass refresh its newly queued post-dissolution text.
    h.config.tasks.pollIntervalMs = 0;
    let reads = 0;
    Object.assign(h.platform, {
      getGroupStatus: async () => {
        reads++;
        return "dissolved";
      },
    });
    const updates = h.platform.updates;
    await h.service.tick();
    const closed = h.service.get(actor, retained.id);
    assert.equal(reads, 1, "destroyed retained groups remain scheduled for group polling");
    assert.equal(closed.status, "destroyed");
    assert.equal(closed.groupDeleted, true);
    assert.equal(h.herdr.closes, 2);
    assert.equal(h.platform.deletions, 0);
    assert.equal(h.platform.updates, updates + 1);
    assert.doesNotMatch(remote.description, /applink\.feishu\.cn\/client\/chat/);
    assert.equal(
      h.store.get<{ state: string }>("final_description_sync", retained.id)?.state,
      "done",
    );
    await h.service.tick();
    assert.equal(
      reads,
      1,
      "group and final description reads remain throttled after reconciliation",
    );
    assert.equal(h.platform.updates, updates + 1);
  } finally {
    h.close();
  }
});

test("external dissolution preserves an observed completion proof while rebuilding the terminal projection", async () => {
  const h = setup();
  try {
    const retained = await retainGroup(h);
    h.store.set("final_description_sync", retained.id, {
      text: "已确认的旧终态描述",
      state: "done",
      completionObserved: true,
    });
    h.config.tasks.pollIntervalMs = 0;
    Object.assign(h.platform, { getGroupStatus: async () => "dissolved" as const });
    const updates = h.platform.updates;

    await h.service.tick();

    const projection = h.store.get<{
      state: string;
      completionObserved?: boolean;
    }>("final_description_sync", retained.id);
    assert.equal(projection?.state, "done");
    assert.equal(projection?.completionObserved, true);
    assert.equal(h.platform.updates, updates + 1);
  } finally {
    h.close();
  }
});

test("destroyed retained group clears a recovered group read error without hiding a pending final projection", async () => {
  const h = setup();
  try {
    const retained = await retainGroup(h);
    h.config.tasks.pollIntervalMs = 0;
    let offline = true;
    Object.assign(h.platform, {
      getGroupStatus: async () => {
        if (offline) throw new OperationError("offline", "群状态暂时不可用");
        return "normal";
      },
    });
    await h.service.reconcile(retained.id, { forceRemote: true });
    assert.match(h.service.get(actor, retained.id).syncError ?? "", /群状态暂时不可用/);
    offline = false;
    await h.service.reconcile(retained.id, { forceRemote: true });
    assert.equal(h.service.get(actor, retained.id).syncError, undefined);

    h.store.set("final_description_sync", retained.id, {
      text: "需要再次核对的最终描述",
      state: "pending",
    });
    offline = true;
    await h.service.reconcile(retained.id, { forceRemote: true });
    assert.match(h.service.get(actor, retained.id).syncError ?? "", /群状态暂时不可用/);
    offline = false;
    h.platform.getTask = async () => {
      throw new OperationError("offline", "最终描述暂时不可用");
    };
    await h.service.reconcile(retained.id, { forceRemote: true });
    assert.match(h.service.get(actor, retained.id).syncError ?? "", /最终描述暂时不可用/);
    assert.equal(
      h.store.get<{ state: string }>("final_description_sync", retained.id)?.state,
      "pending",
    );
    assert.equal(h.herdr.closes, 2);
    assert.equal(h.platform.deletions, 0);
  } finally {
    h.close();
  }
});

test("destroyed tasks without a group do not create group read or cleanup effects", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, {
      ...discussion,
      createGroup: false,
      createRemoteTask: false,
      keepGroup: true,
    });
    await h.service.reconcile(task.id);
    await h.service.action({ ...actor, messageId: "complete-local" }, task.id, "complete", {
      keepGroup: true,
    });
    await h.service.reconcile(task.id);
    const destroyed = h.service.get(actor, task.id);
    assert.equal(destroyed.status, "destroyed");
    assert.equal(destroyed.chatId, undefined);
    let reads = 0;
    Object.assign(h.platform, {
      getGroupStatus: async () => {
        reads++;
        return "dissolved";
      },
    });
    await h.service.reconcile(task.id, { forceRemote: true });
    assert.equal(reads, 0);
    assert.equal(h.platform.deletions, 0);
    assert.equal(h.herdr.closes, 2);
  } finally {
    h.close();
  }
});
