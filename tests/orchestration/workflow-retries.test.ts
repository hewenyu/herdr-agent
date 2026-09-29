import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { Participant, Task } from "../../src/core/types.js";
import type { DecisionLog } from "../../src/orchestration/decision-log.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { TaskService } from "../../src/tasks/service.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function harness() {
  const h = setup();
  h.config.ai.enabled = true;
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "source.txt"), "unchanged");
  await h.catalog.save({ name: "retries", directories: [repo], agent: "codex" });
  const engine = new Engine();
  const calls = { plan: 0, selection: 0 };
  const fail = { plan: 0, selection: 0 };
  engine.handler = async (input) => {
    const tool = input.tools[0];
    assert.ok(tool);
    const stage = tool.name === "orchestration_plan" ? "plan" : "selection";
    calls[stage]++;
    if (calls[stage] <= fail[stage]) throw new OperationError("model_failed", "temporary refusal");
    if (stage === "plan") {
      await tool.execute(
        { template: "development", instructions: {}, deliveryRequirements: [] },
        input.actor,
      );
    } else {
      assert.equal(tool.name, "orchestration_decide");
      const candidate = JSON.parse(input.prompt).candidates[0];
      await tool.execute(
        { candidateId: candidate.id, reason: "Proceed with legal candidate." },
        input.actor,
      );
    }
    return { text: "", messages: [] };
  };
  const task = await h.service.create(actor, {
    ...discussion,
    kind: "development",
    project: "retries",
    orchestration: { mode: "workflow" },
  });
  // Exercise persisted v2 workflows; v3 integration has its own end-to-end suite.
  task.promptVersion = 2;
  h.service.records.save(task);
  await h.service.reconcile(task.id);
  const control = new AbortController();
  const options = {
    store: h.store,
    engine,
    tasks: () => h.service,
    tools: () => [],
    signal: control.signal,
    logger,
    config: h.config,
    projects: h.catalog,
    retryDelayMs: 0,
    onReply: async () => {},
  };
  const worker = new TaskOrchestrator(options);
  const events = () => h.store.list<OrchestrationEvent>("task_orchestration_events");
  const dispatch = () => {
    const event = events().find((entry) => entry.workflow?.candidate.kind === "dispatch");
    assert.ok(event);
    return event;
  };
  const foreground = (state: "queued" | "done") => {
    h.store.set("inbox", "foreground", {
      id: "foreground",
      type: "message",
      payload: { chatId: task.chatId, text: "新要求待处理" },
      actor: { ...actor, taskId: task.id },
      state,
    });
  };
  return {
    ...h,
    serviceOptions: h.options,
    task,
    engine,
    control,
    options,
    worker,
    events,
    dispatch,
    calls,
    fail,
    foreground,
  };
}

const refuse = () =>
  new OperationError("server_unavailable", "Native input definitely not executed.");

for (const restart of [false, true]) {
  test(`definite input refusal allows initial input plus two retries (restart=${restart})`, async () => {
    const h = await harness();
    try {
      h.herdr.sendError = refuse();
      await h.worker.tick(); // Plan, a separate event with its own attempts.
      await h.worker.tick();
      assert.equal(h.herdr.sends.length, 1);
      assert.equal(h.dispatch().attempts, 1);
      assert.equal(h.dispatch().state, "pending");
      const operationId = h.dispatch().dispatches[0]?.operationId;
      assert.ok(operationId);
      const tick = () => (restart ? new TaskOrchestrator(h.options) : h.worker).tick();
      await tick();
      assert.equal(h.herdr.sends.length, 2);
      assert.equal(h.dispatch().attempts, 2);
      assert.equal(h.dispatch().state, "pending");
      h.herdr.sendError = undefined;
      await tick();
      assert.equal(h.herdr.sends.length, 3);
      assert.equal(h.dispatch().attempts, 3);
      assert.equal(h.dispatch().state, "done");
      assert.equal(h.dispatch().dispatches[0]?.operationId, operationId);
      assert.equal(h.store.get<OperationReceipt>("operations", operationId)?.state, "done");
      assert.equal(h.store.get<{ count: number }>("input_retry_counts", operationId)?.count, 2);
      assert.deepEqual(h.herdr.sends[0], h.herdr.sends[1]);
      assert.deepEqual(h.herdr.sends[1], h.herdr.sends[2]);
      await tick();
      assert.equal(h.herdr.sends.length, 3, "successful durable input must not replay");
    } finally {
      h.close();
    }
  });
}

