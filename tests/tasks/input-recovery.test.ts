import assert from "node:assert/strict";
import test from "node:test";
import type { HerdrPort } from "../../src/core/ports.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { participantPrompt } from "../../src/tasks/prompts.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

function previousDiscussionPrompt(text: string): string {
  const previous = text.replace(
    "用户明确指定的篇幅、输出格式和是否列出未决问题优先于通用讨论模板；不得为补齐观点、问题、方案而增加用户未要求的段落。\n用户未指定时，按需要给出具体观点、方案或影响结论的未决问题，不强制凑齐类别；只进行本轮发言，等待用户或调度器安排下一轮。",
    "给出具体观点、未决问题和方案；只进行本轮发言，等待用户或调度器安排下一轮。",
  );
  assert.notEqual(previous, text);
  return previous;
}

for (const [state, oldTemplate] of [
  ["pending", false],
  ["uncertain", false],
  ["pending", true],
  ["uncertain", true],
] as const) {
  test(`first participant ${state} delivery recovers without re-sending (old template=${oldTemplate})`, async () => {
    const outputs: string[] = [];
    const f = setup({
      output: async (_task, _participant, entry) => {
        outputs.push(entry.text);
      },
    });
    try {
      f.herdr.delivery = { status: "unconfirmed", verified: false, acked: true, attempts: 1 };
      const task = await f.service.create(actor, {
        ...discussion,
        participants: [{ kind: "claude", name: "Claude" }],
      });
      await f.service.tick();
      const first = f.service.get(actor, task.id).participants[0];
      assert.ok(first?.execution);
      assert.equal(first.initialSent, false);
      const key = `${first.id}:initial`;
      const op = f.store.get<OperationReceipt>("operations", key);
      assert.ok(op);
      f.store.set("operations", key, { ...op, state });
      f.herdr.finish(first.execution.paneId, "received and answered");
      const sent = f.herdr.sends[0]?.text;
      assert.ok(sent);
      (f.herdr as HerdrPort).initialInput = async () =>
        oldTemplate ? previousDiscussionPrompt(sent) : sent;
      // Imported versions have no exact per-operation input snapshot.
      f.store.delete("input_deliveries", key);
      const restored = new TaskService(f.options);
      await restored.tick();
      assert.equal(f.store.get<OperationReceipt>("operations", key)?.state, "done");
      assert.equal(restored.get(actor, task.id).participants[0]?.initialSent, true);
      assert.equal(restored.get(actor, task.id).discussion.paused, true);
      assert.equal(restored.get(actor, task.id).pending, undefined);
      assert.deepEqual(outputs, ["received and answered"]);
      assert.equal(f.herdr.sends.length, 1);
      await new TaskService(f.options).tick();
      assert.deepEqual(outputs, ["received and answered"]);
      assert.equal(f.herdr.sends.length, 1);
    } finally {
      f.close();
    }
  });
}

for (const [legacy, oldTemplate] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
]) {
  test(`uncertain first relay recovers once (legacy arrangement=${legacy}, old template=${oldTemplate})`, async () => {
    const outputs: string[] = [];
    const f = setup({
      output: async (_task, _participant, entry) => {
        outputs.push(entry.text);
      },
    });
    try {
      const task = await f.service.create(actor, discussion);
      await f.service.tick();
      const [first, second] = f.service.get(actor, task.id).participants;
      assert.ok(first?.execution && second?.execution);
      f.herdr.delivery = { status: "unconfirmed", verified: false, acked: true, attempts: 1 };
      f.herdr.finish(first.execution.paneId, "first answer");
      await f.service.tick();
      assert.equal(f.herdr.sends.length, 2);
      const key = f.store
        .entries<OperationReceipt>("operations")
        .find(([id, op]) => id.includes(":relay:") && op.state === "uncertain")?.[0];
      assert.ok(key);
      f.herdr.finish(second.execution.paneId, "second answer");
      const sent = f.herdr.sends[1]?.text;
      assert.ok(sent);
      const suffix = `\n\n投递标识（无需复述）：\n${second.initialReceipt}`;
      const arrangement = sent.split("\n\n本轮安排：\n")[1]?.slice(0, -suffix.length);
      assert.ok(arrangement);
      const initial = legacy
        ? `${participantPrompt(task, second)}\n\n本轮安排：\n${arrangement}`
        : sent;
      (f.herdr as HerdrPort).initialInput = async () =>
        oldTemplate ? previousDiscussionPrompt(initial) : initial;
      f.store.delete("input_deliveries", key);
      const restored = new TaskService(f.options);
      await restored.tick();
      assert.equal(f.store.get<OperationReceipt>("operations", key)?.state, "done");
      assert.equal(restored.get(actor, task.id).participants[1]?.initialSent, true);
      assert.equal(restored.get(actor, task.id).discussion.activeParticipant, second.id);
      assert.equal(restored.get(actor, task.id).discussion.nextParticipant, 1);
      assert.equal(restored.get(actor, task.id).discussion.paused, true);
      assert.deepEqual(outputs, ["first answer", "second answer"]);
      await new TaskService(f.options).tick();
      assert.equal(restored.get(actor, task.id).discussion.nextParticipant, 1);
      assert.equal(f.herdr.sends.length, 2);
      assert.deepEqual(outputs, ["first answer", "second answer"]);
    } finally {
      f.close();
    }
  });
}

