import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/types.js";
import { participantPrompt } from "../../src/tasks/prompts.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

test("platform absence preserves requested cloud resources; explicitly local tasks can run", async () => {
  const f = setup();
  try {
    const local = new TaskService({ ...f.options, platform: undefined });
    const waiting = await local.create(actor, discussion);
    await local.tick();
    assert.equal(f.herdr.starts, 0);
    assert.equal(f.herdr.creates, 0);
    assert.equal(local.get(actor, waiting.id).createGroup, true);
    assert.equal(local.get(actor, waiting.id).createRemoteTask, true);
    const task = await local.create(
      { ...actor, messageId: "local" },
      { ...discussion, createGroup: false, createRemoteTask: false },
    );
    await local.tick();
    assert.equal(local.get(actor, task.id).status, "running");
    assert.equal(f.herdr.starts, 2);
    // Reattaching the platform provisions the original task with the same resource intent.
    await f.service.tick();
    assert.ok(f.service.get(actor, waiting.id).chatId);
  } finally {
    f.close();
  }
});

test("shutdown waits for submitted resource result but never starts next agent or task and never closes herdr", async () => {
  const f = setup();
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const submitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const create = f.herdr.createWorkspace.bind(f.herdr);
  f.herdr.createWorkspace = async (cwd) => {
    entered?.();
    await blocked;
    return create(cwd);
  };
  try {
    f.config.runtime.maxConcurrentTasks = 1;
    const input = { ...discussion, createGroup: false, createRemoteTask: false };
    await f.service.create(actor, input);
    await f.service.create({ ...actor, messageId: "other" }, input);
    const running = f.service.tick();
    await submitted;
    f.service.stop();
    release?.();
    await running;
    assert.equal(f.herdr.creates, 1);
    assert.equal(f.herdr.starts, 0);
    assert.equal(f.herdr.closes, 0);
    const participants = f.store.list<{ execution?: unknown; started: boolean }>("participants");
    assert.equal(participants.filter((participant) => participant.execution).length, 1);
    assert.ok(participants.every((participant) => !participant.started));
    await f.service.tick();
    assert.equal(f.herdr.creates, 1);
    await assert.rejects(f.service.create({ ...actor, messageId: "late" }, input), /服务正在停止/);
    const restored = new TaskService(f.options);
    await restored.tick();
    assert.equal(f.herdr.creates, 4);
    assert.equal(f.herdr.starts, 4);
    assert.equal(f.herdr.closes, 0);
  } finally {
    release?.();
    f.close();
  }
});

test("linked task receives an immutable parent discussion snapshot, subordinate to current user requirements", async () => {
  const f = setup();
  try {
    const parent = await f.service.create(actor, discussion);
    parent.result = "共同结论A";
    f.service.records.save(parent);
    const participant = f.service.records.participants(parent)[0];
    assert.ok(participant);
    participant.lastOutput = "Claude建议B";
    f.service.records.saveParticipant(participant);
    const child = await f.service.create(
      { ...actor, messageId: "child" },
      {
        ...discussion,
        kind: "development",
        project: "project",
        parentTaskId: parent.id,
        requirements: "用户仅授权实现A，不实现B",
      },
    );
    parent.result = "后续修改C";
    f.service.records.save(parent);
    participant.lastOutput = "后续修改D";
    f.service.records.saveParticipant(participant);
    const saved = f.service.get(actor, child.id);
    const childParticipant = saved.participants[0];
    assert.ok(childParticipant);
    const prompt = participantPrompt(saved, childParticipant);
    assert.ok(prompt.includes("共同结论A"));
    assert.ok(prompt.includes("Claude建议B"));
    assert.ok(!prompt.includes("后续修改C"));
    assert.ok(!prompt.includes("后续修改D"));
    assert.ok(prompt.includes("本次用户要求优先"));
    assert.ok(prompt.includes("用户仅授权实现A，不实现B"));
    assert.ok(prompt.indexOf("共同结论A") < prompt.indexOf("用户仅授权实现A，不实现B"));
  } finally {
    f.close();
  }
});

