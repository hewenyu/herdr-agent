import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { TaskHooks } from "../../src/tasks/context.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

test("review retains resources; explicit keepExecution retains execution after completion", async () => {
  const notices: string[] = [];
  const h = setup({
    notice: async (_task, kind) => {
      notices.push(kind);
    },
  });
  try {
    const task = await h.service.create(actor, { ...discussion, discussion: { mode: "manual" } });
    await h.service.tick();
    h.herdr.finish("p1", "已完成本轮讨论，请验收");
    await h.service.tick();
    assert.equal(h.service.get(actor, task.id).status, "review");
    assert.equal(h.platform.deletions, 0);
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete", {
      keepExecution: true,
      keepGroup: true,
    });
    assert.equal(h.platform.deletions, 0, "the action returns before the reconciliation barrier");
    await h.service.tick();
    const completed = h.service.get(actor, task.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.groupDeleted, false);
    assert.equal(h.platform.deletions, 0);
    assert.equal(h.herdr.closes, 0);
    assert.equal(h.herdr.agents.size, 2);
    assert.equal(notices.filter((kind) => kind === "before_group_delete").length, 0);
    await new TaskService(h.options).tick();
    assert.equal(h.platform.deletions, 0);
    assert.equal(h.herdr.closes, 0);
  } finally {
    h.close();
  }
});

test("creation and lifecycle retention choices survive restart; explicit false overrides retained groups", async () => {
  for (const [created, override, retained] of [
    [true, undefined, true],
    [false, true, true],
    [true, false, false],
  ] as const) {
    const h = setup();
    try {
      const task = await h.service.create(actor, { ...discussion, keepGroup: created });
      await h.service.tick();
      await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete", {
        keepGroup: override,
      });
      const restored = new TaskService(h.options);
      await restored.tick();
      assert.equal(restored.get(actor, task.id).keepGroup, retained);
      assert.equal(restored.get(actor, task.id).groupDeleted, !retained);
      assert.equal(h.platform.deletions, retained ? 0 : 1);
      assert.equal(h.herdr.closes, 2);
    } finally {
      h.close();
    }
  }
});

test("retention override validation and conflicting replay leave the original state intact", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    for (const [action, keepGroup] of [
      ["pause", true],
      ["complete", "false"],
    ] as const) {
      await assert.rejects(
        h.service.action(actor, task.id, action, { keepGroup: keepGroup as boolean }),
        /仅完成/,
      );
      assert.equal(h.service.get(actor, task.id).status, "queued");
      assert.equal(h.service.get(actor, task.id).keepGroup, false);
    }
    const completeActor = { ...actor, messageId: "complete" };
    await h.service.action(completeActor, task.id, "complete", { keepGroup: true });
    await assert.rejects(
      h.service.action(completeActor, task.id, "complete", { keepGroup: false }),
      /同一任务操作/,
    );
    assert.equal(h.service.get(actor, task.id).keepGroup, true);
  } finally {
    h.close();
  }
});

test("deletion waits for both existing deliveries and its own one-time notice", async () => {
  let ready = false;
  let notices = 0;
  const hooks: TaskHooks = {
    canDeleteGroup: () => ready,
    notice: async (_task, kind) => {
      if (kind === "before_group_delete") {
        notices++;
        ready = false;
      }
    },
  };
  const h = setup(hooks);
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete");
    await h.service.tick();
    assert.equal(notices, 0);
    assert.equal(h.platform.deletions, 0);
    ready = true;
    await h.service.tick();
    assert.equal(notices, 1);
    assert.equal(h.platform.deletions, 0);
    assert.match(h.service.get(actor, task.id).syncError ?? "", /等待解散/);
    ready = true;
    const restored = new TaskService(h.options);
    await restored.tick();
    assert.equal(h.platform.deletions, 1);
    assert.equal(notices, 1);
    assert.equal(restored.get(actor, task.id).syncError, undefined);
  } finally {
    h.close();
  }
});

test("unknown group deletion is never replayed or subsequently declared retained", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    h.platform.deleteGroup = async () => {
      h.platform.deletions++;
      throw new OperationError("lost_response", "group deletion unknown", "unknown");
    };
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete");
    await h.service.tick();
    const restored = new TaskService(h.options);
    await restored.tick();
    assert.equal(h.platform.deletions, 1);
    assert.equal(restored.get(actor, task.id).groupDeleted, false);
    assert.equal(restored.get(actor, task.id).status, "destroying");
    await assert.rejects(
      restored.action({ ...actor, messageId: "retain" }, task.id, "complete", { keepGroup: true }),
      /解散结果尚未确认/,
    );
    assert.equal(restored.get(actor, task.id).keepGroup, false);
    assert.equal(h.herdr.closes, 2);
  } finally {
    h.close();
  }
});

