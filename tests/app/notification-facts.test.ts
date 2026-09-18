import assert from "node:assert/strict";
import test from "node:test";
import { notificationParticipants } from "../../src/app/notifications.js";
import type { Task } from "../../src/core/types.js";
import { setup } from "./helpers.js";

test("native done without transcript leaves explicit absent-output facts and waiting-turn receipts", async () => {
  const h = setup();
  const events: Array<{
    event: string;
    task: Task;
    participants: ReturnType<typeof notificationParticipants>;
  }> = [];
  h.config.ui.notifyCooldownMs = 0;
  h.engine.handler = async (turn) => {
    events.push(JSON.parse(turn.prompt));
    return { text: '{"notify":false,"text":""}', messages: [] };
  };
  try {
    const task = (await h.app.dispatch("task.create", {
      kind: "discussion",
      title: "No captured discussion output",
      requirements: "仅讨论",
      participants: [{ kind: "claude" }, { kind: "codex" }],
      discussion: { mode: "round_robin", maxRounds: 1, maxMinutes: 30 },
      createRemoteTask: false,
      keepGroup: true,
    })) as Task;
    await h.app.tasks.reconcile(task.id);
    const participants = h.app.tasks.records.participants(task);
    for (const participant of participants) {
      const agent = h.herdr.agents.get(participant.execution?.paneId ?? "");
      assert.ok(agent);
      agent.status = "done";
      agent.stateSeq = "2";
    }
    await h.app.tasks.reconcile(task.id);
    const event = events.findLast(
      (item) => item.event === "progress" && item.task.status === "review",
    );
    assert.ok(event);
    assert.equal(event.task.discussion.rounds, 0);
    assert.equal(event.task.discussion.maxRounds, 1);
    assert.equal(event.task.discussion.paused, false);
    assert.deepEqual(
      event.participants.map((participant) => ({
        status: participant.status,
        initialSent: participant.initialSent,
        hasOutput: participant.hasOutput,
        lastOutput: participant.lastOutput,
      })),
      [
        { status: "done", initialSent: true, hasOutput: false, lastOutput: null },
        { status: "done", initialSent: false, hasOutput: false, lastOutput: null },
      ],
    );
    const first = participants[0];
    assert.ok(first);
    const withOutput = notificationParticipants([{ ...first, lastOutput: "已采集的观点" }])[0];
    assert.equal(withOutput?.hasOutput, true);
    assert.equal(withOutput?.lastOutput, "已采集的观点");
    assert.ok(!("delivered" in (withOutput ?? {})), "capturing output is not a delivery receipt");
    const noNativeId = notificationParticipants([{ ...first, execution: undefined }])[0];
    assert.equal(noNativeId?.hasNativeSessionId, false);
    assert.equal(noNativeId?.hasOutput, false);
  } finally {
    await h.close();
  }
});
