import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { StoredMessage, Task } from "../../src/core/types.js";
import { logger, setup } from "./helpers.js";

const TABLE = "task_orchestration_events";
const question = "需要你提供目标服务地址，才能继续已授权的任务。";
type Harness = ReturnType<typeof setup>;

async function prepare(h: Harness): Promise<Task> {
  h.engine.handler = async (input) => {
    if (!input.sessionId.startsWith("orchestration:"))
      return { text: '{"notify":false,"text":""}', messages: [] };
    const decide = input.tools.find((tool) => tool.name === "orchestration_decide");
    assert.ok(decide);
    await decide.execute({ action: "wait", reason: question }, input.actor);
    return { text: "", messages: [] };
  };
  return h.app.tasks.create(
    { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "request" },
    {
      kind: "development",
      title: "等待必要信息",
      requirements: "请在目标服务上完成任务。",
      project: "project",
      participants: [{ kind: "codex" }],
      orchestration: { mode: "model" },
      createGroup: false,
      createRemoteTask: false,
    },
  );
}

function restart(h: Harness): Application {
  return new Application({
    config: h.config,
    store: h.store,
    herdr: h.herdr,
    engine: h.engine,
    platform: h.platform,
    logger,
  });
}

function waitEvent(h: Harness): OrchestrationEvent {
  const event = h.store
    .list<OrchestrationEvent>(TABLE)
    .find((item) => item.decision?.action === "wait");
  assert.ok(event);
  return event;
}

function notices(h: Harness): StoredMessage[] {
  return h.store
    .list<StoredMessage>("messages")
    .filter((message) => message.source === "orchestration");
}

function decisionCalls(h: Harness): number {
  return h.engine.calls.filter((input) => input.sessionId.startsWith("orchestration:")).length;
}

for (const boundary of ["before_outbox", "after_delivery"] as const)
  test(`a persisted sending checkpoint resumes the wait notice ${boundary} without duplicate delivery`, async () => {
    const h = setup();
    let restarted: Application | undefined;
    let checkpoint: { event: OrchestrationEvent; task: Task } | undefined;
    try {
      const task = await prepare(h);
      const crash = () => {
        const event = waitEvent(h);
        const current = h.store.get<Task>("tasks", task.id);
        assert.ok(current);
        assert.equal(event.notificationState, "sending");
        assert.equal(event.notified, undefined);
        checkpoint = { event, task: current };
        throw new OperationError("simulated_crash", "stopped at durable checkpoint", "unknown");
      };
      if (boundary === "before_outbox") {
        const send = h.app.outbox.send.bind(h.app.outbox);
        h.app.outbox.send = async (...args) => {
          if (args[1] === question) crash();
          return send(...args);
        };
      } else {
        const record = h.app.sessions.recordExternal.bind(h.app.sessions);
        h.app.sessions.recordExternal = (...args) => {
          if (args[1].source === "orchestration") crash();
          return record(...args);
        };
      }
      await h.app.tick();
      await h.app.shutdown();
      assert.ok(checkpoint);
      // Restore exactly the durable records captured when a process could die;
      // the test's exception unwinding is not part of that crashed process.
      h.store.set(TABLE, checkpoint.event.id, checkpoint.event);
      h.store.set("tasks", task.id, checkpoint.task);
      const outboxId = `orchestration:${task.id}:${checkpoint.event.id}`;
      assert.equal(
        h.app.outbox.receipt(outboxId)?.state,
        boundary === "before_outbox" ? undefined : "delivered",
      );
      assert.equal(notices(h).length, 0);
      const modelCalls = decisionCalls(h);
      restarted = restart(h);
      await Promise.all([restarted.tick(), restarted.tick()]);
      await restarted.tick();
      const recovered = waitEvent(h);
      assert.equal(recovered.notificationState, "sent");
      assert.equal(recovered.notified, true);
      assert.equal(recovered.state, "done");
      assert.equal(decisionCalls(h), modelCalls, "a saved decision must not rerun the model");
      assert.equal(h.platform.texts.filter((message) => message.text === question).length, 1);
      assert.equal(restarted.outbox.receipt(outboxId)?.state, "delivered");
      const history = notices(h);
      assert.equal(history.length, 1);
      assert.equal(history[0]?.text, question);
      assert.equal(history[0]?.delivery, "delivered");
      assert.deepEqual(history[0]?.deliveryIds, [outboxId]);
      assert.equal(h.herdr.sends.length, 0, "waiting for user information never dispatches work");
    } finally {
      await restarted?.shutdown();
      await h.close();
    }
  });

for (const state of ["sending", "uncertain"] as const)
  test(`an existing ${state} wait envelope never authorizes another notification`, async () => {
    const h = setup();
    let restarted: Application | undefined;
    let attempts = 0;
    let checkpoint: OrchestrationEvent | undefined;
    try {
      const task = await prepare(h);
      const send = h.platform.sendText.bind(h.platform);
      h.platform.sendText = async (...args) => {
        if (args[1] === question) {
          attempts++;
          checkpoint = waitEvent(h);
          throw new OperationError("ack_lost", "message acknowledgement lost", "unknown");
        }
        return send(...args);
      };
      await h.app.tick();
      await h.app.shutdown();
      const event = waitEvent(h);
      const outboxId = `orchestration:${task.id}:${event.id}`;
      const outbound = h.store.get<Record<string, unknown>>("outbox", outboxId);
      assert.ok(outbound);
      assert.ok(checkpoint);
      assert.equal(checkpoint.notificationState, "sending");
      h.store.set("outbox", outboxId, { ...outbound, state });
      h.store.set(TABLE, event.id, checkpoint);
      const modelCalls = decisionCalls(h);
      restarted = restart(h);
      await Promise.all([restarted.tick(), restarted.tick()]);
      await restarted.tick();
      assert.equal(attempts, 1);
      assert.equal(waitEvent(h).notificationState, "uncertain");
      assert.equal(waitEvent(h).notified, undefined);
      assert.equal(restarted.outbox.receipt(outboxId)?.state, state);
      assert.equal(notices(h).length, 0);
      assert.equal(decisionCalls(h), modelCalls);
      assert.equal(h.herdr.sends.length, 0);
    } finally {
      await restarted?.shutdown();
      await h.close();
    }
  });
