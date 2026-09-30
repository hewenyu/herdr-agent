import assert from "node:assert/strict";
import test from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import type { HerdrPort, InputProgress } from "../../src/core/ports.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import type { InputTiming } from "../../src/tasks/input-timing.js";
import { TaskService } from "../../src/tasks/service.js";
import { deferred } from "../app/helpers.js";
import { actor, createPersistedTask, discussion, setup } from "./helpers.js";

for (const mode of ["manual", "round_robin"] as const)
  test(`${mode} initial provisioning defers lifecycle ingress and resumes without a stale syncError lock`, async () => {
    const h = setup();
    const entered = deferred();
    const release = deferred();
    const sample = h.herdr.sampleLastReply.bind(h.herdr);
    let hold = true;
    try {
      const task = await createPersistedTask(h, actor, discussion, { discussionMode: mode });
      h.herdr.sampleLastReply = async (ref) => {
        if (hold) {
          hold = false;
          entered.resolve();
          await release.promise;
        }
        return sample(ref);
      };
      const provisioning = h.service.reconcile(task.id);
      await entered.promise;
      const current = h.service.get(actor, task.id);
      const record: InboxRecord = {
        id: "lifecycle",
        type: "task",
        payload: { id: current.remoteTaskId as string },
        state: "queued",
        lane: "task",
        sequence: 1,
        createdAt: new Date().toISOString(),
      };
      h.store.set("inbox", record.id, record);
      release.resolve();
      await provisioning;
      assert.equal(h.herdr.sends.length, 0);
      assert.ok(h.service.get(actor, task.id).syncError);
      const operationId = `${current.participants[0]?.id}:initial`;
      assert.equal(
        h.store.get<OperationReceipt>("operations", operationId)?.error?.outcome,
        "not_executed",
      );
      h.store.set("inbox", record.id, { ...record, state: "done" });
      await new TaskService(h.options).reconcile(task.id);
      assert.equal(h.herdr.sends.length, 1);
      assert.equal(h.store.get<OperationReceipt>("operations", operationId)?.state, "done");
      assert.equal(h.service.get(actor, task.id).syncError, undefined);
      assert.equal(h.store.get("input_retry_counts", operationId), undefined);
    } finally {
      release.resolve();
      h.close();
    }
  });

test("input timing survives service restart and never logs task text or receipt contents", async () => {
  const h = setup();
  const logs: unknown[] = [];
  const logger = {
    info: (_message: string, fields?: Record<string, unknown>) => logs.push(fields),
    warn() {},
    error() {},
  };
  const native = h.herdr.send.bind(h.herdr);
  try {
    (h.herdr as HerdrPort).send = async (ref, text, options) => {
      options?.assertCurrent?.();
      const progress: InputProgress[] = [
        { phase: "write_started", at: "2026-09-29T02:26:52.001Z" },
        { phase: "acknowledged", at: "2026-09-29T02:26:54.000Z" },
        { phase: "readback_completed", at: "2026-09-29T02:26:55.064Z", verified: true },
      ];
      for (const event of progress) options?.onProgress?.(event);
      return native(ref, text);
    };
    const service = new TaskService({ ...h.options, logger });
    const task = await service.create(actor, {
      ...discussion,
      requirements: "private task input",
      participants: [{ kind: "codex" }],
    });
    await service.reconcile(task.id);
    const participant = service.get(actor, task.id).participants[0];
    assert.ok(participant);
    const operationId = `${participant.id}:initial`;
    await new TaskService({ ...h.options, logger }).reconcile(task.id);
    const timing = h.store.get<InputTiming>("task_input_timing", operationId);
    assert.equal(timing?.operationId, operationId);
    assert.deepEqual(
      timing?.events.map((event) => event.phase),
      ["write_started", "acknowledged", "readback_completed"],
    );
    assert.equal(logs.length, 3);
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(JSON.stringify([timing, logs]).includes("private task input"), false);
    assert.equal(JSON.stringify([timing, logs]).includes(participant.initialReceipt), false);
  } finally {
    h.close();
  }
});
