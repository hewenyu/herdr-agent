import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { ActorContext, Delivery, Task } from "../../src/core/types.js";
import { dispatchProof } from "../../src/orchestration/dispatch-proof.js";
import type { RuntimeTool } from "../../src/runtime/types.js";
import { type OperationReceipt, Operations } from "../../src/storage/operations.js";
import {
  applyUncertainResolution,
  listUncertainEffects,
} from "../../src/tasks/uncertain-effects.js";
import { actor, discussion, setup } from "../tasks/helpers.js";
import { Engine, logger } from "./helpers.js";
import { persistLegacyModelTask } from "./legacy-model-helpers.js";

const TABLE = "task_orchestration_events";
const unknownDelivery: Delivery = {
  status: "unconfirmed",
  acked: false,
  verified: false,
  attempts: 1,
};
const provenDelivery: Delivery = {
  status: "delivered",
  acked: true,
  verified: true,
  attempts: 1,
};
const at = () => new Date().toISOString();

function events(h: ReturnType<typeof setup>, taskId: string): OrchestrationEvent[] {
  return h.store
    .list<OrchestrationEvent>(TABLE)
    .filter((entry) => entry.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function abandon(
  h: { store: Parameters<typeof listUncertainEffects>[0] },
  taskId: string,
  operationId: string,
  decidedBy: "user" | "pi" | "evidence" = "user",
): void {
  const task = h.store.get<Task>("tasks", taskId);
  assert.ok(task);
  const effect = listUncertainEffects(h.store, task).find((entry) => entry.id === operationId);
  assert.ok(effect, "the unknown effect must be visible before deciding");
  assert.equal(effect.kind, "input_delivery");
  applyUncertainResolution(h.store, effect, {
    choice: "abandon",
    decidedBy,
    reason: "用户放弃这次结果未知的投递。",
  });
}

/**
 * Model-mode orchestrator over the real Store/Operations with fake ports. The
 * reconciliation path under test (`reconcileDispatches`) is the production one.
 */
async function modelHarness() {
  const h = setup();
  h.config.ai.enabled = true;
  const engine = new Engine();
  const task = await h.service.create(actor, {
    ...discussion,
    kind: "development",
    requirements: "Codex 与 Claude 协作交付功能，只修改授权文件。",
    orchestration: { mode: "model" },
  });
  persistLegacyModelTask(h.store, task);
  await h.service.reconcile(task.id);
  const tools = (_actor: ActorContext): RuntimeTool[] => [
    {
      name: "task_get",
      description: "read",
      readOnly: true,
      parameters: {},
      execute: async (_args, ctx) => h.service.get(ctx, task.id),
    },
    {
      name: "participant_send",
      description: "send",
      readOnly: false,
      parameters: {},
      execute: async (args, ctx) =>
        h.service.send(ctx, task.id, String(args.participantId), String(args.text)),
    },
  ];
  const options = {
    store: h.store,
    engine,
    tasks: () => h.service,
    tools,
    signal: new AbortController().signal,
    logger,
    retryDelayMs: 0,
    onReply: async () => {},
  };
  const worker = new TaskOrchestrator(options);
  const participant = h.service.records.participants(task)[0];
  assert.ok(participant);
  const latest = () => {
    const list = events(h, task.id);
    const last = list.at(-1);
    assert.ok(last);
    return last;
  };
  const first = () => {
    const [event] = events(h, task.id);
    assert.ok(event);
    return event;
  };
  const dispatch = (event: OrchestrationEvent) => {
    const value = event.dispatches[0];
    assert.ok(value);
    return value;
  };
  /** Round one: the participant input's delivery outcome stays unknown. */
  const openUnknown = async () => {
    h.herdr.delivery = unknownDelivery;
    engine.handler = async (input) => {
      const tool = input.tools.find((entry) => entry.name === "participant_send");
      assert.ok(tool);
      await tool.execute({ participantId: participant.id, text: "执行原任务" }, input.actor);
      return { text: "", messages: [] };
    };
    await worker.tick();
    const event = latest();
    assert.equal(event.state, "attention");
    assert.equal(event.error?.code, "orchestration_delivery_unknown");
    assert.equal(dispatch(event).state, "uncertain");
    return event;
  };
  return { ...h, engine, options, task, participant, worker, latest, first, dispatch, openUnknown };
}

/** The next tick may only decide; it must never send while an input is unknown. */
function waitThen(reason: string) {
  return async (input: Parameters<NonNullable<Engine["handler"]>>[0]) => {
    const tool = input.tools.find((entry) => entry.name === "orchestration_decide");
    assert.ok(tool);
    await tool.execute({ action: "wait", reason }, input.actor);
    return { text: "", messages: [] };
  };
}

/**
 * Workflow-mode orchestrator: its runner calls `TaskService.send` with the
 * persisted dispatch operation id, so `Operations.run`'s one-retry authority and
 * in-flight guards are exercised for real.
 */
async function workflowHarness() {
  const h = setup();
  h.config.ai.enabled = true;
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "source.txt"), "unchanged");
  await h.catalog.save({ name: "resolved-dispatch", directories: [repo], agent: "codex" });
  const engine = new Engine();
  engine.handler = async (input) => {
    if (
      input.tools[0]?.name === "orchestration_choice" &&
      JSON.parse(input.prompt).candidates.some(
        (candidate: { id: string }) => candidate.id === "use_template",
      )
    ) {
      await input.tools[0].execute({ candidateId: "request_pi" }, input.actor);
      return { text: "", messages: [] };
    }
    const tool = input.tools[0];
    assert.ok(tool);
    if (tool.name === "orchestration_plan")
      await tool.execute(
        { template: "development", instructions: {}, deliveryRequirements: [] },
        input.actor,
      );
    else {
      const candidate = JSON.parse(input.prompt).candidates[0] as { id: string };
      await tool.execute({ candidateId: candidate.id }, input.actor);
    }
    return { text: "", messages: [] };
  };
  const task = await h.service.create(actor, {
    ...discussion,
    kind: "development",
    project: "resolved-dispatch",
    orchestration: { mode: "workflow" },
  });
  task.promptVersion = 2;
  h.service.records.save(task);
  await h.service.reconcile(task.id);
  const options = {
    store: h.store,
    engine,
    tasks: () => h.service,
    tools: () => [],
    signal: new AbortController().signal,
    logger,
    config: h.config,
    projects: h.catalog,
    retryDelayMs: 0,
    onReply: async () => {},
  };
  const tick = () => new TaskOrchestrator(options).tick();
  const event = () => {
    const result = events(h, task.id).find(
      (entry) => entry.workflow?.candidate.kind === "dispatch",
    );
    assert.ok(result);
    return result;
  };
  const dispatch = () => {
    const value = event().dispatches[0];
    assert.ok(value);
    return value;
  };
  /** Open the first unknown dispatch and reconcile it without replaying. */
  const openUnknown = async () => {
    await tick();
    h.herdr.delivery = unknownDelivery;
    await tick();
    await tick();
    assert.equal(event().state, "attention");
    assert.equal(event().error?.code, "orchestration_delivery_unknown");
    assert.deepEqual(
      event().dispatches.map((entry) => entry.state),
      ["uncertain"],
    );
    assert.equal(h.herdr.sends.length, 1);
    return dispatch().operationId;
  };
  return { ...h, engine, options, task, tick, event, dispatch, openUnknown };
}

