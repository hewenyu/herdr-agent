import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../../src/core/types.js";
import { setup } from "./helpers.js";

test("Web lifecycle actions preserve or explicitly override group retention", async () => {
  const h = setup(false, true);
  try {
    for (const [operation, override] of [
      ["complete", true],
      ["close", false],
      ["destroy", true],
      ["complete", undefined],
    ] as const) {
      const task = (await h.app.dispatch("task.create", {
        kind: "discussion",
        title: `${operation}-${override}`,
        requirements: "验证明确的群保留选择",
        participants: [{ kind: "codex" }],
        keepGroup: override === undefined ? true : !override,
        createGroup: false,
        createRemoteTask: false,
      })) as Task;
      const updated = (await h.app.dispatch("task.action", {
        id: task.id,
        action: operation,
        ...(override === undefined ? {} : { keepGroup: override }),
      })) as Task;
      assert.equal(updated.keepGroup, override ?? true);
    }
  } finally {
    await h.close();
  }
});

test("Web rejects nonboolean group retention before applying a lifecycle action", async () => {
  const h = setup(false, true);
  try {
    const task = (await h.app.dispatch("task.create", {
      kind: "discussion",
      title: "保留设置校验",
      requirements: "无效输入不能完成任务",
      participants: [{ kind: "codex" }],
      keepGroup: true,
      createGroup: false,
      createRemoteTask: false,
    })) as Task;
    await assert.rejects(
      h.app.dispatch("task.action", { id: task.id, action: "complete", keepGroup: "false" }),
      /布尔值/,
    );
    const unchanged = h.store.get<Task>("tasks", task.id);
    assert.equal(unchanged?.status, "queued");
    assert.equal(unchanged?.keepGroup, true);
  } finally {
    await h.close();
  }
});

test("Web completion closes by default and accepts only an explicit compatible execution exception", async () => {
  const h = setup(false, true);
  try {
    for (const keepExecution of [false, true]) {
      const task = (await h.app.dispatch("task.create", {
        kind: "discussion",
        title: `执行保留-${keepExecution}`,
        requirements: "测试完成时的执行保留选项",
        participants: [{ kind: "codex" }],
        createGroup: true,
        createRemoteTask: false,
        keepGroup: false,
      })) as Task;
      await assert.rejects(
        h.app.dispatch("task.action", {
          id: task.id,
          action: "complete",
          keepExecution: "true",
        }),
        /布尔值/,
      );
      if (keepExecution)
        await assert.rejects(
          h.app.dispatch("task.action", {
            id: task.id,
            action: "complete",
            keepExecution: true,
            keepGroup: false,
          }),
          { code: "task_retention_conflict" },
        );
      const updated = (await h.app.dispatch("task.action", {
        id: task.id,
        action: "complete",
        keepExecution,
        keepGroup: keepExecution,
      })) as Task;
      assert.equal(updated.closeRequested, !keepExecution);
      assert.equal(updated.keepGroup, keepExecution);
    }
  } finally {
    await h.close();
  }
});
