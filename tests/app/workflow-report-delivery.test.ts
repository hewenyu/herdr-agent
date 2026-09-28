import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { Participant, StoredMessage, Task, TranscriptEntry } from "../../src/core/types.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS } from "../../src/orchestration/workflow.js";
import { setup } from "./helpers.js";

interface DeliveryCallbacks {
  orchestrationReply(task: Task, text: string, eventId: string): Promise<void>;
  output(task: Task, participant: Participant, entry: TranscriptEntry): Promise<void>;
}

test("application sends complete workflow report and summary under event receipts, preserving raw outputs", async () => {
  const h = setup();
  try {
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-key";
    const task = await h.app.tasks.create(
      { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "report-task" },
      {
        kind: "discussion",
        title: "报告交付",
        requirements: "讨论并整理结论",
        project: "project",
        participants: [{ kind: "codex" }, { kind: "claude" }],
        orchestration: { mode: "workflow" },
      },
    );
    task.promptVersion = 2; // This fixture exercises legacy report recovery.
    h.app.tasks.records.save(task);
    const participant = h.app.tasks.records.participants(task)[0];
    assert.ok(participant);
    const callbacks = h.app as unknown as DeliveryCallbacks;
    const entry: TranscriptEntry = {
      id: "native-final",
      role: "assistant",
      final: true,
      text: '可见分析\n```myrix-status\n{"internal":"state"}\n```',
    };
    await callbacks.output(task, participant, entry);
    assert.equal(h.platform.texts[0]?.text.includes("myrix-status"), false);
    assert.equal(entry.text.includes("myrix-status"), true);
    const text = "# 完整报告\n\n讨论结论、证据与保留事项。";
    const state = workflowState(h.store, task, "revision");
    state.report = {
      id: "report-1",
      path: "/not-read-by-delivery-callback",
      hash: createHash("sha256").update(text).digest("hex"),
      outputId: entry.id,
      artifactRevision: "artifact-1",
    };
    h.store.set(WORKFLOWS, task.id, state);
    const event: OrchestrationEvent = {
      id: "report-event",
      taskId: task.id,
      trigger: "output",
      outputIds: [entry.id],
      userRevision: "revision",
      state: "done",
      attempts: 1,
      dispatches: [],
      decision: {
        action: "deliver",
        reason: "合同已满足",
        outputId: entry.id,
        participantId: participant.id,
        reportId: state.report.id,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    h.store.set("task_orchestration_events", event.id, event);
    let cards = 0;
    h.platform.cardHook = async () => {
      cards++;
      if (cards === 1) throw new OperationError("platform_unavailable", "not sent");
    };
    await assert.rejects(callbacks.orchestrationReply(task, text, event.id));
    assert.equal(h.platform.texts.length, 2, "report body is independent of native output receipt");
    await callbacks.orchestrationReply(task, text, event.id);
    assert.equal(h.platform.texts.length, 2, "delivered body is never repeated");
    assert.equal(cards, 2);
    const history = h.store.list<StoredMessage>("messages");
    assert.equal(
      history.some((message) => message.source === "workflow_report" && message.text === text),
      true,
    );
    assert.equal(
      history.some((message) => message.source === "workflow_report_summary"),
      true,
    );
    assert.equal(
      h.app.outbox.receipt(`output:${task.id}:${participant.id}:${entry.id}`)?.state,
      "delivered",
    );
    assert.equal(
      h.app.outbox.receipt(`workflow-report:${task.id}:${event.id}:${state.report.id}:body`)?.state,
      "delivered",
    );
  } finally {
    await h.close();
  }
});

test("v3 delivers a report attachment and one compact summary with an owner-bound frozen download", async () => {
  const h = setup();
  try {
    const task = await h.app.tasks.create(
      { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "report-v3" },
      {
        kind: "discussion",
        title: "报告",
        requirements: "讨论",
        project: "project",
        participants: [{ kind: "codex" }, { kind: "claude" }],
        orchestration: { mode: "workflow" },
      },
    );
    task.promptVersion = 3;
    h.app.tasks.records.save(task);
    const text = `# 完整报告\n\n${"最终正文。".repeat(3000)}`;
    const state = workflowState(h.store, task, "revision");
    state.report = {
      id: "report",
      path: "/never-read",
      hash: createHash("sha256").update(text).digest("hex"),
      outputId: "output",
      artifactRevision: "artifact",
    };
    h.store.set(WORKFLOWS, task.id, state);
    h.store.set("task_orchestration_events", "event", {
      id: "event",
      taskId: task.id,
      decision: { action: "deliver", reportId: "report" },
    });
    let uploaded = "";
    let sent = 0;
    const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
    platform.uploadFile = async (_name, content) => {
      uploaded = content;
      return "key";
    };
    platform.sendFile = async () => {
      sent++;
      return "file-message";
    };
    await (h.app as unknown as DeliveryCallbacks).orchestrationReply(task, text, "event");
    assert.equal(uploaded, text);
    assert.equal(sent, 1);
    assert.equal(h.platform.texts.length, 0);
    assert.equal(h.platform.cards.length, 1);
    const messages = h.store.list<StoredMessage>("messages");
    assert.equal(messages.length, 1);
    const summary = messages[0];
    assert.ok(summary);
    assert.equal(summary.source, "workflow_report_summary");
    assert.ok(summary.text.length < 2000);
    assert.equal(h.app.reportDownload("owner", summary.id).content, text);
    h.config.feishu.allowedOpenIds.push("other-owner");
    assert.throws(() => h.app.reportDownload("other-owner", summary.id));
    assert.throws(() => h.app.reportDownload("owner", "/etc/passwd"));
    const record = h.store.get<Record<string, unknown>>("workflow_report_deliveries", "event");
    h.store.set("workflow_report_deliveries", "event", { ...record, text: "modified" });
    assert.throws(() => h.app.reportDownload("owner", summary.id));
  } finally {
    await h.close();
  }
});
