import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Outbox } from "../../src/app/outbox.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import type { Task } from "../../src/core/types.js";
import { ReportDeliveries } from "../../src/orchestration/report-delivery.js";
import { WORKFLOWS } from "../../src/orchestration/workflow.js";
import { Store } from "../../src/storage/store.js";
import { FakePlatform } from "../tasks/helpers.js";

const table = "task_orchestration_events";
function fixture() {
  const store = new Store(":memory:");
  const platform = new FakePlatform();
  const task = {
    id: "task",
    chatId: "chat",
    promptVersion: 3,
    orchestration: { mode: "workflow" },
  } as Task;
  const event = {
    id: "event",
    taskId: task.id,
    state: "done",
    userRevision: "revision",
    decision: { action: "deliver", reportId: "report" },
    dispatches: [],
  } as unknown as OrchestrationEvent;
  store.set("tasks", task.id, task);
  store.set(table, event.id, event);
  store.set(WORKFLOWS, task.id, { taskId: task.id, report: { id: "report" } });
  const receipts = new ReportDeliveries(store, new Outbox(store, () => platform), () => platform);
  return { store, task, event, receipts };
}

test("missing-receipt intent blocks until notification is confirmed, explicitly superseded or its report replaced", () => {
  const h = fixture();
  try {
    assert.equal(h.receipts.pendingInChat("chat"), true);
    h.store.set(table, h.event.id, { ...h.event, notificationState: "sending" });
    assert.equal(h.receipts.pendingInChat("chat"), true);
    h.store.set(table, h.event.id, { ...h.event, state: "attention" });
    assert.equal(h.receipts.pendingInChat("chat"), true);
    h.store.set(table, h.event.id, { ...h.event, state: "superseded" });
    assert.equal(h.receipts.pendingInChat("chat"), false);
    h.store.set(table, h.event.id, { ...h.event, notified: true });
    assert.equal(h.receipts.pendingInChat("chat"), false);
    h.store.set(table, h.event.id, h.event);
    h.store.set(WORKFLOWS, h.task.id, { taskId: h.task.id, report: { id: "actual-replacement" } });
    assert.equal(h.receipts.pendingInChat("chat"), false);
    assert.equal(h.store.get("workflow_report_deliveries", h.event.id), undefined);
    assert.deepEqual(h.store.get(table, h.event.id), h.event, "the cleanup gate is passive");
  } finally {
    h.store.close();
  }
});

test("a cleared report, changed revision/phase or a foreign workflow cannot erase an unprepared delivery intent", () => {
  const h = fixture();
  try {
    for (const state of [
      undefined,
      { taskId: h.task.id },
      { taskId: h.task.id, report: { id: "" } },
      { taskId: h.task.id, phase: "planning", plan: { version: 2 } },
      { taskId: "foreign-task", report: { id: "replacement" } },
    ]) {
      if (state) h.store.set(WORKFLOWS, h.task.id, state);
      else h.store.delete(WORKFLOWS, h.task.id);
      h.store.set(table, h.event.id, { ...h.event, userRevision: "another-revision" });
      assert.equal(h.receipts.pendingInChat("chat"), true);
    }
  } finally {
    h.store.close();
  }
});

for (const mismatch of ["task", "report", "chat", "channel"])
  test(`an existing transport receipt with a mismatched ${mismatch} cannot unblock the original chat`, () => {
    const h = fixture();
    try {
      const text = "# 已冻结报告";
      const record = h.receipts.prepare({
        eventId: h.event.id,
        taskId: mismatch === "task" ? "foreign-task" : h.task.id,
        reportId: mismatch === "report" ? "foreign-report" : "report",
        chatId: mismatch === "chat" ? "another-chat" : "chat",
        channel: mismatch === "channel" ? "web" : "platform",
        text,
        reportHash: createHash("sha256").update(text).digest("hex"),
        card: {},
        presentation: "attachment",
      });
      // Complete the unrelated envelope so only its mismatched identity, not
      // an ordinary pending transport stage, can keep this intent blocked.
      h.store.set("workflow_report_deliveries", h.event.id, {
        ...record,
        fileState: "delivered",
        fileKey: "file-key",
        fileMessageId: "file-message",
        cardState: "delivered",
        cardMessageId: "card-message",
      });
      h.store.set(WORKFLOWS, h.task.id, { taskId: h.task.id, report: { id: "replacement" } });
      assert.equal(h.receipts.pendingInChat("chat"), true);
    } finally {
      h.store.close();
    }
  });

test("missing-receipt cleanup does not add barriers to legacy v2, other modes or another chat", () => {
  const h = fixture();
  try {
    assert.equal(h.receipts.pendingInChat("another-chat"), false);
    for (const task of [
      { ...h.task, promptVersion: 2 },
      { ...h.task, orchestration: { mode: "model" } },
      { ...h.task, orchestration: { mode: "manual" } },
      { ...h.task, orchestration: undefined, discussion: { mode: "round_robin" } },
    ]) {
      h.store.set("tasks", h.task.id, task);
      assert.equal(h.receipts.pendingInChat("chat"), false);
    }
  } finally {
    h.store.close();
  }
});