test("complete, close and destroy clean panes once while waiting for the same deletion barrier", async () => {
  for (const action of ["complete", "close", "destroy"] as const) {
    let ready = false;
    const h = setup({ canDeleteGroup: () => ready });
    try {
      const task = await h.service.create(actor, discussion);
      await h.service.tick();
      await h.service.action({ ...actor, messageId: action }, task.id, action);
      await h.service.tick();
      assert.equal(h.service.get(actor, task.id).status, "destroying");
      assert.equal(h.herdr.closes, 2);
      assert.equal(h.platform.deletions, 0);
      await h.service.tick();
      assert.equal(h.herdr.closes, 2);
      ready = true;
      await new TaskService(h.options).tick();
      assert.equal(h.service.get(actor, task.id).status, "destroyed");
      assert.equal(h.herdr.closes, 2);
      assert.equal(h.platform.deletions, 1);
    } finally {
      h.close();
    }
  }
});

test("default completion closes Codex and Claude through herdr, regardless of group retention", async () => {
  for (const keepGroup of [false, true]) {
    const h = setup();
    try {
      const task = await h.service.create(actor, { ...discussion, keepGroup });
      await h.service.tick();
      assert.equal(h.herdr.agents.size, 2);
      h.platform.deleteGroup = async () => {
        assert.equal(
          h.herdr.agents.size,
          0,
          "herdr must confirm every pane closed before group deletion",
        );
        h.platform.deletions++;
      };
      await h.service.action({ ...actor, messageId: "complete-default" }, task.id, "complete");
      await h.service.tick();
      const result = h.service.get(actor, task.id);
      assert.equal(result.status, "destroyed");
      assert.ok(result.completedAt);
      assert.equal(h.herdr.closes, 2);
      assert.equal(h.herdr.agents.size, 0);
      assert.equal(h.platform.deletions, keepGroup ? 0 : 1);
      assert.equal(result.groupDeleted, !keepGroup);
      await new TaskService(h.options).tick();
      assert.equal(h.herdr.closes, 2);
    } finally {
      h.close();
    }
  }
});

test("explicitly local tasks can retain execution without inventing a group", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, {
      ...discussion,
      createGroup: false,
      createRemoteTask: false,
    });
    await h.service.tick();
    await h.service.action({ ...actor, messageId: "retain-local" }, task.id, "complete", {
      keepExecution: true,
    });
    await h.service.tick();
    assert.equal(h.service.get(actor, task.id).status, "completed");
    assert.equal(h.herdr.agents.size, 2);
    assert.equal(h.herdr.closes, 0);
    assert.equal(h.platform.groups, 0);
  } finally {
    h.close();
  }
});

test("execution retention validates action and type, rejects conflicting retries and cannot reverse started cleanup", async () => {
  const h = setup({ canDeleteGroup: () => false });
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    await assert.rejects(
      h.service.action({ ...actor, messageId: "invalid-retain" }, task.id, "complete", {
        keepExecution: true,
      }),
      /必须同时保留群/,
    );
    assert.equal(h.service.get(actor, task.id).status, "running");
    for (const action of ["close", "destroy", "reopen", "pause", "resume", "retry"] as const) {
      await assert.rejects(
        h.service.action(actor, task.id, action, { keepExecution: true }),
        /仅完成操作/,
      );
      assert.equal(h.service.get(actor, task.id).status, "running");
    }
    await assert.rejects(
      h.service.action(actor, task.id, "complete", { keepExecution: "true" as unknown as boolean }),
      /布尔值/,
    );
    const completionActor = { ...actor, messageId: "complete" };
    await h.service.action(completionActor, task.id, "complete", { keepExecution: false });
    await assert.rejects(
      h.service.action(completionActor, task.id, "complete", { keepExecution: true }),
      /同一任务操作/,
    );
    await h.service.tick();
    assert.equal(h.service.get(actor, task.id).status, "destroying");
    assert.equal(h.herdr.closes, 2);
    await assert.rejects(
      h.service.action({ ...actor, messageId: "late-retain" }, task.id, "complete", {
        keepExecution: true,
      }),
      /已开始清理/,
    );
    await h.service.action({ ...actor, messageId: "repeat-complete" }, task.id, "complete");
    await h.service.tick();
    assert.equal(h.herdr.closes, 2);
    assert.equal(h.service.get(actor, task.id).status, "destroying");
  } finally {
    h.close();
  }
});

