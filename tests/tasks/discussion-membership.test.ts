import assert from "node:assert/strict";
import test from "node:test";
import { actor, discussion, setup } from "./helpers.js";

for (const count of [2, 3]) {
  test(`resume after removing the paused last speaker advances among ${count - 1} remaining participants`, async () => {
    const f = setup();
    try {
      const task = await f.service.create(actor, {
        ...discussion,
        participants: [
          { kind: "claude", name: "A" },
          { kind: "codex", name: "B" },
          ...(count === 3 ? [{ kind: "claude" as const, name: "C" }] : []),
        ],
      });
      await f.service.tick();
      const [first, second] = f.service.get(actor, task.id).participants;
      assert.ok(first?.execution && second?.execution);
      await f.service.action({ ...actor, messageId: "pause" }, task.id, "pause");
      f.herdr.finish(first.execution.paneId, "A的已保存观点");
      await f.service.tick();
      await f.service.removeParticipant({ ...actor, messageId: "remove" }, task.id, first.id);
      await f.service.action({ ...actor, messageId: "resume" }, task.id, "resume");
      assert.equal(f.herdr.sends.length, 2);
      assert.equal(f.herdr.sends[1]?.pane, second.execution.paneId);
      assert.ok(f.herdr.sends[1]?.text.includes("A的已保存观点"));
      const state = f.service.get(actor, task.id);
      assert.equal(state.participants[0]?.status, "removed");
      assert.equal(state.discussion.activeParticipant, second.id);
      assert.equal(state.discussion.nextParticipant, 0);
      await f.service.tick();
      assert.equal(f.herdr.sends.length, 2);
      assert.equal(f.herdr.closes, 1);
    } finally {
      f.close();
    }
  });
}

test("resume skips a removed active participant without attributing the last speaker's output to it", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, {
      ...discussion,
      participants: [
        { kind: "claude", name: "A" },
        { kind: "codex", name: "B" },
        { kind: "claude", name: "C" },
      ],
    });
    await f.service.tick();
    const [first, second, third] = f.service.get(actor, task.id).participants;
    assert.ok(first?.execution && second?.execution && third?.execution);
    f.herdr.finish(first.execution.paneId, "A的观点");
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 2);
    await f.service.removeParticipant({ ...actor, messageId: "remove" }, task.id, second.id);
    await f.service.action({ ...actor, messageId: "resume" }, task.id, "resume");
    assert.equal(f.herdr.sends.length, 3);
    assert.equal(f.herdr.sends[2]?.pane, third.execution.paneId);
    assert.ok(f.herdr.sends[2]?.text.includes('"participant":"A","text":"A的观点"'));
    assert.equal(f.service.get(actor, task.id).participants[1]?.status, "removed");
    assert.equal(f.service.get(actor, task.id).discussion.activeParticipant, third.id);
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 3);
  } finally {
    f.close();
  }
});

test("resume can start a remaining participant when the removed first speaker produced no output", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const [first, second] = f.service.get(actor, task.id).participants;
    assert.ok(first && second?.execution);
    await f.service.removeParticipant({ ...actor, messageId: "remove" }, task.id, first.id);
    await f.service.action({ ...actor, messageId: "resume" }, task.id, "resume");
    assert.equal(f.herdr.sends.length, 2);
    assert.equal(f.herdr.sends[1]?.pane, second.execution.paneId);
    assert.ok(f.herdr.sends[1]?.text.includes(task.requirements));
    assert.equal(f.service.get(actor, task.id).participants[0]?.status, "removed");
    assert.equal(f.service.get(actor, task.id).discussion.activeParticipant, second.id);
    await f.service.action({ ...actor, messageId: "resume" }, task.id, "resume");
    await f.service.tick();
    assert.equal(f.herdr.sends.length, 2);
  } finally {
    f.close();
  }
});
