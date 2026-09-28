import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Outbox } from "../../src/app/outbox.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { PlatformPort } from "../../src/core/ports.js";
import {
  ReportDeliveries,
  type ReportDelivery,
  type ReportEnvelope,
} from "../../src/orchestration/report-delivery.js";
import { Store } from "../../src/storage/store.js";
import { deferred } from "../app/helpers.js";
import { FakePlatform } from "../tasks/helpers.js";

const namespace = "workflow_report_deliveries";

function fixture(staleReport?: (event: OrchestrationEvent) => boolean) {
  const store = new Store(":memory:");
  const calls = { uploads: 0, files: 0, cards: 0 };
  const platform: PlatformPort = new FakePlatform();
  platform.uploadFile = async () => `upload-${++calls.uploads}`;
  platform.sendFile = async () => `file-${++calls.files}`;
  platform.sendCard = async () => `card-${++calls.cards}`;
  const outbox = new Outbox(store, () => platform);
  const restart = () => new ReportDeliveries(store, outbox, () => platform, staleReport);
  const deliveries = restart();
  const text = "# 冻结报告\n旧版结论";
  const input: ReportEnvelope = {
    taskId: "task",
    eventId: "event",
    reportId: "report",
    reportHash: createHash("sha256").update(text).digest("hex"),
    chatId: "chat",
    text,
    card: { header: { title: { content: "报告摘要" } } },
    channel: "platform",
    presentation: "attachment",
  };
  const event: OrchestrationEvent = {
    id: input.eventId,
    taskId: input.taskId,
    trigger: "output",
    outputIds: [],
    userRevision: "old-revision",
    state: "attention",
    attempts: 1,
    dispatches: [],
    decision: { action: "deliver", reason: "报告合同", reportId: input.reportId },
    error: { code: "workflow_report", message: "交付合同变化", outcome: "not_executed" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const saveEvent = (changes: Partial<OrchestrationEvent> = {}) =>
    store.set("task_orchestration_events", event.id, { ...event, ...changes });
  const record = () => {
    const value = store.get<ReportDelivery>(namespace, input.eventId);
    assert.ok(value);
    return value;
  };
  saveEvent();
  return { store, platform, deliveries, input, event, saveEvent, calls, record, restart };
}

for (const boundary of [1, 2, 3])
  test(`superseded attachment retires after freshness failure at stage ${boundary}, preserving its transport facts`, async () => {
    const h = fixture();
    let guards = 0;
    try {
      await assert.rejects(
        h.deliveries.send(h.input, async () => {
          if (++guards === boundary) throw new OperationError("workflow_report", "已过期");
        }),
        { code: "workflow_report" },
      );
      const old = h.record();
      assert.equal(h.deliveries.pendingInChat("chat"), true);
      assert.equal(h.record().retired, undefined, "attention still needs an explicit user change");
      h.saveEvent({ state: "superseded" });
      const restarted = h.restart();
      assert.equal(restarted.pendingInChat("chat"), false);
      const retired = h.record();
      assert.equal(retired.retired?.reason, "superseded");
      const { retired: _retired, updatedAt: _updated, ...preserved } = retired;
      const { updatedAt: _oldUpdated, ...facts } = old;
      assert.deepEqual(preserved, facts, "retirement does not invent or erase any send receipt");
      assert.equal(restarted.retryable("task", "event", "report"), false);
      assert.equal(await restarted.confirmed("task", "event", "report"), false);
      await assert.rejects(restarted.send(h.input), { code: "report_delivery_retired" });
      assert.equal(restarted.download("task", retired.cardId).content, h.input.text);
      assert.deepEqual(h.calls, {
        uploads: boundary > 1 ? 1 : 0,
        files: boundary > 2 ? 1 : 0,
        cards: 0,
      });
      assert.deepEqual(h.record(), retired, "repeated checks retain the same terminal marker");
    } finally {
      h.store.close();
    }
  });

test("retirement needs an exact superseded delivery event binding", async () => {
  const h = fixture();
  try {
    h.deliveries.prepare(h.input);
    for (const mismatch of [
      { id: "other-event" },
      { taskId: "other-task" },
      { state: "attention" as const },
      { state: "done" as const },
      { decision: { action: "wait" as const, reason: "等待" } },
      { decision: { action: "deliver" as const, reason: "交付", reportId: "other-report" } },
    ]) {
      h.saveEvent({ state: "superseded", ...mismatch });
      assert.equal(h.deliveries.pendingInChat("chat"), true);
      assert.equal(h.record().retired, undefined);
    }
    h.store.delete("task_orchestration_events", h.event.id);
    assert.equal(h.deliveries.pendingInChat("chat"), true);
  } finally {
    h.store.close();
  }
});

for (const state of ["uploading", "sending", "uncertain"] as const)
  test(`superseding an attachment with ${state} file outcome cannot retire or repeat it`, async () => {
    const h = fixture();
    try {
      const record = h.deliveries.prepare(h.input);
      h.store.set(namespace, record.eventId, { ...record, fileState: state });
      h.saveEvent({ state: "superseded" });
      const restarted = h.restart();
      assert.equal(restarted.pendingInChat("chat"), true);
      assert.equal(h.record().retired, undefined);
      assert.equal(restarted.retryable("task", "event", "report"), false);
      assert.equal(await restarted.confirmed("task", "event", "report"), false);
      await assert.rejects(restarted.send(h.input), { code: "delivery_uncertain" });
      assert.deepEqual(h.calls, { uploads: 0, files: 0, cards: 0 });
    } finally {
      h.store.close();
    }
  });

for (const state of ["sending", "uncertain"] as const)
  test(`superseding an attachment with ${state} card outcome preserves the cleanup barrier`, async () => {
    const h = fixture();
    try {
      await h.deliveries.send(h.input);
      h.store.set(namespace, h.event.id, {
        ...h.record(),
        cardState: state,
        cardMessageId: undefined,
      });
      h.saveEvent({ state: "superseded" });
      const restarted = h.restart();
      assert.equal(restarted.pendingInChat("chat"), true);
      assert.equal(h.record().retired, undefined);
      assert.equal(restarted.retryable("task", "event", "report"), false);
      assert.equal(await restarted.confirmed("task", "event", "report"), false);
      await assert.rejects(restarted.send(h.input), { code: "delivery_uncertain" });
      assert.deepEqual(h.calls, { uploads: 1, files: 1, cards: 1 });
    } finally {
      h.store.close();
    }
  });

test("fully delivered superseded reports keep their historical confirmation", async () => {
  const h = fixture();
  try {
    await h.deliveries.send(h.input);
    h.saveEvent({ state: "superseded" });
    const restarted = h.restart();
    assert.equal(restarted.pendingInChat("chat"), false);
    assert.equal(await restarted.confirmed("task", "event", "report"), true);
    assert.equal(h.record().retired, undefined);
    await restarted.send(h.input);
    assert.deepEqual(h.calls, { uploads: 1, files: 1, cards: 1 });
  } finally {
    h.store.close();
  }
});

test("an in-flight freshness guard cannot be hidden by superseded retirement", async () => {
  const h = fixture();
  const entered = deferred();
  const release = deferred();
  try {
    const sending = h.deliveries.send(h.input, async () => {
      entered.resolve();
      await release.promise;
      throw new OperationError("workflow_report", "已过期");
    });
    await entered.promise;
    h.saveEvent({ state: "superseded" });
    assert.equal(h.deliveries.pendingInChat("chat"), true);
    assert.equal(h.record().retired, undefined);
    release.resolve();
    await assert.rejects(sending, { code: "workflow_report" });
    assert.equal(h.deliveries.pendingInChat("chat"), false);
    await assert.rejects(h.deliveries.send(h.input), { code: "report_delivery_retired" });
    assert.deepEqual(h.calls, { uploads: 0, files: 0, cards: 0 });
  } finally {
    release.resolve();
    h.store.close();
  }
});

test("a stale callback cannot retire an unbound, pending or unresolved delivery event", async () => {
  let stale = false;
  const h = fixture(() => stale);
  const done = { state: "done" as const, notificationState: "retryable" as const };
  try {
    h.deliveries.prepare(h.input);
    h.saveEvent(done);
    assert.equal(h.deliveries.pendingInChat("chat"), true);
    assert.equal(h.deliveries.retryable("task", "event", "report"), true);
    stale = true;
    for (const change of [
      { id: "other-event" },
      { taskId: "other-task" },
      { decision: { action: "deliver" as const, reason: "交付", reportId: "other-report" } },
      { state: "attention" as const },
      { state: "pending" as const },
      { notificationState: undefined },
      { notified: true },
      { dispatches: [{ operationId: "input", participantId: "p1", state: "pending" as const }] },
      { dispatches: [{ operationId: "input", participantId: "p1", state: "uncertain" as const }] },
    ]) {
      h.saveEvent({ ...done, ...change });
      assert.equal(h.deliveries.pendingInChat("chat"), true);
      assert.equal(h.record().retired, undefined);
    }
    h.saveEvent(done);
    assert.equal(h.deliveries.pendingInChat("chat"), false);
    assert.equal(h.record().retired?.reason, "stale_report");
  } finally {
    h.store.close();
  }
});

for (const [fileState, cardState] of [
  ["uploading", "prepared"],
  ["sending", "prepared"],
  ["uncertain", "prepared"],
  ["delivered", "sending"],
  ["delivered", "uncertain"],
] as const)
  test(`stale done cannot retire actual ${fileState} file / ${cardState} card outcomes`, async () => {
    const h = fixture(() => true);
    try {
      const record = h.deliveries.prepare(h.input);
      h.store.set(namespace, h.event.id, {
        ...record,
        fileState,
        cardState,
        fileKey: fileState === "delivered" ? "key" : undefined,
        fileMessageId: fileState === "delivered" ? "file" : undefined,
      });
      h.saveEvent({ state: "done", notificationState: "retryable" });
      assert.equal(h.deliveries.pendingInChat("chat"), true);
      assert.equal(h.record().retired, undefined);
      assert.equal(h.deliveries.retryable("task", "event", "report"), false);
      assert.equal(await h.deliveries.confirmed("task", "event", "report"), false);
      await assert.rejects(h.deliveries.send(h.input), { code: "delivery_uncertain" });
      assert.deepEqual(h.calls, { uploads: 0, files: 0, cards: 0 });
    } finally {
      h.store.close();
    }
  });

test("stale done retirement waits for an active guard to settle", async () => {
  const h = fixture(() => true);
  const entered = deferred();
  const release = deferred();
  try {
    const sending = h.deliveries.send(h.input, async () => {
      entered.resolve();
      await release.promise;
      throw new OperationError("workflow_report", "旧报告");
    });
    await entered.promise;
    h.saveEvent({ state: "done", notificationState: "sending" });
    assert.equal(h.deliveries.pendingInChat("chat"), true);
    assert.equal(h.record().retired, undefined);
    release.resolve();
    await assert.rejects(sending, { code: "workflow_report" });
    assert.equal(h.deliveries.pendingInChat("chat"), false);
    assert.equal(h.record().retired?.reason, "stale_report");
    await assert.rejects(h.deliveries.send(h.input), { code: "report_delivery_retired" });
    assert.deepEqual(h.calls, { uploads: 0, files: 0, cards: 0 });
  } finally {
    release.resolve();
    h.store.close();
  }
});

test("a current done report resumes only its failed card, and a later stale revision preserves full confirmation", async () => {
  let stale = false;
  const h = fixture(() => stale);
  h.platform.sendCard = async () => {
    if (++h.calls.cards === 1) throw new OperationError("platform_unavailable", "not sent");
    return "card";
  };
  try {
    await assert.rejects(h.deliveries.send(h.input), { code: "platform_unavailable" });
    h.saveEvent({ state: "done", notificationState: "retryable" });
    const restarted = h.restart();
    assert.equal(restarted.pendingInChat("chat"), true);
    await restarted.send(h.input);
    stale = true;
    assert.equal(restarted.pendingInChat("chat"), false);
    assert.equal(h.record().retired, undefined);
    assert.equal(await restarted.confirmed("task", "event", "report"), true);
    assert.deepEqual(h.calls, { uploads: 1, files: 1, cards: 2 });
  } finally {
    h.store.close();
  }
});
