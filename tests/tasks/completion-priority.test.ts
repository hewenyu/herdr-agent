import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import type { TaskHooks } from "../../src/tasks/context.js";
import { participantPrompt } from "../../src/tasks/prompts.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

async function exitedAfterUnknownInput(hooks: TaskHooks = {}) {
  const h = setup(hooks);
  try {
    h.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    const task = await h.service.create(actor, {
      ...discussion,
      participants: [{ kind: "codex", name: "Codex" }],
    });
    await h.service.tick();
    const current = h.service.get(actor, task.id);
    const participant = current.participants[0];
    assert.ok(participant?.execution);
    assert.equal(current.status, "attention");
    assert.equal(participant.initialSent, false);
    const operationId = `${participant.id}:initial`;
    assert.equal(h.store.get<OperationReceipt>("operations", operationId)?.state, "uncertain");
    h.herdr.agents.delete(participant.execution.paneId);
    // The runtime adapter has independently verified the exited owned pane and
    // found no exact native user-input receipt. Absence is not delivery success.
    (h.herdr as HerdrPort).initialInput = async () => undefined;
    const remote = h.platform.tasks.get(current.remoteTaskId ?? "");
    assert.ok(remote);
    return { ...h, task: current, participant, remote, operationId };
  } catch (error) {
    h.close();
    throw error;
  }
}

for (const source of ["remote", "action", "group"] as const) {
  test(`${source} completion/cleanup closes an exited executor with unknown first input without replaying or claiming delivery`, async () => {
    const h = await exitedAfterUnknownInput();
    try {
      if (source === "remote") h.remote.completedAt = "native-user-completed";
      else if (source === "action")
        await h.service.action({ ...actor, messageId: "complete" }, h.task.id, "complete");
      else Object.assign(h.platform, { getGroupStatus: async () => "dissolved" as const });
      const restored = new TaskService(h.options);
      await restored.reconcile(h.task.id);
      const current = restored.get(actor, h.task.id);
      assert.equal(current.status, "destroyed");
      assert.equal(current.participants[0]?.status, "gone");
      assert.equal(current.participants[0]?.initialSent, false);
      assert.equal(h.store.get<OperationReceipt>("operations", h.operationId)?.state, "uncertain");
      assert.deepEqual([h.herdr.starts, h.herdr.sends.length, h.herdr.closes], [1, 1, 1]);
      assert.equal(h.platform.deletions, source === "group" ? 0 : 1);
      assert.equal(!!current.completedAt, source !== "group");
      assert.equal(h.remote.completedAt === "0", source === "group");
      assert.match(h.remote.description, /状态：destroyed/);
      assert.match(h.remote.description, /Codex\(codex\): gone/);
      assert.doesNotMatch(h.remote.description, /会话：https/);
      await restored.tick();
      assert.equal(h.herdr.closes, 1);
      assert.equal(h.herdr.sends.length, 1);
    } finally {
      h.close();
    }
  });
}

test("failed initial recovery cannot starve interval-based remote completion observation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-18T00:00:00Z") });
  const h = await exitedAfterUnknownInput();
  let reads = 0;
  const get = h.platform.getTask.bind(h.platform);
  h.platform.getTask = async (id) => {
    reads++;
    return get(id);
  };
  try {
    (h.herdr as HerdrPort).initialInput = async () => {
      throw new OperationError("transcript_unavailable", "native evidence temporarily unreadable");
    };
    await h.service.tick();
    assert.equal(reads, 1, "remote is read before failing local recovery");
    assert.equal(h.service.get(actor, h.task.id).status, "attention");
    h.remote.completedAt = "native-user-completed";
    t.mock.timers.tick(1_000);
    await h.service.tick();
    assert.equal(reads, 1, "a recovery error does not bypass the remote polling interval");
    t.mock.timers.tick(29_000);
    await h.service.tick();
    assert.equal(reads, 2);
    const closing = h.service.get(actor, h.task.id);
    assert.equal(closing.completedAt, "native-user-completed");
    assert.equal(closing.status, "destroying");
    assert.equal(h.herdr.closes, 0, "unreadable final evidence still blocks destructive cleanup");
    assert.equal(h.platform.deletions, 0);
    (h.herdr as HerdrPort).initialInput = async () => undefined;
    t.mock.timers.tick(1_000);
    await h.service.tick();
    assert.equal(h.service.get(actor, h.task.id).status, "destroyed");
    assert.equal(reads, 3, "only the new final description needs another GET");
    assert.deepEqual([h.herdr.sends.length, h.herdr.closes, h.platform.deletions], [1, 1, 1]);
    assert.equal(h.store.get<OperationReceipt>("operations", h.operationId)?.state, "uncertain");
  } finally {
    h.close();
  }
});

