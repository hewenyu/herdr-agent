import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import { OperationError } from "../../src/core/errors.js";
import { stableId } from "../../src/core/ids.js";
import type { StoredMessage, TranscriptEntry } from "../../src/core/types.js";
import { actor, discussion } from "../tasks/helpers.js";
import { logger, setup } from "./helpers.js";

interface PendingOutput {
  taskId: string;
  participantId: string;
  entry: TranscriptEntry;
  sequence?: number;
  delivery?: "sending" | "uncertain" | "retryable";
  error?: { code: string; message: string; outcome: "unknown" };
}

for (const boundary of ["before_internal", "after_internal", "uncertain_internal"] as const)
  test(`quiet workflow recovers ${boundary} output checkpoint without an external receipt or another native turn`, async () => {
    const h = setup();
    const set = h.store.set.bind(h.store);
    let restarted: Application | undefined;
    let checkpoint: [string, PendingOutput] | undefined;
    try {
      const task = await h.app.tasks.create(actor, {
        ...discussion,
        participants: [{ kind: "codex" }],
        orchestration: { mode: "workflow" },
        createGroup: false,
        createRemoteTask: false,
      });
      task.promptVersion = 3;
      h.app.tasks.records.save(task);
      await h.app.tasks.reconcile(task.id);
      const participant = h.app.tasks.records.participants(task)[0];
      assert.ok(participant?.execution);
      await h.app.tasks.send(
        { ...actor, messageId: "native-input" },
        task.id,
        participant.id,
        "分析需求并记录材料。",
      );
      const inputs = h.store.list("input_deliveries");
      const result = "具体讨论意见已保存在任务材料，交给下一位复核。";
      h.herdr.finish(participant.execution.paneId, result);
      h.store.set = (namespace, key, value) => {
        if (namespace !== "workflow_outputs") return set(namespace, key, value);
        checkpoint = h.store.entries<PendingOutput>("pending_outputs")[0];
        assert.ok(checkpoint);
        assert.equal(checkpoint[1].delivery, "sending");
        if (boundary !== "before_internal") set(namespace, key, value);
        throw new OperationError("simulated_crash", "quiet archive checkpoint", "unknown");
      };
      await h.app.tasks.reconcile(task.id);
      h.store.set = set;
      assert.ok(checkpoint);
      const [key, pending] = checkpoint;
      assert.equal(
        key,
        stableId(participant.id, participant.execution.sessionId ?? "", pending.entry.id),
      );
      assert.equal(h.app.outbox.receipt(`output:${task.id}:${participant.id}:${key}`), undefined);
      assert.equal(h.store.list("workflow_outputs").length, boundary === "before_internal" ? 0 : 1);
      assert.equal(h.store.get<PendingOutput>("pending_outputs", key)?.delivery, "uncertain");
      await h.app.shutdown();
      if (boundary !== "uncertain_internal") h.store.set("pending_outputs", key, pending);
      restarted = new Application({
        config: h.config,
        store: h.store,
        engine: h.engine,
        herdr: h.herdr,
        platform: h.platform,
        logger,
      });
      await restarted.tasks.reconcile(task.id);
      await restarted.tasks.reconcile(task.id);
      assert.equal(h.store.get("pending_outputs", key), undefined);
      const records = h.store.entries<{
        taskId: string;
        participantId: string;
        sessionId?: string;
        entry: TranscriptEntry;
      }>("workflow_outputs");
      assert.equal(records.length, 1);
      assert.equal(records[0]?.[0], `${task.id}:${participant.id}:${key}`);
      assert.deepEqual(records[0]?.[1].entry, { ...pending.entry, id: key });
      assert.equal(records[0]?.[1].taskId, task.id);
      assert.equal(records[0]?.[1].participantId, participant.id);
      assert.equal(records[0]?.[1].sessionId, participant.execution.sessionId);
      assert.deepEqual(
        h.store.list("input_deliveries"),
        inputs,
        "output recovery cannot create or replace a native input operation",
      );
      assert.equal(h.herdr.sends.length, 1);
      assert.equal(
        h.platform.texts.some((entry) => entry.text.includes(result)),
        false,
      );
      assert.equal(
        h.store.list<StoredMessage>("messages").some((entry) => entry.source === "herdr"),
        false,
      );
      assert.equal(
        h.store.list("outbox").some((entry: unknown) => JSON.stringify(entry).includes(result)),
        false,
      );
      assert.equal(h.engine.calls.length, 0);
      await restarted.tasks.action({ ...actor, messageId: "complete" }, task.id, "complete");
      await restarted.tasks.reconcile(task.id);
      assert.equal(h.herdr.closes, 1, "recovered internal output releases the cleanup barrier");
    } finally {
      h.store.set = set;
      await restarted?.shutdown();
      await h.close();
    }
  });
