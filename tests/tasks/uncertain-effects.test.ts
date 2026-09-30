import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Outbox } from "../../src/app/outbox.js";
import { OperationError } from "../../src/core/errors.js";
import { canonical, stableId } from "../../src/core/ids.js";
import type { Participant, Task } from "../../src/core/types.js";
import {
  ReportDeliveries,
  type ReportDelivery,
  type ReportEnvelope,
} from "../../src/orchestration/report-delivery.js";
import { type OperationReceipt, Operations } from "../../src/storage/operations.js";
import { Store } from "../../src/storage/store.js";
import type { TaskContext } from "../../src/tasks/context.js";
import {
  applyUncertainResolution,
  listUncertainEffects,
  reconcileUncertain,
} from "../../src/tasks/uncertain-effects.js";
import { FakePlatform } from "./helpers.js";

function fixture() {
  const store = new Store(":memory:");
  const task = { id: "task", participantIds: ["task:p1"] } as Task;
  const execution = {
    paneId: "pane",
    workspaceId: "workspace",
    kind: "codex",
    cwd: "/tmp",
  } as const;
  const participant = { id: "task:p1", taskId: task.id, execution, started: true } as Participant;
  store.set("tasks", task.id, task);
  store.set("participants", participant.id, participant);
  const id = `${participant.id}:close`;
  const receipt: OperationReceipt = {
    id,
    fingerprint: stableId(canonical(execution)),
    state: "uncertain",
    error: { code: "lost", message: "lost reply", outcome: "unknown" },
    updatedAt: "2026-09-29T01:00:00Z",
  };
  store.set("operations", id, receipt);
  return { store, task, execution, participant, id, receipt };
}

test("live pending operations are excluded, stale pending operations remain uncertain", async () => {
  const f = fixture();
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.store.delete("operations", f.id);
  try {
    const running = new Operations(f.store).run(f.id, f.execution, async () => {
      started();
      await waiting;
    });
    await admitted;
    assert.equal(listUncertainEffects(f.store, f.task).length, 0);
    release();
    await running;
    f.store.set("operations", f.id, { ...f.receipt, state: "pending" });
    assert.equal(listUncertainEffects(f.store, f.task).length, 1);
  } finally {
    release();
    f.store.close();
  }
});

test("retry is no longer offered after one uncertain retry and pi cannot abandon panes", () => {
  const f = fixture();
  try {
    const effect = listUncertainEffects(f.store, f.task)[0];
    assert.ok(effect);
    assert.throws(
      () =>
        applyUncertainResolution(f.store, effect, {
          choice: "abandon",
          decidedBy: "pi",
          reason: "skip cleanup",
        }),
      { code: "operation_resolution_invalid" },
    );
    f.store.set("operations", f.id, {
      ...f.receipt,
      history: [
        {
          ...f.receipt,
          resolution: {
            choice: "retry",
            decidedBy: "user",
            reason: "once",
            at: new Date().toISOString(),
          },
        },
      ],
    });
    const current = listUncertainEffects(f.store, f.task)[0];
    assert.ok(current);
    assert.deepEqual(
      current.options.map((option) => option.choice),
      ["treat_done", "abandon"],
    );
    assert.throws(
      () =>
        applyUncertainResolution(f.store, current, {
          choice: "retry",
          decidedBy: "user",
          reason: "twice",
        }),
      { code: "operation_retry_exhausted" },
    );
  } finally {
    f.store.close();
  }
});

for (const mode of ["missing", "exists", "changed", "offline", "agent_missing"] as const) {
  test(`pane-close evidence ${mode} never invokes close`, async () => {
    const f = fixture();
    try {
      const pane = async () => {
        if (mode === "missing") throw new OperationError("pane_not_found", "missing");
        if (mode === "agent_missing")
          throw new OperationError("agent_not_found", "missing agent only");
        if (mode === "offline") throw new Error("offline");
        return { pane_id: "pane", workspace_id: mode === "changed" ? "other" : "workspace" };
      };
      const context = {
        store: f.store,
        signal: new AbortController().signal,
        herdr: {
          paneExists: async () => {
            try {
              await pane();
              return true;
            } catch (error) {
              if (error instanceof OperationError && error.code === "pane_not_found") return false;
              throw error;
            }
          },
          close: () => assert.fail("no mutation"),
        },
      } as unknown as TaskContext;
      const result = await reconcileUncertain(context, f.task);
      assert.deepEqual(result.resolved, mode === "missing" ? [f.id] : []);
      assert.equal(result.remaining.length, mode === "missing" ? 0 : 1);
      const current = f.store.get<OperationReceipt>("operations", f.id);
      assert.equal(current?.state, "uncertain");
      assert.deepEqual(current?.error, f.receipt.error);
      if (mode === "missing") {
        assert.equal(current?.resolution?.decidedBy, "evidence");
        await new Operations(f.store).run(f.id, f.execution, async () =>
          assert.fail("no close replay"),
        );
      }
    } finally {
      f.store.close();
    }
  });
}

