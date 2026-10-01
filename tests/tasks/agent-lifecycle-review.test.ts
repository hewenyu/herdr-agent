import assert from "node:assert/strict";
import test from "node:test";
import type { Task } from "../../src/core/types.js";
import { actor, createPersistedTask, discussion, setup } from "./helpers.js";

const oneParticipant = {
  ...discussion,
  participants: [{ kind: "codex" as const, name: "Codex" }],
};

test("review: a changed execution reference vetoes native launch even within the same generation", async () => {
  const h = setup();
  try {
    const task = await createPersistedTask(h, actor, oneParticipant, {
      orchestration: { mode: "model" },
    });
    h.herdr.startAgent = async (...args) => {
      const current = h.service.records.participants(task)[0];
      assert.ok(current?.execution);
      current.execution.paneId = "changed-pane";
      h.service.records.saveParticipant(current);
      const admission = (args[3] as { beforeWrite?: () => void }).beforeWrite;
      assert.ok(admission);
      admission();
      assert.fail("changed identity must never reach native start");
    };
    await h.service.tick();
    assert.equal(h.herdr.starts, 0);
    assert.equal(h.herdr.sends.length, 0);
    assert.equal(
      h.store.get<{ error?: { code: string } }>("operations", `${task.participantIds[0]}:start`)
        ?.error?.code,
      "lifecycle_revoked",
    );
  } finally {
    h.close();
  }
});

for (const replacement of [false, true]) {
  test(`review: a queued pause vetoes ${replacement ? "replacement" : "initial"} launch without poisoning retry`, async () => {
    const h = setup();
    try {
      const task = await createPersistedTask(h, actor, oneParticipant, {
        orchestration: { mode: "model" },
      });
      if (replacement) {
        await h.service.tick();
        const participant = h.service.get(actor, task.id).participants[0];
        assert.ok(participant?.execution);
        h.herdr.agents.delete(participant.execution.paneId);
      }
      const starts = h.herdr.starts;
      const start = h.herdr.startAgent.bind(h.herdr);
      let pause: Promise<unknown> | undefined;
      h.herdr.startAgent = async (...args) => {
        if (!pause)
          pause = h.service.action({ ...actor, messageId: "pause-at-launch" }, task.id, "pause");
        const admission = (args[3] as { beforeWrite?: () => void }).beforeWrite;
        assert.ok(admission);
        admission();
        return start(...args);
      };
      await h.service.tick();
      await pause;
      assert.equal(h.herdr.starts, starts);
      await h.service.tick();
      assert.equal(h.herdr.starts, starts + 1);
      assert.equal(h.service.get(actor, task.id).discussion.paused, true);
      assert.equal(h.herdr.sends.length, 0);
    } finally {
      h.close();
    }
  });

  test(`review: revocation after workspace allocation fences ${replacement ? "replacement" : "initial"} launch`, async () => {
    const h = setup();
    try {
      const task = await createPersistedTask(h, actor, oneParticipant, {
        orchestration: { mode: "model" },
      });
      if (replacement) {
        await h.service.tick();
        const previous = h.service.get(actor, task.id).participants[0];
        assert.ok(previous?.execution);
        h.herdr.agents.delete(previous.execution.paneId);
      }
      const creates = h.herdr.creates;
      const starts = h.herdr.starts;
      const allocate = h.herdr.createWorkspace.bind(h.herdr);
      h.herdr.createWorkspace = async (...args) => {
        const workspace = await allocate(...args);
        h.config.feishu.allowedOpenIds = [];
        return workspace;
      };
      await h.service.tick();
      await h.service.tick();
      assert.equal(h.herdr.creates, creates + 1);
      assert.equal(
        h.herdr.starts,
        starts,
        "a completed allocation is not continuing launch authority",
      );
      assert.equal(h.herdr.sends.length, 0);
    } finally {
      h.close();
    }
  });
}

test("review: an interrupt before allocation holds only that executor until explicit resume", async () => {
  const h = setup();
  try {
    const task = await createPersistedTask(h, actor, discussion, {
      orchestration: { mode: "model" },
    });
    const held = h.service.get(actor, task.id).participants[0];
    assert.ok(held);
    await h.service.interrupt({ ...actor, messageId: "stop-before-allocation" }, task.id, held.id);
    await h.service.tick();
    assert.equal(h.herdr.creates, 1);
    assert.equal(h.herdr.starts, 1);
    assert.equal(h.service.get(actor, task.id).participants[0]?.execution, undefined);
    assert.equal(h.service.get(actor, task.id).participants[0]?.readiness?.phase, "stopped");
    await h.service.action({ ...actor, messageId: "resume" }, task.id, "resume");
    await h.service.tick();
    assert.equal(h.herdr.starts, 2);
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    h.close();
  }
});

test("review: a named send releases only the selected executor's hold", async () => {
  const h = setup();
  try {
    const task = await createPersistedTask(h, actor, discussion, {
      orchestration: { mode: "model" },
    });
    await h.service.tick();
    const [selected, held] = h.service.get(actor, task.id).participants;
    assert.ok(selected?.execution && held?.execution);
    await h.service.interrupt({ ...actor, messageId: "hold-peer" }, task.id, held.id);
    await h.service.interrupt({ ...actor, messageId: "hold-selected" }, task.id, selected.id);
    await h.service.send(
      { ...actor, messageId: "named-send" },
      task.id,
      selected.name,
      "Fresh input only for the selected executor.",
    );
    h.herdr.agents.delete(held.execution.paneId);
    await h.service.tick();
    assert.equal(h.herdr.creates, 2);
    assert.ok(h.store.get("executor_holds", held.id));
    assert.equal(h.store.get("executor_holds", selected.id), undefined);
  } finally {
    h.close();
  }
});