test("an abandoned unknown dispatch is never sent or replayed and stops blocking the task", async () => {
  const h = await modelHarness();
  try {
    const unknown = await h.openUnknown();
    const operationId = h.dispatch(unknown).operationId;
    abandon(h, h.task.id, operationId);
    h.engine.handler = waitThen("原投递已被用户放弃，等待新的安排。");
    await h.worker.tick();
    const settled = h.latest();
    assert.deepEqual(
      settled.dispatches.map((entry) => entry.state),
      ["failed"],
      "a resolved abandon is settled as non-delivered, never as sent",
    );
    assert.equal(settled.state, "done");
    assert.equal(settled.error, undefined);
    assert.equal(h.herdr.sends.length, 1, "abandon is not a delivery and is never resent");
    // Repeated ticks, including a fresh orchestrator over the same store, must not
    // replay the identity, resend, or re-open the round.
    await h.worker.tick();
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.latest().state, "done");
    assert.equal(h.latest().dispatches[0]?.state, "failed");
    const receipt = h.store.get<OperationReceipt>("operations", operationId);
    assert.equal(receipt?.state, "uncertain", "the historical unknown outcome is preserved");
    assert.equal(receipt?.resolution?.choice, "abandon");
  } finally {
    h.close();
  }
});

test("an unresolved unknown dispatch still blocks and is never resent", async () => {
  const h = await modelHarness();
  try {
    await h.openUnknown();
    for (let poll = 0; poll < 3; poll++) {
      await h.worker.tick();
      await new TaskOrchestrator(h.options).tick();
    }
    const blocked = h.latest();
    assert.equal(blocked.state, "attention");
    assert.equal(blocked.error?.code, "orchestration_delivery_unknown");
    assert.equal(h.dispatch(blocked).state, "uncertain");
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.engine.calls.length, 1, "the model must not be re-entered while unknown");
  } finally {
    h.close();
  }
});

