import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import { OperationError } from "../../src/core/errors.js";
import type { StoredMessage, Task, TranscriptEntry } from "../../src/core/types.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup as taskSetup } from "../tasks/helpers.js";
import { logger, setup } from "./helpers.js";

interface PendingOutput {
  taskId: string;
  participantId: string;
  entry: TranscriptEntry;
  delivery?: "sending" | "retryable" | "uncertain";
  error?: { code: string; message: string; outcome: string };
}

type Harness = ReturnType<typeof setup>;
const result = "原生输出的完整正文";

async function prepare(h: Harness): Promise<Task> {
  h.engine.handler = async () => ({ text: '{"notify":false,"text":""}', messages: [] });
  const task = await h.app.tasks.create(actor, {
    ...discussion,
    participants: [{ kind: "codex" }],
    createGroup: false,
    createRemoteTask: false,
  });
  await h.app.tasks.reconcile(task.id);
  const participant = h.app.tasks.records.participants(task)[0];
  assert.ok(participant?.execution);
  h.herdr.finish(participant.execution.paneId, result);
  return task;
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

function outputHistory(h: Harness): StoredMessage[] {
  return h.store.list<StoredMessage>("messages").filter((message) => message.source === "herdr");
}

for (const boundary of ["before_outbox", "prepared", "retryable", "delivered"] as const)
  test(`pending output checkpoint resumes after restart with ${boundary} receipt proof`, async () => {
    const h = setup();
    let restarted: Application | undefined;
    let checkpoint: [string, PendingOutput] | undefined;
    let attempts = 0;
    const set = h.store.set.bind(h.store);
    const network = h.platform.sendText.bind(h.platform);
    try {
      const task = await prepare(h);
      const capture = () => {
        checkpoint = h.store.entries<PendingOutput>("pending_outputs")[0];
        assert.ok(checkpoint);
        assert.equal(checkpoint[1].delivery, "sending");
      };
      const crash = () => {
        capture();
        throw new OperationError("simulated_crash", "stopped at durable checkpoint", "unknown");
      };
      h.platform.sendText = async (...args) => {
        if (args[1]?.includes(result)) {
          attempts++;
          if (boundary === "retryable") {
            capture();
            throw new OperationError("feishu_http_429", "本次平台调用未执行", "not_executed");
          }
        }
        return network(...args);
      };
      if (boundary === "before_outbox") {
        const send = h.app.outbox.send.bind(h.app.outbox);
        h.app.outbox.send = async (...args) => {
          if (args[2].startsWith("output:")) crash();
          return send(...args);
        };
      } else if (boundary === "prepared") {
        h.store.set = (namespace, key, value) => {
          set(namespace, key, value);
          if (
            namespace === "outbox" &&
            key.startsWith("output:") &&
            (value as { state?: string }).state === "prepared"
          )
            crash();
        };
      } else if (boundary === "delivered") {
        const record = h.app.sessions.recordExternal.bind(h.app.sessions);
        h.app.sessions.recordExternal = (...args) => {
          if (args[1].source === "herdr") crash();
          return record(...args);
        };
      }
      await h.app.tasks.reconcile(task.id);
      await h.app.shutdown();
      h.store.set = set;
      h.platform.sendText = async (...args) => {
        if (args[1]?.includes(result)) attempts++;
        return network(...args);
      };
      assert.ok(checkpoint);
      const [key, pending] = checkpoint;
      const outputId = `output:${task.id}:${pending.participantId}:${key}`;
      assert.equal(
        h.app.outbox.receipt(outputId)?.state,
        boundary === "before_outbox" ? undefined : boundary,
      );
      assert.equal(outputHistory(h).length, 0);
      // Restore the exact sending checkpoint; exception unwinding after a
      // simulated process death is not part of its durable state.
      h.store.set("pending_outputs", key, pending);
      restarted = restart(h);
      await restarted.tasks.reconcile(task.id);
      await restarted.tasks.reconcile(task.id);
      assert.equal(h.store.get("pending_outputs", key), undefined);
      assert.equal(restarted.outbox.receipt(outputId)?.state, "delivered");
      assert.equal(h.platform.texts.filter((message) => message.text.includes(result)).length, 1);
      assert.equal(attempts, boundary === "retryable" ? 2 : 1);
      assert.equal(outputHistory(h).length, 1);
      assert.equal(outputHistory(h)[0]?.delivery, "delivered");
      assert.equal(h.herdr.sends.length, 1, "native execution is never repeated for chat recovery");
      await restarted.tasks.action({ ...actor, messageId: "complete" }, task.id, "complete");
      await restarted.tasks.reconcile(task.id);
      assert.equal(h.herdr.closes, 1, "confirmed output releases the cleanup barrier");
    } finally {
      h.store.set = set;
      await restarted?.shutdown();
      await h.close();
    }
  });

test("real sending and uncertain output receipts remain frozen across restart and preserve cleanup", async () => {
  const h = setup();
  let restarted: Application | undefined;
  let attempts = 0;
  let outputId = "";
  let sending: Record<string, unknown> | undefined;
  try {
    const task = await prepare(h);
    h.platform.sendText = async (_chat, text) => {
      if (text?.includes(result)) {
        attempts++;
        const entry = h.store
          .entries<Record<string, unknown>>("outbox")
          .find(([id]) => id.startsWith("output:"));
        assert.ok(entry);
        [outputId, sending] = entry;
        throw new OperationError("ack_lost", "输出ACK未知", "unknown");
      }
      return "notice";
    };
    await h.app.tasks.reconcile(task.id);
    assert.ok(sending);
    const uncertain = h.store.get("outbox", outputId);
    await h.app.shutdown();
    h.store.set("outbox", outputId, sending);
    restarted = restart(h);
    await restarted.tasks.reconcile(task.id);
    assert.equal(attempts, 1);
    h.store.set("outbox", outputId, uncertain);
    await restarted.tasks.action({ ...actor, messageId: "complete" }, task.id, "complete");
    await restarted.tasks.reconcile(task.id);
    assert.equal(attempts, 1);
    assert.equal(h.store.list("pending_outputs").length, 1);
    assert.equal(h.herdr.closes, 0);
    assert.equal(outputHistory(h).length, 0);
  } finally {
    await restarted?.shutdown();
    await h.close();
  }
});

test("a custom output callback without retry proof never replays a persisted sending checkpoint", async () => {
  let calls = 0;
  const h = taskSetup({
    output: async () => {
      calls++;
    },
  });
  try {
    const task = await h.service.create(actor, {
      ...discussion,
      participants: [{ kind: "codex" }],
    });
    await h.service.reconcile(task.id);
    const participant = h.service.records.participants(task)[0];
    assert.ok(participant);
    h.store.set<PendingOutput>("pending_outputs", "unproved-output", {
      taskId: task.id,
      participantId: participant.id,
      entry: { id: "native-final", role: "assistant", final: true, text: result },
      delivery: "sending",
    });
    const restored = new TaskService(h.options);
    await restored.reconcile(task.id);
    await restored.reconcile(task.id);
    assert.equal(calls, 0);
    assert.equal(
      h.store.get<PendingOutput>("pending_outputs", "unproved-output")?.delivery,
      "uncertain",
    );
  } finally {
    h.close();
  }
});
