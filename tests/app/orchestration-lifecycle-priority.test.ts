import assert from "node:assert/strict";
import test from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { actor, discussion, setup } from "../tasks/helpers.js";
import { deferred, Engine, logger } from "./helpers.js";

async function harness(mode: "model" | "workflow" = "model") {
  const h = setup();
  h.config.ai.enabled = true;
  const created = await h.service.create(actor, { ...discussion, orchestration: { mode } });
  created.promptVersion = 2;
  h.service.records.save(created);
  await h.service.reconcile(created.id);
  const task = h.service.get(actor, created.id);
  const participant = task.participants[0];
  assert.ok(participant?.execution && task.remoteTaskId && task.chatId);
  const engine = new Engine();
  engine.handler = async (input) => {
    if (mode === "model") {
      const send = input.tools.find((tool) => tool.name === "participant_send");
      assert.ok(send);
      await send.execute({ participantId: participant.id, text: "继续讨论原任务" }, input.actor);
    } else {
      const tool = input.tools[0];
      assert.ok(tool);
      await tool.execute(
        tool.name === "orchestration_plan"
          ? { template: "discussion", instructions: {}, deliveryRequirements: [] }
          : { candidateId: JSON.parse(input.prompt).candidates[0].id, reason: "继续本轮" },
        input.actor,
      );
    }
    return { text: "", messages: [] };
  };
  const options = {
    store: h.store,
    config: h.config,
    projects: h.catalog,
    tasks: () => h.service,
    tools: () => [
      {
        name: "participant_send",
        description: "send",
        readOnly: false,
        parameters: {},
        execute: async () => ({}),
      },
    ],
    engine,
    signal: new AbortController().signal,
    logger,
    retryDelayMs: 0,
  };
  const worker = new TaskOrchestrator(options);
  let sequence = 0;
  const ingress = (type: "task" | "group", state: InboxRecord["state"], unrelated = false) => {
    const id = `lifecycle:${++sequence}`;
    const record: InboxRecord = {
      id,
      type,
      state,
      sequence,
      lane: id,
      createdAt: new Date().toISOString(),
      payload: {
        id: unrelated
          ? "unrelated"
          : type === "task"
            ? (task.remoteTaskId as string)
            : (task.chatId as string),
      },
    };
    h.store.set("inbox", id, record);
    return record;
  };
  const done = (record: InboxRecord) =>
    h.store.set("inbox", record.id, { ...record, state: "done" });
  const events = () => h.store.list<OrchestrationEvent>("task_orchestration_events");
  return { ...h, task, participant, engine, options, worker, ingress, done, events };
}

for (const mode of ["model", "workflow"] as const)
  for (const type of ["task", "group"] as const)
    for (const state of ["queued", "processing"] as const)
      test(`${mode} waits for ${state} ${type} ingress before planning, including restart`, async () => {
        const h = await harness(mode);
        try {
          const record = h.ingress(type, state);
          await h.worker.tick();
          await new TaskOrchestrator(h.options).tick();
          assert.equal(h.engine.calls.length, 0);
          assert.equal(h.herdr.sends.length, 0);
          await h.service.reconcile(h.task.id);
          h.done(record);
          await h.worker.tick();
          if (mode === "workflow") await h.worker.tick();
          assert.ok(h.herdr.sends.length > 0, "a verified harmless update resumes work");
        } finally {
          h.close();
        }
      });

for (const mode of ["model", "workflow"] as const)
  test(`${mode} discards in-flight planning even when the lifecycle event was already handled`, async () => {
    const h = await harness(mode);
    const entered = deferred();
    const release = deferred();
    const handler = h.engine.handler;
    assert.ok(handler);
    try {
      h.engine.handler = async (input) => {
        entered.resolve();
        await release.promise;
        return handler(input);
      };
      const running = h.worker.tick();
      await entered.promise;
      const record = h.ingress("task", "queued");
      await h.service.reconcile(h.task.id);
      h.done(record);
      release.resolve();
      await running;
      assert.equal(h.herdr.sends.length, 0);
      assert.equal(h.store.list("workflow_plans").length, 0);
      assert.equal(h.events()[0]?.attempts, 0, "admission deferral is not a model failure");
      await h.worker.tick();
      if (mode === "workflow") await h.worker.tick();
      assert.ok(h.herdr.sends.length > 0);
    } finally {
      release.resolve();
      h.close();
    }
  });

