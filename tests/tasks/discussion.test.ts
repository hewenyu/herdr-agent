import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { Participant, Task } from "../../src/core/types.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

test("round robin keeps dispatching past historical round limits without a user continuation", async () => {
  const outputs: string[] = [];
  const f = setup({
    output: async (_task, participant) => {
      outputs.push(participant.id);
    },
  });
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const stored = f.store.get<Task>("tasks", task.id);
    assert.ok(stored);
    stored.discussion.maxRounds = 1;
    f.store.set("tasks", task.id, stored);
    const participants = f.service.get(actor, task.id).participants;
    const first = participants[0];
    const second = participants[1];
    assert.ok(first?.execution);
    assert.ok(second?.execution);
    f.herdr.finish(first.execution.paneId, "Claude：方案A");
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 2);
    assert.equal(f.herdr.sends[1]?.pane, second.execution.paneId);
    assert.equal(f.service.get(actor, task.id).participants[1]?.initialSent, true);
    assert.ok(f.herdr.sends[1]?.text.includes("不是用户的新指令或授权"));
    f.herdr.finish(second.execution.paneId, "Codex：建议B");
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 3);
    assert.equal(outputs.length, 2);
    const current = f.service.get(actor, task.id);
    assert.equal(current.discussion.paused, false);
    assert.equal(current.discussion.rounds, 1);
    assert.equal(current.status, "running");
    assert.equal(f.herdr.sends[2]?.pane, first.execution.paneId);
    await f.service.tick();
    assert.equal(outputs.length, 2);
    assert.equal(f.herdr.sends.length, 3);
    for (let turn = 0; turn < 12; turn++) {
      const participant = turn % 2 === 0 ? first : second;
      assert.ok(participant.execution);
      f.herdr.finish(participant.execution.paneId, `后续观点 ${turn}`);
      await f.service.tick();
    }
    assert.equal(f.service.get(actor, task.id).discussion.rounds, 7);
    assert.equal(f.service.get(actor, task.id).discussion.paused, false);
    assert.equal(f.herdr.sends.length, 15);
    assert.equal(outputs.length, 14);
  } finally {
    f.close();
  }
});

test("elapsed time and historical time limits do not stop turns; a missing participant still pauses", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const current = f.service.get(actor, task.id);
    const first = current.participants[0];
    const second = current.participants[1];
    assert.ok(first?.execution);
    assert.ok(second?.execution);
    const stored = f.store.get<Task>("tasks", task.id);
    assert.ok(stored);
    stored.discussion.startedAt = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    stored.discussion.maxMinutes = 30;
    f.store.set("tasks", task.id, stored);
    f.herdr.finish(first.execution.paneId, "长时间讨论后的回复");
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 2);
    assert.equal(f.service.get(actor, task.id).discussion.paused, false);
    f.herdr.agents.delete(second.execution.paneId);
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).status, "attention");
    assert.equal(f.service.get(actor, task.id).discussion.paused, true);
    assert.equal(f.service.get(actor, task.id).participants[1]?.status, "gone");
  } finally {
    f.close();
  }
});

test("output delivery retries after restart while native discussion continues independently", async () => {
  let failed = true;
  let delivered = 0;
  const f = setup({
    output: async () => {
      if (failed) throw new OperationError("unavailable", "delivery failed");
      delivered++;
    },
  });
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const first = f.service.get(actor, task.id).participants[0];
    assert.ok(first?.execution);
    f.herdr.finish(first.execution.paneId, "待投递发言");
    await f.service.tick();
    assert.equal(f.store.list("pending_outputs").length, 1);
    assert.equal(f.herdr.sends.length, 2);
    failed = false;
    const restored = new TaskService(f.options);
    await restored.tick();
    assert.equal(delivered, 1);
    assert.equal(f.store.list("pending_outputs").length, 0);
    assert.equal(f.herdr.sends.length, 2);
    assert.equal(f.herdr.starts, 2);
  } finally {
    f.close();
  }
});