test("confirmed external group closure cleans only owned panes from every active lifecycle state", async () => {
  for (const status of ["queued", "running", "paused", "completed"] as const) {
    const h = setup();
    try {
      const task = await h.service.create(actor, discussion);
      await h.service.tick();
      const foreign = await h.herdr.createWorkspace(h.directory);
      await h.herdr.startAgent(foreign.paneId, "codex", "unrelated", {
        directories: [h.directory],
      });
      const changed = h.service.get(actor, task.id);
      changed.status = status;
      changed.groupDeleted = true;
      changed.keepGroup = true;
      changed.completedAt = status === "completed" ? "already-confirmed" : undefined;
      h.service.records.save(changed);
      const writes = h.platform.updates;
      await new TaskService(h.options).tick();
      const closed = h.service.get(actor, task.id);
      assert.equal(closed.status, "destroyed");
      assert.equal(closed.completedAt, status === "completed" ? "already-confirmed" : undefined);
      assert.equal(h.herdr.closes, 2);
      assert.equal(h.herdr.agents.size, 1);
      assert.ok(h.herdr.agents.has(foreign.paneId));
      assert.equal(h.platform.deletions, 0, "external deletion is already confirmed");
      const projection = h.platform.updateCalls.slice(writes);
      assert.equal(projection.length, 1, "closed resources receive a final description");
      assert.equal(
        projection.some((call) => call.completedAt !== undefined),
        false,
        "closing a group does not assert task acceptance",
      );
      assert.match(projection[0]?.description ?? "", /状态：destroyed/);
      assert.doesNotMatch(projection[0]?.description ?? "", /会话：https/);
    } finally {
      h.close();
    }
  }
});

test("unknown herdr cleanup after external group closure freezes without replay or recreation", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    const changed = h.service.get(actor, task.id);
    changed.groupDeleted = true;
    h.service.records.save(changed);
    h.herdr.closeError = new OperationError("lost_response", "close unknown", "unknown");
    await h.service.tick();
    assert.equal(h.herdr.closes, 1);
    h.herdr.closeError = undefined;
    await new TaskService(h.options).tick();
    const pending = h.service.get(actor, task.id);
    assert.equal(pending.status, "destroying");
    assert.equal(pending.completedAt, undefined);
    assert.equal(h.herdr.closes, 1);
    assert.equal(h.herdr.starts, 2);
    assert.equal(h.platform.groups, 1);
    assert.equal(h.platform.deletions, 0);
  } finally {
    h.close();
  }
});

test("polling confirms external group closure without events, group notifications or a delivery barrier", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-18T00:00:00Z") });
  const notices: string[] = [];
  const h = setup({
    canDeleteGroup: () => false,
    notice: async (_task, kind) => {
      notices.push(kind);
    },
  });
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    let status: "normal" | "dissolved" = "normal";
    let calls = 0;
    Object.assign(h.platform, {
      getGroupStatus: async (id: string) => {
        calls++;
        assert.equal(id, h.service.get(actor, task.id).chatId);
        return status;
      },
    });
    await h.service.tick();
    assert.equal(h.herdr.closes, 0);
    status = "dissolved";
    t.mock.timers.tick(h.config.tasks.pollIntervalMs);
    const before = notices.length;
    await h.service.tick();
    const closed = h.service.get(actor, task.id);
    assert.equal(calls, 2);
    assert.equal(closed.groupDeleted, true);
    assert.equal(closed.status, "destroyed");
    assert.equal(closed.completedAt, undefined);
    assert.equal(h.herdr.closes, 2);
    assert.equal(h.platform.deletions, 0);
    assert.equal(notices.length, before);
  } finally {
    h.close();
  }
});

test("an unknown group status cannot be treated as evidence to close execution", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.tick();
    Object.assign(h.platform, {
      getGroupStatus: async () => {
        throw new OperationError("offline", "群状态查询失败");
      },
    });
    await h.service.tick();
    assert.equal(h.service.get(actor, task.id).groupDeleted, false);
    assert.equal(h.service.get(actor, task.id).status, "running");
    assert.equal(h.herdr.closes, 0);
    assert.equal(h.platform.deletions, 0);
  } finally {
    h.close();
  }
});