for (const exact of [true, false]) {
  test(`input evidence requires complete prompt match: ${exact}`, async () => {
    const f = fixture();
    try {
      const inputId = "task:send:1";
      f.store.set("operations", inputId, { ...f.receipt, id: inputId });
      f.store.set("input_deliveries", inputId, {
        taskId: f.task.id,
        participantId: f.participant.id,
        operationId: inputId,
        fingerprint: f.receipt.fingerprint,
        execution: f.execution,
        receipt: "receipt",
        prompt: "exact prompt",
      });
      const context = {
        store: f.store,
        signal: new AbortController().signal,
        herdr: {
          get: async () => {
            throw new Error("offline");
          },
          initialInput: async () => (exact ? "exact prompt" : "prefix exact prompt"),
        },
      } as unknown as TaskContext;
      const result = await reconcileUncertain(context, f.task);
      assert.deepEqual(result.resolved, exact ? [inputId] : []);
      assert.equal(f.store.get<OperationReceipt>("operations", inputId)?.state, "uncertain");
      if (exact) {
        const delivered = await new Operations(f.store).run<{ verified: boolean }>(
          inputId,
          f.execution,
          async () => assert.fail("no replay"),
        );
        assert.equal(delivered.verified, true);
      }
    } finally {
      f.store.close();
    }
  });
}

for (const choice of ["treat_done", "retry", "abandon"] as const) {
  test(`report file decision ${choice} is respected and preserves unknown invocation`, async () => {
    const f = fixture();
    const platform = Object.assign(new FakePlatform(), {
      uploadFile: async (_name: string, _content: string): Promise<string> => "file",
      sendFile: async (_chat: string, _file: string, _key: string): Promise<string> => "message",
    });
    let uploads = 0;
    platform.uploadFile = async () => {
      uploads++;
      assert.equal(
        listUncertainEffects(f.store, f.task).some((effect) => effect.kind === "report_file"),
        false,
      );
      throw new OperationError("lost_upload", "unknown upload", "unknown");
    };
    platform.sendFile = async () => assert.fail("no file key");
    const deliveries = new ReportDeliveries(
      f.store,
      new Outbox(f.store, () => platform),
      () => platform,
    );
    const text = "# frozen report";
    const envelope: ReportEnvelope = {
      taskId: f.task.id,
      eventId: "event",
      reportId: "report",
      text,
      reportHash: createHash("sha256").update(text).digest("hex"),
      chatId: "chat",
      card: {},
      channel: "platform",
      presentation: "attachment",
    };
    try {
      await assert.rejects(deliveries.send(envelope));
      const effect = listUncertainEffects(f.store, f.task).find(
        (entry) => entry.kind === "report_file",
      );
      assert.ok(effect);
      assert.ok(effect.evidence.includes("平台无只读查询接口"));
      applyUncertainResolution(f.store, effect, {
        choice,
        decidedBy: "user",
        reason: "accepted duplication risk",
      });
      assert.throws(() =>
        applyUncertainResolution(f.store, effect, { choice, decidedBy: "pi", reason: "overwrite" }),
      );
      const before = f.store.get<ReportDelivery>("workflow_report_deliveries", "event");
      assert.equal(before?.fileState, "uncertain");
      assert.equal(before?.error?.code, "lost_upload");
      if (choice === "treat_done") {
        await deliveries.send(envelope);
        assert.equal(await deliveries.confirmed(f.task.id, "event", "report"), true);
        assert.equal(uploads, 1);
        const current = f.store.get<ReportDelivery>("workflow_report_deliveries", "event");
        assert.equal(current?.fileState, "uncertain");
        assert.equal(current?.error?.code, "lost_upload");
      } else if (choice === "abandon") {
        await assert.rejects(deliveries.send(envelope), { code: "operation_abandoned" });
        assert.equal(deliveries.retryable(f.task.id, "event", "report"), false);
        assert.equal(uploads, 1);
      } else {
        assert.equal(deliveries.retryable(f.task.id, "event", "report"), true);
        await assert.rejects(deliveries.send(envelope), { code: "lost_upload" });
        await assert.rejects(deliveries.send(envelope), { code: "delivery_uncertain" });
        assert.equal(uploads, 2);
        const current = f.store.get<ReportDelivery>("workflow_report_deliveries", "event");
        assert.equal(current?.fileResolution, undefined);
        assert.equal(current?.fileHistory?.[0]?.fileState, "uncertain");
        assert.equal(current?.fileHistory?.[0]?.error?.code, "lost_upload");
        assert.equal(current?.fileHistory?.[0]?.fileResolution?.choice, "retry");
        const retriedEffect = listUncertainEffects(f.store, f.task).find(
          (entry) => entry.kind === "report_file",
        );
        assert.ok(retriedEffect);
        assert.deepEqual(
          retriedEffect.options.map((option) => option.choice),
          ["treat_done", "abandon"],
        );
        assert.throws(
          () =>
            applyUncertainResolution(f.store, retriedEffect, {
              choice: "retry",
              decidedBy: "user",
              reason: "twice",
            }),
          { code: "operation_retry_exhausted" },
        );
      }
    } finally {
      f.store.close();
    }
  });
}