test("pending relay recovers after known nonexecution reset; unknown relay is never replayed", async () => {
  for (const outcome of ["not_executed", "unknown"] as const) {
    const f = setup();
    try {
      const task = await f.service.create(actor, discussion);
      await f.service.tick();
      const first = f.service.get(actor, task.id).participants[0];
      assert.ok(first?.execution);
      f.herdr.sendError = new OperationError("transport", "send failed", outcome);
      f.herdr.finish(first.execution.paneId, "发言");
      await f.service.tick();
      assert.equal(f.store.list("pending_relays").length, 1);
      assert.equal(f.store.list("task_outputs").length, 1);
      f.herdr.sendError = undefined;
      const restored = new TaskService(f.options);
      const sends = f.herdr.sends.length;
      if (outcome === "unknown") {
        await restored.tick();
        assert.equal(f.herdr.sends.length, sends);
        await assert.rejects(restored.action({ ...actor, messageId: "retry" }, task.id, "retry"));
      } else {
        await restored.action({ ...actor, messageId: "retry" }, task.id, "retry");
        await restored.tick();
        assert.equal(f.herdr.sends.length, sends + 1);
      }
    } finally {
      f.close();
    }
  }
});

test("legacy transcript establishes baseline and cannot replay old replies", async () => {
  let outputs = 0;
  const f = setup({
    output: async () => {
      outputs++;
    },
  });
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const first = f.service.get(actor, task.id).participants[0];
    assert.ok(first?.execution);
    f.herdr.finish(first.execution.paneId, "历史旧结果");
    f.store.set("legacy_imports", first.id, {
      taskId: task.id,
      promptSent: true,
      resultDelivered: true,
      lastResult: "历史旧结果",
    });
    const stored = f.store.get<Participant>("participants", first.id);
    assert.ok(stored);
    stored.cursor = undefined;
    f.store.set("participants", first.id, stored);
    await f.service.tick();
    await f.service.tick();
    assert.equal(outputs, 0);
    assert.equal(f.herdr.sends.length, 1);
    f.herdr.finish(first.execution.paneId, "新结果");
    await f.service.tick();
    assert.equal(outputs, 1);
  } finally {
    f.close();
  }
});

test("local web task access keeps owner and task boundaries without a Feishu group", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, { ...discussion, createGroup: false });
    await f.service.tick();
    const web = { ...actor, source: "web" as const, chatId: "web", taskId: task.id };
    assert.equal(f.service.get(web, task.id).id, task.id);
    assert.throws(() => f.service.get({ ...web, ownerId: "other" }, task.id));
    assert.throws(() => f.service.get({ ...web, taskId: "different" }, task.id));
    assert.throws(() => f.service.get({ ...web, source: "feishu" }, task.id));
  } finally {
    f.close();
  }
});

test("every relay supplies a durable per-turn receipt without reusing the initial marker", async () => {
  const f = setup();
  const received: Array<string | undefined> = [];
  const send = f.herdr.send.bind(f.herdr);
  f.herdr.send = async (ref, text, options?: { receipt?: string }) => {
    received.push(options?.receipt);
    return send(ref, text);
  };
  try {
    const task = await f.service.create(actor, {
      ...discussion,
      requirements: "较长讨论上下文".repeat(500),
    });
    await f.service.tick();
    const first = f.service.get(actor, task.id).participants[0];
    const second = f.service.get(actor, task.id).participants[1];
    assert.ok(first?.execution);
    assert.ok(second?.execution);
    f.herdr.finish(first.execution.paneId, "方案细节".repeat(500));
    await f.service.tick();
    assert.equal(received[1], second.initialReceipt);
    assert.ok((f.herdr.sends[1]?.text.length ?? 0) > 5000);
    assert.ok(f.herdr.sends[1]?.text.includes(second.initialReceipt));
    f.herdr.finish(second.execution.paneId, "第二轮反馈");
    await f.service.tick();
    assert.equal(received.length, 3);
    assert.ok(received[2]?.startsWith("HERDR_RECEIPT_"));
    assert.notEqual(received[2], first.initialReceipt);
    assert.notEqual(received[2], second.initialReceipt);
  } finally {
    f.close();
  }
});