test("external completion survives a directory failure without trying to reprovision the task", async () => {
  const h = await exitedAfterUnknownInput();
  try {
    h.catalog.verifyDirectories = async () => {
      throw new OperationError("directory_missing", "must not reprovision");
    };
    h.remote.completedAt = "native-user-completed";
    await h.service.reconcile(h.task.id);
    assert.equal(h.service.get(actor, h.task.id).status, "destroyed");
    assert.equal(h.herdr.starts, 1);
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    h.close();
  }
});

test("exact recovered input and final output must be preserved and delivered before closing the exited pane", async () => {
  const outputs: string[] = [];
  const h = await exitedAfterUnknownInput({
    output: async (_task, _participant, entry) => {
      outputs.push(entry.text);
      throw new OperationError("delivery_unknown", "final output is not confirmed", "unknown");
    },
  });
  try {
    const expectedInput = participantPrompt(h.task, h.participant);
    (h.herdr as HerdrPort).initialInput = async () => expectedInput;
    h.herdr.finish(h.participant.execution?.paneId ?? "", "final result after actual input");
    h.remote.completedAt = "native-user-completed";
    await h.service.reconcile(h.task.id);
    const current = h.service.get(actor, h.task.id);
    assert.equal(current.completedAt, "native-user-completed");
    assert.equal(current.status, "destroying");
    assert.equal(
      current.participants[0]?.initialSent,
      true,
      "only exact native input confirms delivery",
    );
    assert.equal(h.store.get<OperationReceipt>("operations", h.operationId)?.state, "done");
    assert.match(current.result, /final result after actual input/);
    assert.deepEqual(outputs, ["final result after actual input"]);
    assert.equal(h.store.list("pending_outputs").length, 1);
    assert.deepEqual([h.herdr.sends.length, h.herdr.closes, h.platform.deletions], [1, 0, 0]);
  } finally {
    h.close();
  }
});

test("remote completion never overrides a replaced execution identity during cleanup", async () => {
  const h = await exitedAfterUnknownInput();
  try {
    (h.herdr as HerdrPort).initialInput = async () => {
      throw new OperationError("target_changed", "execution was replaced");
    };
    h.remote.completedAt = "native-user-completed";
    await h.service.reconcile(h.task.id);
    const current = h.service.get(actor, h.task.id);
    assert.equal(current.completedAt, "native-user-completed");
    assert.equal(current.status, "destroying");
    assert.deepEqual([h.herdr.sends.length, h.herdr.closes, h.platform.deletions], [1, 0, 0]);
    assert.equal(h.store.get<OperationReceipt>("operations", h.operationId)?.state, "uncertain");
  } finally {
    h.close();
  }
});

test("early lifecycle GET is reused to project output collected later in the same tick", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-18T00:00:00Z") });
  const h = setup();
  let reads = 0;
  const get = h.platform.getTask.bind(h.platform);
  h.platform.getTask = async (id) => {
    reads++;
    return get(id);
  };
  try {
    const task = await h.service.create(actor, {
      ...discussion,
      discussion: { mode: "manual" },
    });
    await h.service.tick();
    assert.equal(reads, 1);
    h.herdr.finish("p1", "fresh output after the remote snapshot");
    t.mock.timers.tick(h.config.tasks.pollIntervalMs);
    await h.service.tick();
    assert.equal(reads, 2, "one remote read per ordinary polling interval");
    const current = h.service.get(actor, task.id);
    assert.match(current.result, /fresh output/);
    const remote = h.platform.tasks.get(current.remoteTaskId ?? "");
    assert.match(remote?.description ?? "", /fresh output/);
    assert.match(remote?.description ?? "", /Claude\(claude\): done/);
  } finally {
    h.close();
  }
});
