import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { InboxRecord } from "../../src/core/inbox.js";
import type { ActorContext, Participant } from "../../src/core/types.js";
import { type OperationReceipt, Operations } from "../../src/storage/operations.js";
import { activeTaskOperation } from "../../src/tasks/operation-scope.js";
import { recordTrustEffect } from "../../src/tasks/readiness.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, createPersistedTask, discussion, setup } from "./helpers.js";

async function fixture() {
  const h = setup();
  const task = await createPersistedTask(h, actor, discussion, {
    orchestration: { mode: "model" },
  });
  await h.service.tick();
  const who: ActorContext = {
    ...actor,
    source: "feishu",
    chatType: "private",
    messageId: "restart-trust",
  };
  h.store.set<InboxRecord>("inbox", "message:restart-trust", {
    id: "message:restart-trust",
    type: "message",
    actor: who,
    payload: {
      ...who,
      source: "feishu",
      chatType: "private",
      eventId: "restart-trust",
      text: "重新拉起参与者后继续",
      mentionedBot: false,
    },
    lane: "owner",
    state: "done",
    sequence: 1,
    createdAt: new Date().toISOString(),
  });
  const participant = h.store.get<Participant>("participants", task.participantIds[0] ?? "");
  assert.ok(participant?.execution);
  return { ...h, task, who, participant };
}

function uncertain(h: ReturnType<typeof setup>, id: string) {
  const receipt: OperationReceipt = {
    id,
    fingerprint: "trust-effect",
    state: "uncertain",
    updatedAt: new Date().toISOString(),
    error: { code: "directory_trust_uncertain", message: "unknown", outcome: "unknown" },
  };
  h.store.set("operations", id, receipt);
  return receipt;
}

for (const format of ["recorded", "legacy", "legacy-bare", "prior-generation"] as const) {
  test(`explicit restart retires selected startup trust without replay (${format})`, async () => {
    const h = await fixture();
    try {
      const p = h.participant;
      h.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
      await assert.rejects(h.service.send(actor, h.task.id, p.id, "old unknown work"));
      const unknownInput = h.store
        .entries<OperationReceipt>("operations")
        .find(([, receipt]) => receipt.state === "uncertain");
      assert.ok(unknownInput);
      const id = `${p.id}:directory-trust${format === "legacy-bare" ? "" : ":effect"}`;
      if (format === "recorded" || format === "prior-generation") recordTrustEffect(h.store, p, id);
      const original = uncertain(h, id);
      assert.ok(p.execution);
      h.herdr.agents.delete(p.execution.paneId);
      if (format === "prior-generation") await h.service.tick();
      const sends = h.herdr.sends.length;
      const result = await h.service.restartParticipants(h.who, h.task.id, [p.id]);
      assert.ok(result.operationIds.includes(id));
      assert.ok(result.operationIds.includes(unknownInput[0]));
      assert.deepEqual(h.store.get("operations", unknownInput[0]), {
        ...unknownInput[1],
        retiredByRestart: result.id,
      });
      const retired = h.store.get<OperationReceipt>("operations", id);
      assert.deepEqual(retired, { ...original, retiredByRestart: result.id });
      assert.ok(retired);
      assert.equal(activeTaskOperation(h.store, h.task, id, retired), false);
      await new TaskService(h.options).tick();
      const active = h.service
        .get(actor, h.task.id)
        .participants.filter((entry) => entry.status !== "removed");
      assert.equal(active.length, h.task.participantIds.length);
      assert.ok(active.every((entry) => entry.started));
      assert.equal(h.herdr.sends.length, sends, "old input and trust keys are not replayed");
    } finally {
      h.close();
    }
  });
}

for (const scope of ["peer", "prefix-collision", "unrelated", "conflicting-owner"] as const) {
  test(`restart refuses unknown effects outside selected trust ownership (${scope})`, async () => {
    const h = await fixture();
    try {
      const selected = h.participant.id;
      const peer = h.task.participantIds[1];
      assert.ok(peer);
      const id =
        scope === "peer"
          ? `${peer}:directory-trust:effect`
          : scope === "prefix-collision"
            ? `${selected}:directory-trust-other:effect`
            : scope === "unrelated"
              ? `${selected}:remote-write`
              : `${selected}:directory-trust:effect`;
      const original = uncertain(h, id);
      if (scope === "conflicting-owner")
        h.store.set("directory_trust_effects", id, {
          participantId: peer,
          generation: "initial",
          at: new Date().toISOString(),
        });
      await assert.rejects(h.service.restartParticipants(h.who, h.task.id, [selected]), {
        code: "restart_effect_unknown",
      });
      assert.equal(h.herdr.closes, 0);
      assert.deepEqual(h.store.get("operations", id), original);
    } finally {
      h.close();
    }
  });
}

test("an in-flight startup trust write cannot be retired or closed underneath", async () => {
  const h = await fixture();
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const id = `${h.participant.id}:directory-trust:in-flight`;
  recordTrustEffect(h.store, h.participant, id);
  const effect = new Operations(h.store).run(id, {}, async () => {
    enter();
    await finish;
    return "confirmed";
  });
  try {
    await entered;
    await assert.rejects(h.service.restartParticipants(h.who, h.task.id, [h.participant.id]), {
      code: "restart_effect_in_flight",
    });
    assert.equal(h.herdr.closes, 0);
    assert.equal(h.store.get<OperationReceipt>("operations", id)?.retiredByRestart, undefined);
    assert.equal(h.store.list("task_restarts").length, 0);
  } finally {
    release();
    await effect;
    h.close();
  }
});

test("unknown closure cannot retire startup trust or create replacements", async () => {
  const h = await fixture();
  try {
    const id = `${h.participant.id}:directory-trust:effect`;
    recordTrustEffect(h.store, h.participant, id);
    const original = uncertain(h, id);
    h.herdr.closeError = new OperationError("close_uncertain", "unknown closure", "unknown");
    await assert.rejects(h.service.restartParticipants(h.who, h.task.id, [h.participant.id]), {
      code: "close_uncertain",
    });
    assert.deepEqual(h.store.get("operations", id), original);
    assert.equal(h.service.get(actor, h.task.id).participants.length, h.task.participantIds.length);
    h.herdr.closeError = undefined;
    await assert.rejects(
      new TaskService(h.options).restartParticipants(h.who, h.task.id, [h.participant.id]),
      { code: "restart_effect_unknown" },
    );
    assert.equal(h.herdr.closes, 1, "unknown close cannot be replayed");
    assert.deepEqual(h.store.get("operations", id), original);
  } finally {
    h.close();
  }
});