test("a settled abandon still lets a later user revision proceed", async () => {
  const h = await modelHarness();
  try {
    const unknown = await h.openUnknown();
    abandon(h, h.task.id, h.dispatch(unknown).operationId);
    h.engine.handler = waitThen("已结算的放弃不再阻塞后续修订。");
    await h.worker.tick();
    assert.equal(h.latest().state, "done");
    // The service-level projection must lift the block that a bare abandon used
    // to leave behind: a fresh reconcile recomputes task status from the settled
    // receipt, which keeps its historical unknown outcome and its resolution.
    await h.service.reconcile(h.task.id);
    const settled = h.service.get(actor, h.task.id);
    assert.notEqual(settled.status, "attention");
    assert.equal(settled.pending, undefined);
    assert.equal(settled.error, undefined);
    const current = h.service.records.get(actor, h.task.id);
    current.requirements += "\n追加：改为验证新的方案。";
    h.service.records.save(current);
    await h.worker.tick();
    const revised = h.latest();
    assert.notEqual(revised.id, unknown.id, "a new revision opens its own round");
    assert.equal(revised.trigger, "user_revision");
    assert.equal(revised.state, "done");
    assert.equal(revised.dispatches.length, 0, "the abandoned input is not replayed for it");
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    h.close();
  }
});

test("audited retirement supersedes an earlier unused workflow retry authorization", async () => {
  const h = await workflowHarness();
  try {
    const operationId = await h.openUnknown();
    new Operations(h.store).resolve(operationId, {
      choice: "retry",
      decidedBy: "user",
      reason: "One retry before replacement.",
      at: at(),
    });
    const receipt = h.store.get<OperationReceipt>("operations", operationId);
    assert.ok(receipt);
    const retired = { ...receipt, retiredByRestart: "completed-replacement" };
    h.store.set("operations", operationId, retired);
    h.store.set("task_restarts", "completed-replacement", {
      id: "completed-replacement",
      taskId: h.task.id,
      state: "done",
      operationIds: [operationId],
    });
    h.herdr.delivery = provenDelivery;
    for (let poll = 0; poll < 2; poll++) await h.tick();
    assert.equal(h.herdr.sends.length, 1, "replacement revokes the old input's unused retry");
    assert.equal(h.dispatch().state, "failed");
    assert.deepEqual(h.store.get("operations", operationId), retired);
  } finally {
    h.close();
  }
});

