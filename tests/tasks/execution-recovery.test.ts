import assert from "node:assert/strict";
import test from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import { TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/types.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { Operations } from "../../src/storage/operations.js";
import type { ExecutionRecovery } from "../../src/tasks/execution-recovery.js";
import { TaskService } from "../../src/tasks/service.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, createPersistedTask, discussion, setup } from "./helpers.js";

function recoveryOf(f: ReturnType<typeof setup>, participantId: string): ExecutionRecovery {
  const participant = f.store.get<{ executionRecovery?: string }>("participants", participantId);
  assert.ok(participant?.executionRecovery, "participant has a durable repair journal");
  const recovery = f.store.get<ExecutionRecovery>(
    "execution_recoveries",
    participant.executionRecovery,
  );
  assert.ok(recovery);
  return recovery;
}

/** Reflect a genuine user control (pause action/interrupt) that lands outside the mutation lock. */
function userPause(f: ReturnType<typeof setup>, taskId: string): void {
  const revision = (f.store.get<number>("task_pause_revision", taskId) ?? 0) + 1;
  f.store.set("task_pause_revision", taskId, revision);
  f.store.set("task_user_pause_revision", taskId, revision);
  const task = f.store.get<Task>("tasks", taskId);
  assert.ok(task);
  task.discussion.paused = true;
  task.status = "paused";
  f.store.set("tasks", taskId, task);
}

function lifecycleIngress(f: ReturnType<typeof setup>, remoteTaskId: string, id: string): void {
  f.store.set<InboxRecord>("inbox", id, {
    id,
    type: "task",
    payload: { id: remoteTaskId },
    state: "processing",
    lane: "task",
    sequence: 2,
    createdAt: new Date().toISOString(),
  });
}

for (const kind of ["claude", "codex"] as const) {
  for (const mode of ["manual", "model", "workflow"] as const) {
    test(`${kind}/${mode}: missing execution is rebuilt once, without old input or identity changes`, async () => {
      const f = setup();
      try {
        const task = await createPersistedTask(
          f,
          actor,
          { ...discussion, participants: [{ kind, name: kind }] },
          mode === "manual" ? { discussionMode: "manual" } : { orchestration: { mode } },
        );
        await f.service.tick();
        const before = f.service.get(actor, task.id).participants[0]!;
        f.herdr.agents.delete(before.execution!.paneId);
        const sends = f.herdr.sends.length;
        const oldOperations = f.store.entries<OperationReceipt>("operations");
        await f.service.tick();
        await new TaskService(f.options).tick();
        const current = f.service.get(actor, task.id);
        const after = current.participants[0]!;
        assert.equal(after.id, before.id);
        assert.notEqual(after.execution?.paneId, before.execution?.paneId);
        assert.notEqual(after.initialReceipt, before.initialReceipt);
        assert.equal(after.initialSent, before.initialSent);
        assert.equal(after.started, true);
        assert.equal(after.recoveryPending, true);
        assert.equal(after.status, "idle");
        assert.equal(after.initialDelivery, "pending");
        assert.equal(current.status, "attention");
        assert.equal(current.discussion.paused, true);
        assert.equal(f.herdr.creates, 2);
        assert.equal(f.herdr.starts, 2);
        assert.equal(f.herdr.closes, 0);
        assert.equal(f.herdr.sends.length, sends);
        for (const [id, receipt] of oldOperations)
          assert.deepEqual(f.store.get("operations", id), receipt);
        const recovery = recoveryOf(f, after.id);
        assert.equal(recovery.previous.execution?.paneId, before.execution?.paneId);
        assert.equal(recovery.previous.initialReceipt, before.initialReceipt);
        assert.equal(recovery.state, "ready");
        await assert.rejects(
          f.service.send({ ...actor, source: "system" }, task.id, after.id, "old scheduled work"),
          { code: "execution_recovered" },
        );
        assert.equal(f.herdr.sends.length, sends);
        await f.service.send(
          { ...actor, messageId: "fresh-arrangement" },
          task.id,
          after.id,
          "新的安排",
        );
        assert.equal(f.herdr.sends.length, sends + 1);
        assert.equal(f.service.get(actor, task.id).participants[0]?.recoveryPending, false);
        assert.match(f.herdr.sends.at(-1)!.text, /新的安排/);
      } finally {
        f.close();
      }
    });
  }
}

test("a finished repair never authorizes the automatic orchestrator to resume scheduling", async () => {
  const f = setup();
  try {
    const task = await createPersistedTask(f, actor, discussion, {
      orchestration: { mode: "model" },
    });
    await f.service.tick();
    const before = f.service.get(actor, task.id).participants[0]!;
    f.herdr.agents.delete(before.execution!.paneId);
    await f.service.tick();
    assert.equal(f.service.get(actor, task.id).participants[0]?.recoveryPending, true);
    const orchestrator = new TaskOrchestrator({
      config: f.config,
      projects: f.catalog,
      store: f.store,
      engine: new Engine(),
      tasks: () => f.service,
      tools: () => [],
      signal: new AbortController().signal,
      logger,
    });
    const sends = f.herdr.sends.length;
    await orchestrator.tick();
    // `discussion.paused` + recoveryPending keep currentOrchestrationTask from
    // returning the task, so no dispatch or input can be produced.
    assert.equal(f.store.list("task_orchestration_events").length, 0);
    assert.equal(f.herdr.sends.length, sends);
  } finally {
    f.close();
  }
});

test("a fresh user arrangement releases the repair pause and lets automatic scheduling resume", async () => {
  const f = setup();
  try {
    const task = await createPersistedTask(f, actor, discussion, {
      orchestration: { mode: "model" },
    });
    await f.service.tick();
    const before = f.service.get(actor, task.id).participants[0]!;
    f.herdr.agents.delete(before.execution!.paneId);
    await f.service.tick();
    const repairing = f.service.get(actor, task.id);
    assert.equal(repairing.discussion.paused, true);
    assert.equal(repairing.participants[0]?.recoveryPending, true);
    await f.service.send({ ...actor, messageId: "fresh" }, task.id, before.id, "新的安排");
    const released = f.service.get(actor, task.id);
    assert.equal(released.participants[0]?.recoveryPending, false);
    assert.equal(released.participants[0]?.initialSent, true);
    assert.equal(released.discussion.paused, false, "the automatic repair pause is released");
    assert.equal(released.error, undefined);
    assert.equal(released.status, "running");
    // The task is schedulable again: after the fresh turn settles, the automatic
    // orchestrator observes it and produces the next scheduling event.
    f.herdr.finish(released.participants[0]!.execution!.paneId, "新的安排已完成");
    await f.service.tick();
    const orchestrator = new TaskOrchestrator({
      config: f.config,
      projects: f.catalog,
      store: f.store,
      engine: new Engine(),
      tasks: () => f.service,
      tools: () => [],
      signal: new AbortController().signal,
      logger,
    });
    await orchestrator.tick();
    assert.equal(f.store.list("task_orchestration_events").length, 1);
  } finally {
    f.close();
  }
});

test("a fresh user arrangement never releases an explicit user pause", async () => {
  const f = setup();
  try {
    const task = await createPersistedTask(f, actor, discussion, {
      orchestration: { mode: "model" },
    });
    await f.service.tick();
    const before = f.service.get(actor, task.id).participants[0]!;
    f.herdr.agents.delete(before.execution!.paneId);
    await f.service.tick();
    await f.service.action({ ...actor, messageId: "pause" }, task.id, "pause");
    // A queued user message arriving while paused cannot resume work.
    await f.service
      .send({ ...actor, messageId: "fresh-while-paused" }, task.id, before.id, "新的安排")
      .catch(() => undefined);
    const latest = f.service.get(actor, task.id);
    assert.equal(latest.status, "paused");
    assert.equal(latest.discussion.paused, true);
    assert.equal(latest.participants[0]?.recoveryPending, true);
    assert.equal(f.store.list("task_orchestration_events").length, 0);
  } finally {
    f.close();
  }
});

test("persisted gone and unknown delivery remain historical unknown after execution repair", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const participant = f.service.get(actor, task.id).participants[0]!;
    f.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    await assert.rejects(f.service.send(actor, task.id, participant.id, "uncertain old work"));
    const settledSends = f.herdr.sends.length;
    const receipts = f.store.entries<OperationReceipt>("operations");
    const deliveries = f.store.entries("input_deliveries");
    // Model the persisted observation of a previous service run: gone participant,
    // attention + paused task, and no repair journal yet.
    const before = f.store.get<import("../../src/core/types.js").Participant>(
      "participants",
      participant.id,
    )!;
    before.status = "gone";
    before.error = "参与者执行现场已不存在。";
    f.store.set("participants", before.id, before);
    const stored = f.store.get<Task>("tasks", task.id)!;
    stored.status = "attention";
    stored.discussion.paused = true;
    f.store.set("tasks", task.id, stored);
    f.herdr.agents.delete(before.execution!.paneId);
    await new TaskService(f.options).tick();
    const after = f.service.get(actor, task.id).participants[0]!;
    assert.notEqual(after.execution?.paneId, before.execution?.paneId);
    assert.equal(after.recoveryPending, true);
    assert.equal(f.herdr.sends.length, settledSends);
    for (const [id, receipt] of receipts) assert.deepEqual(f.store.get("operations", id), receipt);
    assert.deepEqual(f.store.entries("input_deliveries"), deliveries);
    assert.ok(receipts.some(([, receipt]) => receipt.state === "uncertain"));
    assert.equal(f.service.get(actor, task.id).discussion.paused, true);
    assert.equal(f.service.get(actor, task.id).status, "attention");
  } finally {
    f.close();
  }
});