for (const [failure, oldTemplate] of (
  ["wrong_input", "wrong_fingerprint", "wrong_receipt", "ambiguous"] as const
).flatMap((failure) => [false, true].map((oldTemplate) => [failure, oldTemplate] as const))) {
  test(`${failure} evidence leaves the relay uncertain without replay (old template=${oldTemplate})`, async () => {
    const f = setup();
    try {
      const task = await f.service.create(actor, discussion);
      await f.service.tick();
      const [first, second] = f.service.get(actor, task.id).participants;
      assert.ok(first?.execution && second?.execution);
      f.herdr.delivery = { status: "unconfirmed", verified: false, acked: true, attempts: 1 };
      f.herdr.finish(first.execution.paneId, "first");
      await f.service.tick();
      const entry = f.store
        .entries<OperationReceipt>("operations")
        .find(([id, op]) => id.includes(":relay:") && op.state === "uncertain");
      assert.ok(entry);
      const [key, operation] = entry;
      if (failure === "wrong_fingerprint")
        f.store.set("operations", key, { ...operation, fingerprint: "different" });
      if (failure === "ambiguous")
        f.store.set("operations", `${task.id}:relay:duplicate:${second.id}`, {
          ...operation,
          id: `${task.id}:relay:duplicate:${second.id}`,
        });
      const sent = f.herdr.sends[1]?.text;
      assert.ok(sent);
      const input = oldTemplate ? previousDiscussionPrompt(sent) : sent;
      (f.herdr as HerdrPort).initialInput = async () =>
        failure === "wrong_input"
          ? "other input"
          : failure === "wrong_receipt"
            ? input.replaceAll(second.initialReceipt, "wrong-receipt")
            : input;
      await new TaskService(f.options).tick();
      assert.equal(f.store.get<OperationReceipt>("operations", key)?.state, "uncertain");
      assert.equal(f.service.get(actor, task.id).participants[1]?.initialSent, false);
      assert.equal(f.herdr.sends.length, 2);
    } finally {
      f.close();
    }
  });
}

test("shutdown during initial input readback leaves the uncertain receipt for a later restart", async () => {
  const f = setup();
  try {
    f.herdr.delivery = { status: "unconfirmed", verified: false, acked: true, attempts: 1 };
    const task = await f.service.create(actor, {
      ...discussion,
      participants: [{ kind: "claude", name: "Claude" }],
    });
    await f.service.tick();
    const first = f.service.get(actor, task.id).participants[0];
    assert.ok(first);
    const key = `${first.id}:initial`;
    (f.herdr as HerdrPort).initialInput = async () => {
      f.service.stop();
      return f.herdr.sends[0]?.text;
    };
    await f.service.tick();
    assert.equal(f.store.get<OperationReceipt>("operations", key)?.state, "uncertain");
    assert.equal(f.service.get(actor, task.id).participants[0]?.initialSent, false);
    assert.equal(f.herdr.sends.length, 1);
  } finally {
    f.close();
  }
});
