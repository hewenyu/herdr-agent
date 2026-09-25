import assert from "node:assert/strict";
import test from "node:test";
import { discussion } from "../tasks/helpers.js";
import { deferred, setup } from "./helpers.js";

test("clearing a pi session rejects its participant input still queued behind a task lock", async () => {
  const h = setup();
  const release = deferred();
  try {
    const session = h.app.sessions.current("owner", "entry");
    const actor = { ownerId: "owner", sessionId: session.id, chatId: "entry", messageId: "create" };
    const task = await h.app.tasks.create(actor, {
      ...discussion,
      orchestration: { mode: "model" },
      createGroup: false,
      createRemoteTask: false,
    });
    await h.app.tasks.tick();
    const [first, second] = h.app.tasks.get(actor, task.id).participants;
    assert.ok(first && second);
    const entered = deferred();
    const nativeSend = h.herdr.send.bind(h.herdr);
    h.herdr.send = async (ref, text) => {
      entered.resolve();
      await release.promise;
      return nativeSend(ref, text);
    };
    const alreadySubmitted = h.app.tasks.send(
      { ...actor, messageId: "submitted" },
      task.id,
      first.id,
      "already submitted",
    );
    await entered.promise;
    const queued = deferred();
    h.engine.handler = async (input) => {
      const send = input.tools.find((tool) => tool.name === "participant_send");
      assert.ok(send);
      const result = send.execute(
        { taskId: task.id, participantId: second.id, text: "cancel this queued input" },
        input.actor,
        input.signal,
      );
      queued.resolve();
      await result;
      return { text: "finished", messages: [] };
    };
    const turn = h.app.sessions.reply({ ...actor, messageId: "queued" }, "follow up");
    await queued.promise;
    h.app.sessions.clear(actor.ownerId, session.id);
    release.resolve();
    await alreadySubmitted;
    await assert.rejects(turn, { code: "cancelled" });
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.app.tasks.get(actor, task.id).participants[1]?.initialSent, false);
  } finally {
    release.resolve();
    await h.close();
  }
});