test("a workflow dispatch abandoned by the user is never re-attempted", async () => {
  const h = await workflowHarness();
  try {
    const operationId = await h.openUnknown();
    abandon(h, h.task.id, operationId);
    // The workflow runner owns this dispatch: its own guard must refuse to
    // re-enter the effect rather than letting `Operations.run` throw and the
    // round linger in attention on a `failed` dispatch.
    for (let poll = 0; poll < 3; poll++) await h.tick();
    assert.equal(h.herdr.sends.length, 1, "an abandoned dispatch is never re-attempted");
    assert.deepEqual(
      h.event().dispatches.map((entry) => entry.state),
      ["failed"],
      "the dispatch is settled as not delivered",
    );
    assert.notEqual(h.event().error?.code, "operation_abandoned");
    const receipt = h.store.get<OperationReceipt>("operations", operationId);
    assert.equal(receipt?.state, "uncertain");
    assert.equal(receipt?.resolution?.choice, "abandon");
  } finally {
    h.close();
  }
});

test("an explicit retry reuses the exact identity once and preserves the original receipt", async () => {
  const h = await workflowHarness();
  try {
    const operationId = await h.openUnknown();
    const original = h.store.get<OperationReceipt>("operations", operationId);
    assert.ok(original);
    assert.equal(original.state, "uncertain");
    new Operations(h.store).resolve(operationId, {
      choice: "retry",
      decidedBy: "user",
      reason: "用户明确要求再试一次。",
      at: at(),
    });
    h.herdr.delivery = provenDelivery;
    await h.tick();
    assert.equal(h.herdr.sends.length, 2, "the one authorized retry reaches native send");
    assert.equal(
      h.herdr.sends[0]?.text,
      h.herdr.sends[1]?.text,
      "the exact original input is reused",
    );
    assert.equal(h.dispatch().operationId, operationId, "no new operation identity");
    assert.equal(h.dispatch().state, "sent");
    assert.equal(h.event().state, "done");
    const receipt = h.store.get<OperationReceipt>("operations", operationId);
    assert.equal(receipt?.state, "done");
    assert.equal(receipt?.fingerprint, original.fingerprint);
    assert.equal(receipt?.resolution, undefined);
    assert.equal(receipt?.history?.length, 1);
    assert.equal(receipt?.history?.[0]?.resolution?.choice, "retry");
    await h.tick();
    assert.equal(h.herdr.sends.length, 2, "a proven send is never replayed");
  } finally {
    h.close();
  }
});

test("a spent retry keeps the unknown blocking and a second retry is refused", async () => {
  const h = await workflowHarness();
  try {
    const operationId = await h.openUnknown();
    new Operations(h.store).resolve(operationId, {
      choice: "retry",
      decidedBy: "user",
      reason: "用户明确要求再试一次。",
      at: at(),
    });
    await h.tick();
    assert.equal(h.herdr.sends.length, 2, "the retry itself is the second attempt");
    const receipt = h.store.get<OperationReceipt>("operations", operationId);
    assert.equal(receipt?.state, "uncertain", "the retried attempt is still unknown");
    assert.equal(receipt?.history?.length, 1);
    assert.equal(receipt?.history?.[0]?.resolution?.choice, "retry");
    assert.throws(
      () =>
        new Operations(h.store).resolve(operationId, {
          choice: "retry",
          decidedBy: "user",
          reason: "再试一次。",
          at: at(),
        }),
      { code: "operation_retry_exhausted" },
    );
    for (let poll = 0; poll < 2; poll++) await h.tick();
    assert.equal(h.event().state, "attention");
    assert.equal(h.event().error?.code, "orchestration_delivery_unknown");
    assert.equal(h.dispatch().state, "uncertain");
    assert.equal(h.herdr.sends.length, 2, "the spent retry is never replayed");
  } finally {
    h.close();
  }
});