test("three definite refusals stop at attention without a fourth native input", async () => {
  const h = await harness();
  try {
    h.herdr.sendError = refuse();
    await h.worker.tick();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await new TaskOrchestrator(h.options).tick();
      assert.equal(h.herdr.sends.length, attempt);
      assert.equal(h.dispatch().attempts, attempt);
      assert.equal(h.dispatch().state, attempt === 3 ? "attention" : "pending");
    }
    h.herdr.sendError = undefined;
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.herdr.sends.length, 3);
    assert.equal(h.service.get(actor, h.task.id).status, "attention");
  } finally {
    h.close();
  }
});

test("directory admission waits do not spend the remaining native input retries", async () => {
  const h = await harness();
  try {
    h.herdr.sendError = refuse();
    await h.worker.tick();
    await h.worker.tick();
    const participant = h.service.records.participants(h.task)[0];
    assert.ok(participant);
    const blocker: Task = {
      ...h.task,
      id: "blocking-task",
      participantIds: ["blocking-participant"],
      orchestration: { mode: "manual" },
    };
    h.store.set("tasks", blocker.id, blocker);
    h.store.set<Participant>("participants", "blocking-participant", {
      ...participant,
      id: "blocking-participant",
      taskId: blocker.id,
      status: "working",
    });
    for (let poll = 0; poll < 5; poll++) {
      await new TaskOrchestrator(h.options).tick();
      assert.equal(h.dispatch().attempts, 1);
      assert.equal(h.dispatch().state, "pending");
      assert.equal(h.herdr.sends.length, 1);
    }
    h.store.delete("participants", "blocking-participant");
    h.store.delete("tasks", blocker.id);
    await h.worker.tick();
    assert.equal(h.dispatch().attempts, 2);
    assert.equal(h.herdr.sends.length, 2);
    h.herdr.sendError = undefined;
    await h.worker.tick();
    assert.equal(h.dispatch().attempts, 3);
    assert.equal(h.dispatch().state, "done");
    assert.equal(h.herdr.sends.length, 3);
  } finally {
    h.close();
  }
});

test("unknown input effects immediately need attention and never replay after restart", async () => {
  const h = await harness();
  try {
    h.herdr.sendError = new OperationError(
      "delivery_unconfirmed",
      "No definitive receipt.",
      "unknown",
    );
    await h.worker.tick();
    await h.worker.tick();
    assert.equal(h.dispatch().attempts, 1);
    assert.equal(h.dispatch().state, "attention");
    assert.equal(h.dispatch().dispatches[0]?.state, "uncertain");
    h.herdr.sendError = undefined;
    for (let poll = 0; poll < 4; poll++) await new TaskOrchestrator(h.options).tick();
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.dispatch().attempts, 1);
    assert.equal(h.dispatch().state, "attention");
  } finally {
    h.close();
  }
});

for (const stage of ["plan", "selection"] as const) {
  for (const failures of [2, 3]) {
    test(`${stage} counts each failed attempt once and ${failures === 2 ? "recovers on the third attempt" : "stops after three failures"}`, async () => {
      const h = await harness();
      try {
        h.fail[stage] = failures;
        if (stage === "selection") await h.worker.tick();
        for (let attempt = 1; attempt <= 3; attempt++) {
          await new TaskOrchestrator(h.options).tick();
          const event = h.events().find((entry) => stage === "plan" || !!entry.selectionLogId);
          assert.ok(event);
          assert.equal(event.attempts, attempt);
          assert.equal(
            event.state,
            attempt < 3 ? "pending" : failures === 2 ? "done" : "attention",
          );
        }
        assert.equal(h.calls[stage], 3);
        if (failures === 3) {
          await h.worker.tick();
          assert.equal(h.calls[stage], 3);
          assert.equal(h.herdr.sends.length, 0);
        }
      } finally {
        h.close();
      }
    });
  }
}

test("repeated foreground deferrals retain immutable selection logs and all input retries", async () => {
  const h = await harness();
  try {
    await h.worker.tick();
    const handler = h.engine.handler;
    assert.ok(handler);
    h.engine.handler = async (input) => {
      const result = await handler(input);
      if (input.tools[0]?.name === "orchestration_decide") h.foreground("queued");
      return result;
    };
    const logs: DecisionLog[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      await new TaskOrchestrator(h.options).tick();
      const event = h.events().find((entry) => entry.selectionLogId);
      assert.ok(event?.selectionLogId);
      assert.equal(event.state, "pending");
      assert.equal(event.attempts, 0);
      assert.equal(event.error?.code, "orchestration_deferred");
      assert.equal(h.herdr.sends.length, 0);
      const log = h.store.get<DecisionLog>("workflow_decisions", event.selectionLogId);
      assert.ok(log);
      assert.equal(log.state, "failed");
      logs.push(log);
      h.foreground("done");
    }
    assert.equal(new Set(logs.map((log) => log.eventId)).size, 4);
    h.engine.handler = handler;
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.dispatch().state, "done");
    assert.equal(h.dispatch().attempts, 1);
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.store.list("workflow_decisions").length, 5);
    for (const log of logs) assert.deepEqual(h.store.get("workflow_decisions", log.eventId), log);
  } finally {
    h.close();
  }
});

