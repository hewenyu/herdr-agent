import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/types.js";
import { finishReportNotifications } from "../../src/orchestration/report-cleanup.js";
import { WORKFLOWS } from "../../src/orchestration/workflow.js";
import { Store } from "../../src/storage/store.js";

function fixture() {
  const store = new Store(":memory:");
  const task = {
    id: "task",
    promptVersion: 3,
    orchestration: { mode: "workflow" },
    status: "destroying",
    completedAt: "12345",
  } as Task;
  const event = {
    id: "event",
    taskId: "task",
    state: "done",
    userRevision: "revision",
    decision: { action: "deliver", reportId: "report" },
    notificationState: "retryable",
    dispatches: [],
  } as unknown as OrchestrationEvent;
  store.set("task_orchestration_events", event.id, event);
  store.set("workflow_report_deliveries", event.id, {
    taskId: task.id,
    eventId: event.id,
    reportId: "report",
    channel: "platform",
  });
  store.set(WORKFLOWS, task.id, { report: { id: "report" } });
  return { store, task, event };
}

test("cleanup notification contract failure stays attention even if later checks would succeed", async () => {
  const h = fixture();
  let notifications = 0;
  try {
    const ports = {
      store: h.store,
      revision: () => "revision",
      recover: async () => {},
      notify: async () => {
        notifications++;
        throw new OperationError("workflow_report", "文件变化，冻结合同失效");
      },
    };
    await finishReportNotifications(h.task, [h.event], ports);
    assert.equal(h.event.state, "attention");
    assert.equal(h.event.error?.code, "workflow_report");
    const restored = h.store.get<OrchestrationEvent>("task_orchestration_events", h.event.id);
    assert.ok(restored);
    await finishReportNotifications(h.task, [restored], {
      ...ports,
      notify: async () => {
        notifications++;
      },
    });
    assert.equal(notifications, 1);
    assert.equal(restored.state, "attention");
  } finally {
    h.store.close();
  }
});

test("remote not-completed sentinel cannot authorize cleanup report recovery", async () => {
  const h = fixture();
  try {
    await finishReportNotifications({ ...h.task, completedAt: "0" }, [h.event], {
      store: h.store,
      revision: () => "revision",
      recover: async () => {
        assert.fail("completion is not confirmed");
      },
      notify: async () => {
        assert.fail("completion is not confirmed");
      },
    });
    assert.equal(h.event.state, "done");
  } finally {
    h.store.close();
  }
});

test("cleanup preserves an unresolved notification result instead of retrying its frozen message", async () => {
  const h = fixture();
  try {
    h.event.notificationState = "sending";
    await finishReportNotifications(h.task, [h.event], {
      store: h.store,
      revision: () => "revision",
      recover: async (_task, event) => {
        event.notificationState = "uncertain";
      },
      notify: async () => {
        assert.fail("unknown transport cannot be replayed during cleanup");
      },
    });
    assert.equal(h.event.notificationState, "uncertain");
  } finally {
    h.store.close();
  }
});