test("complete preserves execution; reopen works; close confirms remote completion before cleanup", async () => {
  const notices: string[] = [];
  const f = setup({
    notice: async (_task, kind) => {
      notices.push(kind);
    },
  });
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const started = f.service.get(actor, task.id);
    assert.equal(started.participants.length, 2);
    assert.equal(f.herdr.starts, 2);
    assert.equal(f.herdr.sends.length, 1);
    assert.ok(started.remoteTaskId);
    assert.ok(started.chatId);
    assert.equal(started.status, "running");
    await f.service.action({ ...actor, messageId: "complete" }, task.id, "complete", {
      keepExecution: true,
      keepGroup: true,
    });
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).status, "completed");
    assert.equal(f.herdr.closes, 0);
    assert.equal(f.platform.deletions, 0);
    assert.equal(f.service.get(actor, task.id).groupDeleted, false);
    await f.service.action({ ...actor, messageId: "reopen" }, task.id, "reopen");
    assert.equal(f.service.get(actor, task.id).status, "review");
    // A duplicate old complete event must not re-complete a reopened task.
    await f.service.action({ ...actor, messageId: "complete" }, task.id, "complete", {
      keepExecution: true,
      keepGroup: true,
    });
    assert.equal(f.service.get(actor, task.id).status, "review");
    await f.service.action({ ...actor, messageId: "close" }, task.id, "close", {
      keepGroup: false,
    });
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).status, "destroyed");
    assert.equal(f.herdr.closes, 2);
    assert.equal(f.platform.deletions, 1);
    assert.ok(notices.includes("before_close"));
    await assert.rejects(f.service.action({ ...actor, messageId: "reopen2" }, task.id, "reopen"));
  } finally {
    f.close();
  }
});

test("external Feishu completion closes on reconciliation, retained groups remain", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-18T00:00:00Z") });
  const f = setup();
  try {
    const task = await f.service.create(actor, { ...discussion, keepGroup: true });
    await f.service.tick();
    const current = f.service.get(actor, task.id);
    const remote = f.platform.tasks.get(current.remoteTaskId ?? "");
    assert.ok(remote);
    remote.completedAt = "1234";
    t.mock.timers.tick(f.config.tasks.pollIntervalMs);
    await f.service.tick();
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).status, "destroyed");
    assert.equal(f.platform.deletions, 0);
    assert.equal(f.service.get(actor, task.id).completedAt, "1234");
  } finally {
    f.close();
  }
});

test("unknown workspace creation and initial delivery never repeat across service restart", async () => {
  for (const stage of ["workspace", "delivery"]) {
    const f = setup();
    try {
      if (stage === "workspace")
        f.herdr.createError = new OperationError("connection_lost", "unknown", "unknown");
      else f.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
      const task = await f.service.create(actor, discussion);
      await f.service.tick();
      const counts = [f.herdr.creates, f.herdr.sends.length];
      const restored = new TaskService(f.options);
      await restored.tick();
      assert.deepEqual([f.herdr.creates, f.herdr.sends.length], counts);
      await assert.rejects(restored.action({ ...actor, messageId: "retry" }, task.id, "retry"));
      assert.equal(restored.get(actor, task.id).status, "attention");
    } finally {
      f.close();
    }
  }
});

test("transient herdr and remote read failures recover without manual reset", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-18T00:00:00Z") });
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    f.herdr.getError = new OperationError("timeout", "temporarily unavailable");
    await f.service.tick();
    assert.ok(f.service.get(actor, task.id).syncError);
    f.herdr.getError = undefined;
    f.platform.getError = new OperationError("http_read", "temporary read failure");
    t.mock.timers.tick(f.config.tasks.pollIntervalMs);
    await f.service.tick();
    assert.ok(f.service.get(actor, task.id).syncError);
    f.platform.getError = undefined;
    t.mock.timers.tick(f.config.tasks.pollIntervalMs);
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).syncError, undefined);
    assert.equal(f.herdr.starts, 2);
    assert.equal(f.herdr.sends.length, 1);
  } finally {
    f.close();
  }
});

