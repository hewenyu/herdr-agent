import assert from "node:assert/strict";
import test from "node:test";
import type { notificationParticipants, notificationTask } from "../../src/app/notifications.js";
import type { Task } from "../../src/core/types.js";
import { setup } from "./helpers.js";

type NoticeSnapshot = {
  event: string;
  task: ReturnType<typeof notificationTask>;
  participants: ReturnType<typeof notificationParticipants>;
};

for (const mode of ["manual", "round_robin"] as const) {
  test(`single-participant ${mode} notices expose startup facts and output does not trigger another turn`, async () => {
    const h = setup();
    const snapshots: NoticeSnapshot[] = [];
    h.engine.handler = async (input) => {
      snapshots.push(JSON.parse(input.prompt));
      return { text: '{"notify":false,"text":""}', messages: [] };
    };
    h.config.ui.notifyCooldownMs = 0;
    try {
      const task = (await h.app.dispatch("task.create", {
        kind: "discussion",
        title: "Single participant discussion",
        requirements: "Reply once and wait for user acceptance.",
        participants: [{ kind: "codex", name: "Codex" }],
        discussion: { mode, maxRounds: 4, maxMinutes: 30 },
      })) as Task;
      await h.app.tasks.reconcile(task.id);
      const welcome = snapshots.find((snapshot) => snapshot.event === "welcome");
      assert.ok(welcome);
      assert.equal(welcome.task.discussion.mode, mode);
      assert.equal(welcome.task.discussion.rounds, 0);
      assert.equal(welcome.task.discussion.activeParticipant, welcome.participants[0]?.id);
      assert.deepEqual(
        welcome.participants.map(({ name, started, initialSent, hasOutput }) => ({
          name,
          started,
          initialSent,
          hasOutput,
        })),
        [{ name: "Codex", started: false, initialSent: false, hasOutput: false }],
      );
      const participant = h.app.tasks.records.participants(task)[0];
      assert.ok(participant?.execution);
      assert.equal(h.herdr.sends.length, 1, "The sole participant receives the first input");
      h.herdr.finish(participant.execution.paneId, "SINGLE_DISCUSSION_REPLY");
      await h.app.tasks.reconcile(task.id);
      await h.app.tasks.reconcile(task.id);
      assert.equal(h.herdr.sends.length, 1, "Remaining round budget does not schedule a solo turn");
      const current = h.store.get<Task>("tasks", task.id);
      assert.ok(current);
      assert.equal(current.discussion.rounds, 0);
      assert.equal(current.discussion.paused, false);
      assert.notEqual(current.status, "completed", "A response does not accept the task");
      assert.ok(
        snapshots.some(
          (snapshot) =>
            snapshot.event === "progress" &&
            snapshot.participants.length === 1 &&
            snapshot.participants[0]?.hasOutput === true,
        ),
      );
    } finally {
      await h.close();
    }
  });
}

test("a second round-robin participant supplies a real next speaker", async () => {
  const h = setup();
  const snapshots: NoticeSnapshot[] = [];
  h.engine.handler = async (input) => {
    snapshots.push(JSON.parse(input.prompt));
    return { text: '{"notify":false,"text":""}', messages: [] };
  };
  try {
    const task = (await h.app.dispatch("task.create", {
      kind: "discussion",
      title: "Two participant discussion",
      requirements: "Discuss the requirement, then await acceptance.",
      participants: [{ kind: "claude" }, { kind: "codex" }],
      discussion: { mode: "round_robin", maxRounds: 4, maxMinutes: 30 },
    })) as Task;
    await h.app.tasks.reconcile(task.id);
    const welcome = snapshots.find((snapshot) => snapshot.event === "welcome");
    assert.ok(welcome);
    assert.equal(welcome.participants.length, 2);
    const first = h.app.tasks.records.participants(task)[0];
    assert.ok(first?.execution);
    assert.equal(h.herdr.sends.length, 1);
    h.herdr.finish(first.execution.paneId, "FIRST_DISCUSSION_REPLY");
    await h.app.tasks.reconcile(task.id);
    assert.equal(h.herdr.sends.length, 2);
    const current = h.store.get<Task>("tasks", task.id);
    assert.ok(current);
    const second = h.app.tasks.records.participants(current)[1];
    assert.ok(second);
    assert.equal(current.discussion.activeParticipant, second.id);
    assert.equal(second.initialSent, true);
  } finally {
    await h.close();
  }
});