test("an accepted completion vetoes a send while its event worker waits for the same task lock", async () => {
  const h = await harness();
  const entered = deferred();
  const release = deferred();
  const sample = h.herdr.sampleLastReply.bind(h.herdr);
  let hold = true;
  try {
    h.herdr.sampleLastReply = async (ref) => {
      if (hold) {
        hold = false;
        entered.resolve();
        await release.promise;
      }
      return sample(ref);
    };
    const running = h.worker.tick();
    await entered.promise;
    const remote = h.platform.tasks.get(h.task.remoteTaskId as string);
    assert.ok(remote);
    remote.completedAt = "1790648811982";
    const record = h.ingress("task", "processing");
    let reconciled = false;
    const closing = h.service.reconcile(h.task.id).then(() => {
      reconciled = true;
    });
    await Promise.resolve();
    assert.equal(reconciled, false);
    release.resolve();
    await Promise.all([running, closing]);
    h.done(record);
    assert.equal(h.herdr.sends.length, 0);
    assert.equal(h.service.get(actor, h.task.id).status, "destroyed");
    const operation = h.store.get<OperationReceipt>(
      "operations",
      h.events()[0]?.dispatches[0]?.operationId as string,
    );
    assert.equal(operation?.error?.outcome, "not_executed");
  } finally {
    release.resolve();
    h.close();
  }
});

test("unrelated lifecycle ingress is ignored, while failed relevant reads recover after a successful poll", async () => {
  const h = await harness();
  try {
    h.ingress("task", "queued", true);
    h.ingress("group", "processing", true);
    const record = h.ingress("task", "processing");
    h.platform.getError = new OperationError("remote_read_failed", "temporary remote read failure");
    await h.service.reconcile(h.task.id);
    h.done(record);
    assert.ok(h.service.get(actor, h.task.id).syncError);
    await h.worker.tick();
    assert.equal(h.engine.calls.length, 0);
    h.platform.getError = undefined;
    await h.service.reconcile(h.task.id);
    assert.equal(h.service.get(actor, h.task.id).syncError, undefined);
    await h.worker.tick();
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    h.close();
  }
});

test("an in-flight model cannot overwrite a durable restart retirement when its late tool is rejected", async () => {
  const h = await harness();
  const entered = deferred();
  const release = deferred();
  const handler = h.engine.handler;
  assert.ok(handler);
  try {
    h.engine.handler = async (input) => {
      entered.resolve();
      await release.promise;
      return handler(input);
    };
    const running = h.worker.tick();
    await entered.promise;
    const event = h.events()[0];
    assert.ok(event);
    h.store.set("task_orchestration_events", event.id, {
      ...event,
      state: "superseded",
      retiredByRestart: "restart-record",
    });
    h.store.set("task_mutation_revisions", "restart-record", {
      taskId: h.task.id,
      action: "participant_restart",
      participantId: h.participant.id,
      at: new Date().toISOString(),
    });
    release.resolve();
    await running;
    const retired = h.store.get<OrchestrationEvent>("task_orchestration_events", event.id);
    assert.equal(retired?.retiredByRestart, "restart-record");
    assert.equal(retired?.state, "superseded");
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    release.resolve();
    h.close();
  }
});

for (const verified of [true, false])
  test(`completion after native write preserves the actual ${verified ? "verified" : "unknown"} outcome`, async () => {
    const h = await harness();
    const native = h.herdr.send.bind(h.herdr);
    try {
      (h.herdr as HerdrPort).send = async (ref, text, options) => {
        options?.assertCurrent?.();
        const result = await native(ref, text);
        h.ingress("task", "queued");
        return { ...result, verified, status: verified ? "delivered" : "unconfirmed" };
      };
      await h.worker.tick();
      const operationId = h.events()[0]?.dispatches[0]?.operationId;
      assert.ok(operationId);
      assert.equal(
        h.store.get<OperationReceipt>("operations", operationId)?.state,
        verified ? "done" : "uncertain",
      );
      await h.worker.tick();
      assert.equal(h.herdr.sends.length, 1);
    } finally {
      h.close();
    }
  });