test("a dispatch retired by an audited restart is never replayed", async () => {
  const h = await modelHarness();
  try {
    const unknown = await h.openUnknown();
    const operationId = h.dispatch(unknown).operationId;
    const receipt = h.store.get<OperationReceipt>("operations", operationId);
    assert.ok(receipt);
    // Exactly what restartParticipants persists for a retired attempt.
    h.store.set("operations", operationId, { ...receipt, retiredByRestart: "restart-record" });
    h.store.set("task_restarts", "restart-record", {
      id: "restart-record",
      taskId: h.task.id,
      state: "done",
      operationIds: [operationId],
      eventIds: [unknown.id],
      at: at(),
    });
    h.engine.handler = waitThen("旧投递已随重启退休，等待新的安排。");
    await h.worker.tick();
    const settled = h.latest();
    assert.deepEqual(
      settled.dispatches.map((entry) => entry.state),
      ["failed"],
      "a retired dispatch is settled without claiming delivery",
    );
    assert.equal(settled.error?.code, undefined);
    assert.equal(h.herdr.sends.length, 1, "a retired dispatch is never replayed");
    await h.worker.tick();
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.herdr.sends.length, 1);
    const retired = h.store.get<OperationReceipt>("operations", operationId);
    assert.equal(retired?.retiredByRestart, "restart-record");
    assert.equal(retired?.state, "uncertain");
  } finally {
    h.close();
  }
});

for (const defect of [
  "null receipt",
  "unknown failed outcome",
  "null retirement",
  "missing restart",
  "unfinished restart",
  "unrelated restart",
  "unbound restart",
  "string restart bindings",
  "null restart bindings",
  "mixed restart bindings",
  "mismatched done identity",
  "incomplete abandon",
]) {
  test(`unproven dispatch settlement (${defect}) retains the unknown barrier`, async () => {
    const h = await modelHarness();
    try {
      const event = await h.openUnknown();
      const id = h.dispatch(event).operationId;
      const receipt = h.store.get<OperationReceipt>("operations", id);
      assert.ok(receipt);
      const damaged: Record<string, unknown> = { ...receipt };
      if (defect === "unknown failed outcome") {
        damaged.state = "failed";
        damaged.error = { code: "unconfirmed", message: "unknown", outcome: "unknown" };
      } else if (defect === "mismatched done identity") {
        damaged.id = "another-operation";
        damaged.state = "done";
      } else if (defect === "incomplete abandon") {
        damaged.resolution = { choice: "abandon" };
      } else if (defect !== "null receipt") {
        damaged.retiredByRestart = defect === "null retirement" ? null : "review-restart";
        if (defect !== "missing restart" && defect !== "null retirement") {
          h.store.set("task_restarts", "review-restart", {
            taskId: defect === "unrelated restart" ? "another-task" : h.task.id,
            state: defect === "unfinished restart" ? "pending" : "done",
            operationIds:
              defect === "unbound restart"
                ? []
                : defect === "string restart bindings"
                  ? id
                  : defect === "null restart bindings"
                    ? null
                    : defect === "mixed restart bindings"
                      ? [null, id]
                      : [id],
          });
        }
      }
      const value = defect === "null receipt" ? null : damaged;
      h.store.set("operations", id, value);
      assert.equal(dispatchProof(h.store, h.task, id), "unknown");
      h.engine.handler = waitThen("未知投递不得被未证明的结算解除。");
      await h.worker.tick();
      await new TaskOrchestrator(h.options).tick();
      const blocked = h.first();
      assert.equal(h.dispatch(blocked).state, "uncertain");
      assert.equal(blocked.state, "attention");
      assert.equal(h.engine.calls.length, 1, "no new model work through an unknown barrier");
      assert.equal(h.herdr.sends.length, 1);
      assert.deepEqual(h.store.get("operations", id), value);
    } finally {
      h.close();
    }
  });
}