test("review: a scheduling-only pause allows first provisioning but never the initial business prompt", async () => {
  const h = setup();
  try {
    const task = await createPersistedTask(h, actor, oneParticipant, {
      orchestration: { mode: "manual" },
    });
    task.discussion.paused = true;
    task.status = "review";
    h.service.records.save(task);
    await h.service.tick();
    await h.service.tick();
    const current = h.service.get(actor, task.id);
    assert.equal(h.herdr.creates, 1);
    assert.equal(h.herdr.starts, 1);
    assert.ok(current.participants[0]?.execution);
    assert.equal(current.participants[0]?.started, true);
    assert.equal(current.participants[0]?.initialSent, false);
    assert.equal(current.discussion.paused, true);
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    h.close();
  }
});

test("review: repairing a peer cannot dispatch the original participant's pending initial input", async () => {
  const h = setup();
  try {
    const start = h.herdr.startAgent.bind(h.herdr);
    h.herdr.startAgent = async (...args) => {
      const agent = await start(...args);
      if (h.herdr.starts === 1) {
        agent.status = "blocked";
        h.herdr.agents.set(agent.paneId, agent);
      }
      return agent;
    };
    const task = await createPersistedTask(h, actor, discussion, {
      orchestration: { mode: "manual" },
    });
    await h.service.tick();
    const [first, missing] = h.service.get(actor, task.id).participants;
    assert.ok(first?.execution && missing?.execution);
    assert.equal(first.initialSent, false);
    const native = h.herdr.agents.get(first.execution.paneId);
    assert.ok(native);
    native.status = "idle";
    h.herdr.agents.delete(missing.execution.paneId);
    await h.service.tick();
    await h.service.tick();
    const current = h.service.get(actor, task.id);
    assert.equal(current.participants[1]?.recoveryPending, true);
    assert.equal(current.discussion.paused, true);
    assert.equal(current.participants[0]?.initialSent, false);
    assert.equal(
      h.herdr.sends.length,
      0,
      "repair pause also fences a previously unsent initial prompt",
    );
  } finally {
    h.close();
  }
});

test("review: interrupting one executor does not disable a peer's lifecycle or lose the user scheduling pause", async () => {
  const h = setup();
  try {
    const task = await createPersistedTask(h, actor, discussion, {
      orchestration: { mode: "model" },
    });
    await h.service.tick();
    const [interrupted, missing] = h.service.get(actor, task.id).participants;
    assert.ok(interrupted?.execution && missing?.execution);
    await h.service.interrupt({ ...actor, messageId: "interrupt-one" }, task.id, interrupted.id);
    h.herdr.agents.delete(missing.execution.paneId);
    await h.service.tick();
    const repaired = h.service.get(actor, task.id);
    assert.notEqual(repaired.participants[1]?.execution?.paneId, missing.execution.paneId);
    assert.equal(repaired.participants[1]?.recoveryPending, true);
    assert.equal(repaired.discussion.paused, true);
    await h.service.send(
      { ...actor, messageId: "arrange-peer-only" },
      task.id,
      missing.id,
      "A fresh arrangement for the replaced peer, not a task-wide resume.",
    );
    const current = h.service.get(actor, task.id);
    assert.equal(current.participants[1]?.recoveryPending, false);
    assert.equal(current.discussion.paused, true, "repair must not demote an explicit user pause");
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(current.participants[0]?.execution?.paneId, interrupted.execution.paneId);
    const creates = h.herdr.creates;
    h.herdr.agents.delete(interrupted.execution.paneId);
    await h.service.tick();
    assert.equal(
      h.herdr.creates,
      creates,
      "the peer arrangement must not release the interrupted executor",
    );
    assert.ok(h.store.get("executor_holds", interrupted.id));
  } finally {
    h.close();
  }
});

test("review: resuming business after paused repair is not permission to replay a historical initial prompt", async () => {
  const h = setup();
  try {
    const task = await createPersistedTask(h, actor, oneParticipant, {
      orchestration: { mode: "manual" },
    });
    await h.service.tick();
    const previous = h.service.get(actor, task.id).participants[0];
    assert.ok(previous?.execution);
    assert.equal(previous.initialSent, true);
    const sends = h.herdr.sends.length;
    await h.service.action({ ...actor, messageId: "pause-task" }, task.id, "pause");
    h.herdr.agents.delete(previous.execution.paneId);
    await h.service.tick();
    assert.notEqual(
      h.service.get(actor, task.id).participants[0]?.execution?.paneId,
      previous.execution.paneId,
    );
    await h.service.action({ ...actor, messageId: "resume-task" }, task.id, "resume");
    await h.service.tick();
    const current = h.service.get(actor, task.id);
    assert.equal(current.participants[0]?.recoveryPending, true);
    assert.equal(h.herdr.sends.length, sends);
    assert.equal(h.store.get<Task>("tasks", task.id)?.completionRequest, undefined);
  } finally {
    h.close();
  }
});