for (const effect of ["create", "start"] as const) {
  for (const state of ["pending", "uncertain"] as const) {
    test(`${state} recovery ${effect} never repeats across restart`, async () => {
      const f = setup();
      try {
        const task = await f.service.create(actor, discussion);
        await f.service.tick();
        const before = f.service.get(actor, task.id).participants[0]!;
        f.herdr.agents.delete(before.execution!.paneId);
        if (effect === "create")
          f.herdr.createError = new OperationError("timeout", "unknown creation", "unknown");
        else {
          const start = f.herdr.startAgent.bind(f.herdr);
          f.herdr.startAgent = async (...args) => {
            f.herdr.starts++;
            if (f.herdr.starts > 2) throw new OperationError("timeout", "unknown start", "unknown");
            return start(...args);
          };
        }
        await f.service.tick();
        const failed = f.store
          .entries<OperationReceipt>("operations")
          .find(([id, receipt]) => id.includes(":recovery:") && receipt.state === "uncertain")!;
        assert.ok(failed);
        if (state === "pending") f.store.set("operations", failed[0], { ...failed[1], state });
        const counts = [f.herdr.creates, f.herdr.starts];
        const sends = f.herdr.sends.length;
        f.herdr.createError = undefined;
        await new TaskService(f.options).tick();
        await f.service.tick();
        assert.deepEqual([f.herdr.creates, f.herdr.starts], counts);
        assert.equal(f.store.list("execution_recoveries").length, 1);
        assert.equal(f.herdr.sends.length, sends);
        assert.equal(f.service.get(actor, task.id).status, "attention");
      } finally {
        f.close();
      }
    });
  }
}