test("foreground deferral at beforeSend preserves retries after an earlier native refusal", async () => {
  const h = await harness();
  try {
    h.herdr.sendError = refuse();
    await h.worker.tick();
    await h.worker.tick();
    const selectionLogId = h.dispatch().selectionLogId;
    const operationId = h.dispatch().dispatches[0]?.operationId;
    assert.ok(operationId);
    const baseline = h.herdr.sampleLastReply.bind(h.herdr);
    h.herdr.sampleLastReply = async (ref) => {
      const result = await baseline(ref);
      h.foreground("queued");
      return result;
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      await new TaskOrchestrator(h.options).tick();
      assert.equal(h.dispatch().attempts, 1);
      assert.equal(h.dispatch().state, "pending");
      assert.equal(h.dispatch().error?.code, "orchestration_deferred");
      assert.equal(h.herdr.sends.length, 1);
      assert.equal(h.store.get<OperationReceipt>("operations", operationId)?.state, "failed");
      assert.equal(h.store.get<{ count: number }>("input_retry_counts", operationId)?.count, 1);
      h.foreground("done");
    }
    h.herdr.sampleLastReply = baseline;
    await h.worker.tick();
    assert.equal(h.dispatch().attempts, 2);
    assert.equal(h.dispatch().state, "pending");
    assert.equal(h.herdr.sends.length, 2);
    h.herdr.sendError = undefined;
    await h.worker.tick();
    assert.equal(h.dispatch().attempts, 3);
    assert.equal(h.dispatch().state, "done");
    assert.equal(h.herdr.sends.length, 3);
    assert.equal(h.dispatch().selectionLogId, selectionLogId);
    assert.equal(h.calls.selection, 1, "a selected durable choice must not ask the model again");
  } finally {
    h.close();
  }
});

for (const stopped of ["orchestrator", "tasks"] as const) {
  test(`safe ${stopped} shutdown before native input resumes without spending a retry`, async () => {
    const h = await harness();
    try {
      await h.worker.tick();
      const baseline = h.herdr.sampleLastReply.bind(h.herdr);
      h.herdr.sampleLastReply = async (ref) => {
        const result = await baseline(ref);
        if (stopped === "orchestrator") h.control.abort();
        else h.service.stop();
        return result;
      };
      await h.worker.tick();
      const operationId = h.dispatch().dispatches[0]?.operationId;
      assert.ok(operationId);
      assert.equal(h.dispatch().attempts, 0);
      assert.equal(h.dispatch().state, "pending");
      assert.equal(h.dispatch().error?.code, "stopping");
      assert.equal(h.herdr.sends.length, 0);
      assert.equal(h.store.get<OperationReceipt>("operations", operationId)?.state, "failed");
      h.herdr.sampleLastReply = baseline;
      const service = new TaskService(h.serviceOptions);
      await new TaskOrchestrator({
        ...h.options,
        tasks: () => service,
        signal: new AbortController().signal,
      }).tick();
      assert.equal(h.dispatch().attempts, 1);
      assert.equal(h.dispatch().state, "done");
      assert.equal(h.herdr.sends.length, 1);
      assert.equal(h.dispatch().dispatches[0]?.operationId, operationId);
      assert.equal(h.calls.selection, 1);
    } finally {
      h.close();
    }
  });
}

test("abort does not refund an unknown native effect or permit it to replay", async () => {
  const h = await harness();
  try {
    await h.worker.tick();
    h.herdr.sendError = new OperationError(
      "delivery_unconfirmed",
      "Uncertain native effect.",
      "unknown",
    );
    const send = h.herdr.send.bind(h.herdr);
    h.herdr.send = async (ref, text) => {
      h.control.abort();
      return send(ref, text);
    };
    await h.worker.tick();
    assert.equal(h.dispatch().attempts, 1);
    assert.equal(h.dispatch().state, "attention");
    assert.equal(h.dispatch().dispatches[0]?.state, "uncertain");
    h.herdr.sendError = undefined;
    h.herdr.send = send;
    for (let poll = 0; poll < 4; poll++)
      await new TaskOrchestrator({ ...h.options, signal: new AbortController().signal }).tick();
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.dispatch().state, "attention");
    assert.equal(h.dispatch().attempts, 1);
  } finally {
    h.close();
  }
});