test("unknown completion PATCH is resolved by query without repeating the completion write", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-18T00:00:00Z") });
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    f.platform.updateError = new OperationError("network", "unknown", "unknown");
    await f.service.action({ ...actor, messageId: "complete" }, task.id, "complete", {
      keepExecution: true,
      keepGroup: true,
    });
    const updates = f.platform.updates;
    f.platform.updateError = undefined;
    t.mock.timers.tick(f.config.tasks.pollIntervalMs);
    await f.service.tick();
    assert.equal(f.platform.updates, updates);
    const remoteId = f.service.get(actor, task.id).remoteTaskId;
    const remote = f.platform.tasks.get(remoteId ?? "");
    assert.ok(remote);
    remote.completedAt = "resolved";
    t.mock.timers.tick(f.config.tasks.pollIntervalMs);
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).status, "completed");
    assert.equal(f.platform.updates, updates);
    t.mock.timers.tick(f.config.tasks.pollIntervalMs);
    await f.service.tick();
    // Retained completed tasks now keep observing late output and project their
    // completed description. That separate write must not set completion again.
    assert.equal(f.platform.updates, updates + 1);
    assert.equal(f.platform.updateCalls.filter((call) => call.completedAt !== undefined).length, 1);
    assert.equal(f.platform.updateCalls.at(-1)?.completedAt, undefined);
    assert.match(f.platform.updateCalls.at(-1)?.description ?? "", /completed/);
  } finally {
    f.close();
  }
});

test("owner, group and ended-task boundaries are enforced", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const current = f.service.get(actor, task.id);
    assert.throws(() => f.service.get({ ...actor, ownerId: "other" }, task.id));
    assert.throws(() => f.service.get({ ...actor, chatId: current.chatId ?? "" }, task.id));
    const group = { ...actor, chatId: current.chatId ?? "", taskId: task.id };
    assert.equal(f.service.get(group, task.id).id, task.id);
    await assert.rejects(f.service.create(group, discussion));
    await f.service.action({ ...actor, messageId: "destroy" }, task.id, "destroy");
    await f.service.tick();
    const ended = f.store.get<Task>("tasks", task.id);
    assert.equal(ended?.completedAt, undefined);
    await assert.rejects(
      f.service.send({ ...actor, messageId: "send" }, task.id, current.participants[0]?.id, "继续"),
    );
  } finally {
    f.close();
  }
});

test("destroy cleanup survives a transient refusal without restarting execution", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    f.herdr.closeError = new OperationError("temporarily_unavailable", "not executed");
    await f.service.action({ ...actor, messageId: "destroy" }, task.id, "destroy");
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).status, "destroying");
    f.herdr.closeError = undefined;
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).status, "destroyed");
    assert.equal(f.herdr.starts, 2);
  } finally {
    f.close();
  }
});

test("a newly started participant cannot report the previous transcript reply", async () => {
  let delivered = 0;
  const f = setup({
    output: async () => {
      delivered++;
    },
  });
  try {
    f.herdr.outputs.set("p1", [
      { id: "stale", role: "assistant", text: "旧任务结果", final: true },
    ]);
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const first = f.service.get(actor, task.id).participants[0];
    assert.ok(first?.execution);
    const agent = f.herdr.agents.get(first.execution.paneId);
    assert.ok(agent);
    agent.status = "idle";
    await f.service.tick();
    assert.equal(delivered, 0);
    f.herdr.finish(first.execution.paneId, "新任务结果");
    await f.service.tick();
    assert.equal(delivered, 1);
  } finally {
    f.close();
  }
});

test("group welcome failure retries the notification without recreating the group", async () => {
  let failWelcome = true;
  let welcome = 0;
  const f = setup({
    notice: async (_task, kind) => {
      if (kind === "welcome") {
        welcome++;
        if (failWelcome) throw new OperationError("notice", "temporary failure");
      }
    },
  });
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    assert.equal(f.platform.groups, 1);
    assert.equal(f.herdr.starts, 0);
    failWelcome = false;
    await f.service.tick();
    assert.equal(f.platform.groups, 1);
    assert.equal(welcome, 2);
    assert.equal(f.herdr.starts, 2);
    assert.equal(f.service.get(actor, task.id).status, "running");
  } finally {
    f.close();
  }
});

test("native session changes retain herdr pane identity without replaying startup or old output", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, {
      ...discussion,
      participants: [{ kind: "codex" }],
    });
    await h.service.reconcile(task.id);
    const participant = h.service.records.participants(task)[0];
    const pane = participant?.execution?.paneId;
    assert.ok(pane);
    const live = h.herdr.agents.get(pane);
    assert.ok(live);
    live.sessionId = "new-native-session-after-clear";
    live.status = "idle";
    await h.service.reconcile(task.id);
    const current = h.service.get(actor, task.id);
    assert.equal(current.status, "review");
    assert.match(current.participants[0]?.sessionNote ?? "", /原生会话已变化/);
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.herdr.starts, 1);
    await h.service.send({ ...actor, messageId: "followup" }, task.id, undefined, "继续这个任务");
    assert.equal(h.herdr.sends.length, 2);
  } finally {
    h.close();
  }
});