test("a definitely-refused recovery create is retried without duplicating the generation", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const before = f.service.get(actor, task.id).participants[0]!;
    f.herdr.agents.delete(before.execution!.paneId);
    f.herdr.createError = new OperationError("rate_limited", "not executed", "not_executed");
    await f.service.tick();
    const failed = f.store
      .entries<OperationReceipt>("operations")
      .find(([id, receipt]) => id.includes(":recovery:") && receipt.state === "failed");
    assert.ok(failed, "a definite refusal is recorded as failed");
    const recoveries = f.store.list("execution_recoveries").length;
    const creates = f.herdr.creates;
    f.herdr.createError = undefined;
    await f.service.tick();
    assert.equal(f.store.list("execution_recoveries").length, recoveries);
    assert.equal(
      f.herdr.creates,
      creates + 1,
      "the same generation retries its refused create once",
    );
    assert.ok(f.service.get(actor, task.id).participants[0]?.started);
  } finally {
    f.close();
  }
});

for (const mode of [
  "paused",
  "completed",
  "close",
  "removed",
  "timeout",
  "foreign",
  "not_found",
  "interrupt",
] as const) {
  test(`${mode} does not authorize execution replacement`, async () => {
    const f = setup();
    try {
      const task = await f.service.create(actor, discussion);
      await f.service.tick();
      const before = f.service.get(actor, task.id).participants[0]!;
      if (mode === "paused" || mode === "completed") {
        const stored = f.store.get<Task>("tasks", task.id)!;
        stored.status = mode;
        stored.keepGroup = true;
        f.store.set("tasks", task.id, stored);
        if (mode === "completed") f.platform.tasks.get(stored.remoteTaskId!)!.completedAt = "123";
      } else if (mode === "close") {
        const stored = f.store.get<Task>("tasks", task.id)!;
        stored.closeRequested = true;
        f.store.set("tasks", task.id, stored);
      } else if (mode === "removed") {
        f.store.set("participants", before.id, { ...before, status: "removed" });
      } else if (mode === "interrupt") {
        await f.service.interrupt(actor, task.id, before.id);
      }
      if (mode === "foreign") f.herdr.agents.get(before.execution!.paneId)!.workspaceId = "foreign";
      else if (mode === "timeout" || mode === "not_found")
        f.herdr.getError = new OperationError(mode, "read failed");
      else f.herdr.agents.delete(before.execution!.paneId);
      const counts = [f.herdr.creates, f.herdr.starts];
      await f.service.tick();
      await new TaskService(f.options).tick();
      assert.deepEqual([f.herdr.creates, f.herdr.starts], counts);
      assert.equal(f.store.list("execution_recoveries").length, 0);
    } finally {
      f.close();
    }
  });
}

test("a missing agent with a surviving shell is replaced in a new workspace, never in that shell", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const before = f.service.get(actor, task.id).participants[0]!;
    f.herdr.agents.delete(before.execution!.paneId);
    f.herdr.paneExists = async () => true;
    const start = f.herdr.startAgent.bind(f.herdr);
    f.herdr.startAgent = async (...args) => {
      assert.notEqual(args[0], before.execution!.paneId);
      return start(...args);
    };
    await f.service.tick();
    assert.equal(f.herdr.creates, 3);
    assert.equal(f.herdr.starts, 3);
    assert.equal(f.herdr.closes, 0);
  } finally {
    f.close();
  }
});

test("a lifecycle ingress arriving during recovery create is deferred, then resumes the recorded workspace", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, {
      ...discussion,
      participants: [{ kind: "codex", name: "Codex" }],
    });
    await f.service.tick();
    const before = f.service.get(actor, task.id).participants[0]!;
    const remoteTaskId = f.service.get(actor, task.id).remoteTaskId!;
    f.herdr.agents.delete(before.execution!.paneId);
    const create = f.herdr.createWorkspace.bind(f.herdr);
    f.herdr.createWorkspace = async (cwd: string) => {
      const workspace = await create(cwd);
      lifecycleIngress(f, remoteTaskId, "lifecycle-during-create");
      return workspace;
    };
    const starts = f.herdr.starts;
    await f.service.tick();
    const held = f.service.get(actor, task.id).participants[0]!;
    // The allocated pane is durable even though the start was deferred, so cleanup can
    // always close it; nothing is started and no input is replayed.
    assert.equal(f.herdr.starts, starts);
    assert.equal(held.execution?.paneId, "p2");
    assert.equal(held.started, false);
    assert.equal(held.recoveryPending, true);
    assert.equal(recoveryOf(f, held.id).state, "building");
    const record = f.store.get<InboxRecord>("inbox", "lifecycle-during-create");
    assert.ok(record);
    f.store.set("inbox", "lifecycle-during-create", { ...record, state: "done" });
    await new TaskService(f.options).tick();
    const resumed = f.service.get(actor, task.id).participants[0]!;
    assert.equal(resumed.started, true);
    assert.equal(resumed.execution?.paneId, "p2");
    assert.equal(f.herdr.starts, starts + 1);
    assert.equal(f.store.list("execution_recoveries").length, 1);
  } finally {
    f.close();
  }
});