test("close preserves and delivers the final unpolled result before cleaning execution", async () => {
  const outputs: string[] = [];
  const h = setup({
    output: async (_task, _participant, entry) => {
      outputs.push(entry.text);
    },
  });
  try {
    const task = await h.service.create(actor, {
      ...discussion,
      participants: [{ kind: "codex" }],
    });
    await h.service.reconcile(task.id);
    const participant = h.service.records.participants(task)[0];
    h.herdr.finish(participant?.execution?.paneId ?? "", "关闭前尚未轮询的最终结论");
    await h.service.action({ ...actor, messageId: "close" }, task.id, "close", {
      keepGroup: false,
    });
    await h.service.reconcile(task.id);
    assert.equal(h.service.get(actor, task.id).status, "destroyed");
    assert.match(h.service.get(actor, task.id).result, /最终结论/);
    assert.deepEqual(outputs, ["关闭前尚未轮询的最终结论"]);
    assert.equal(h.herdr.closes, 1);
  } finally {
    h.close();
  }
});

test("paused and completed tasks still capture late output without resuming discussions", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, discussion);
    await h.service.reconcile(task.id);
    const participant = h.service.records.participants(task)[0];
    const pane = participant?.execution?.paneId ?? "";
    await h.service.action({ ...actor, messageId: "pause" }, task.id, "pause");
    h.herdr.finish(pane, "暂停后的迟到回复");
    await h.service.reconcile(task.id);
    assert.equal(h.service.get(actor, task.id).status, "paused");
    assert.match(h.service.get(actor, task.id).result, /暂停后的迟到回复/);
    assert.equal(h.herdr.sends.length, 1);
    await h.service.action({ ...actor, messageId: "complete" }, task.id, "complete", {
      keepExecution: true,
      keepGroup: true,
    });
    h.herdr.finish(pane, "完成后保留现场的迟到结果");
    await h.service.reconcile(task.id);
    assert.equal(h.service.get(actor, task.id).status, "completed");
    assert.match(h.service.get(actor, task.id).result, /完成后保留现场/);
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    h.close();
  }
});

test("an exited agent's final transcript is preserved before closing its remaining pane", async () => {
  const h = setup();
  try {
    const task = await h.service.create(actor, {
      ...discussion,
      participants: [{ kind: "codex" }],
    });
    await h.service.reconcile(task.id);
    const pane = h.service.records.participants(task)[0]?.execution?.paneId ?? "";
    h.herdr.finish(pane, "进程退出前的最终结果");
    h.herdr.agents.delete(pane);
    await h.service.action({ ...actor, messageId: "close-exited" }, task.id, "close");
    await h.service.reconcile(task.id);
    assert.equal(h.service.get(actor, task.id).status, "destroyed");
    assert.match(h.service.get(actor, task.id).result, /退出前的最终结果/);
  } finally {
    h.close();
  }
});

test("read failures on replaced agents cannot erase completed or paused lifecycle intent", async () => {
  for (const action of ["complete", "pause"] as const) {
    const h = setup();
    try {
      const task = await h.service.create(actor, discussion);
      await h.service.reconcile(task.id);
      await h.service.action(
        { ...actor, messageId: action },
        task.id,
        action,
        action === "complete" ? { keepExecution: true, keepGroup: true } : {},
      );
      const pane = h.service.records.participants(task)[0]?.execution?.paneId ?? "";
      const live = h.herdr.agents.get(pane);
      assert.ok(live);
      live.workspaceId = "foreign-workspace";
      const starts = h.herdr.starts;
      await h.service.reconcile(task.id);
      await h.service.reconcile(task.id);
      const current = h.service.get(actor, task.id);
      assert.equal(current.status, action === "complete" ? "completed" : "paused");
      assert.match(current.error ?? "", /身份发生变化/);
      assert.equal(h.herdr.starts, starts);
      assert.equal(h.herdr.sends.length, 1);
    } finally {
      h.close();
    }
  }
});