test("a user control queued during recovery start freezes the generation until the user resumes", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, {
      ...discussion,
      participants: [{ kind: "codex", name: "Codex" }],
    });
    await f.service.tick();
    const before = f.service.get(actor, task.id).participants[0]!;
    f.herdr.agents.delete(before.execution!.paneId);
    const start = f.herdr.startAgent.bind(f.herdr);
    let interrupt: Promise<void> | undefined;
    f.herdr.startAgent = async (...args) => {
      const agent = await start(...args);
      // A user control queued behind the task lock while the repair is running.
      interrupt ??= f.service.interrupt({ ...actor, messageId: "stop-mid-start" }, task.id, "all");
      return agent;
    };
    await f.service.tick();
    await interrupt;
    const frozen = f.service.get(actor, task.id);
    // An interrupt keeps the automatic-attention status but is a user control.
    assert.equal(frozen.discussion.paused, true);
    assert.equal(frozen.participants[0]?.started, false);
    assert.equal(frozen.participants[0]?.recoveryPending, true);
    assert.equal(recoveryOf(f, frozen.participants[0]!.id).state, "building");
    const started = f.herdr.starts;
    await new TaskService(f.options).tick();
    assert.equal(f.herdr.starts, started, "a user pause cannot be overridden by the repair");
    await f.service.action({ ...actor, messageId: "resume-recovery" }, task.id, "resume");
    await f.service.tick();
    const resumed = f.service.get(actor, task.id).participants[0]!;
    assert.equal(resumed.started, true);
    assert.equal(
      f.herdr.starts,
      started,
      "the already-recorded start receipt is reused, never duplicated",
    );
    assert.equal(f.store.list("execution_recoveries").length, 1);
    assert.equal(recoveryOf(f, resumed.id).state, "ready");
  } finally {
    f.close();
  }
});

test("a rebuilt generation refuses to replay a historical result left by a crash", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, {
      ...discussion,
      participants: [{ kind: "codex", name: "Codex" }],
    });
    await f.service.tick();
    const participant = f.service.get(actor, task.id).participants[0]!;
    const request = { ...actor, messageId: "old-arrangement-request" };
    // The user's arrangement crossed the native write but the result was lost.
    f.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    await assert.rejects(f.service.send(request, task.id, participant.id, "old arrangement"));
    const uncertain = f.store
      .entries<OperationReceipt>("operations")
      .find(([id, receipt]) => id.startsWith(`${task.id}:send:`) && receipt.state === "uncertain");
    assert.ok(uncertain, "the old delivery keeps its unknown receipt");
    f.herdr.delivery = { status: "delivered", acked: true, verified: true, attempts: 1 };
    f.herdr.agents.delete(participant.execution!.paneId);
    await f.service.tick();
    const rebuilt = f.service.get(actor, task.id).participants[0]!;
    assert.equal(rebuilt.recoveryPending, true);
    const sends = f.herdr.sends.length;
    await assert.rejects(f.service.send(request, task.id, rebuilt.id, "old arrangement"), {
      code: "operation_conflict",
    });
    assert.equal(
      f.herdr.sends.length,
      sends,
      "the old operation id is never sent to the replacement",
    );
    assert.equal(f.service.get(actor, task.id).participants[0]?.recoveryPending, true);
    assert.deepEqual(f.store.get("operations", uncertain[0]), uncertain[1]);
  } finally {
    f.close();
  }
});

test("old operation receipts are never replayed or rewritten by a rebuild", async () => {
  const f = setup();
  try {
    const task = await f.service.create(actor, {
      ...discussion,
      participants: [{ kind: "codex", name: "Codex" }],
    });
    await f.service.tick();
    const participant = f.service.get(actor, task.id).participants[0]!;
    const initialId = `${participant.id}:initial`;
    const initialReceipt = participant.initialReceipt;
    const initialResult = f.store.get<OperationReceipt>("operations", initialId)?.result;
    f.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    await assert.rejects(f.service.send(actor, task.id, participant.id, "unknown old input"));
    const uncertain = f.store
      .entries<OperationReceipt>("operations")
      .find(([id, receipt]) => id.startsWith(`${task.id}:send:`) && receipt.state === "uncertain");
    assert.ok(uncertain);
    const snapshot = f.store.entries<OperationReceipt>("operations");
    f.herdr.agents.delete(participant.execution!.paneId);
    await f.service.tick();
    for (const [id, receipt] of snapshot)
      assert.deepEqual(f.store.get("operations", id), receipt, `receipt ${id} unchanged`);
    const operations = new Operations(f.store);
    // A confirmed historical result is returned from the audit, never re-executed.
    assert.deepEqual(
      await operations.run(initialId, { receipt: initialReceipt }, async () => {
        assert.fail("a confirmed initial receipt must never be replayed");
      }),
      initialResult,
    );
    // An unknown historical delivery stays unknown and blocks auto replay.
    await assert.rejects(
      operations.run(
        uncertain[0],
        { participant: participant.id, text: "unknown old input" },
        async () => {
          assert.fail("an unknown delivery must never be replayed");
        },
      ),
      { code: "operation_uncertain" },
    );
    assert.deepEqual(f.store.get("operations", uncertain[0]), uncertain[1]);
  } finally {
    f.close();
  }
});
