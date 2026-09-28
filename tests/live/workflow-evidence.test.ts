import assert from "node:assert/strict";
import test from "node:test";
import { participantEvidence } from "../../scripts/live/workflow-acceptance-evidence.js";
import type { ExecutionRef, Task } from "../../src/core/types.js";
import { Store } from "../../src/storage/store.js";

test("v3 live evidence requires the independently validated receipt and matching natural handoff", () => {
  const store = new Store(":memory:");
  const task = { id: "task", promptVersion: 3 } as Task;
  const execution: ExecutionRef = {
    workspaceId: "workspace",
    paneId: "pane",
    kind: "claude",
    cwd: "/fixture",
    sessionId: "session",
  };
  const owned = new Map([[execution.paneId, execution]]);
  const read = () => participantEvidence(store, task, owned)[0]?.provenParticipation;
  try {
    store.set("participants", "participant", {
      id: "participant",
      taskId: task.id,
      execution,
      kind: "claude",
      started: true,
    });
    store.set("task_orchestration_events", "event", {
      taskId: task.id,
      dispatches: [
        {
          operationId: "operation",
          participantId: "participant",
          nodeId: "node",
          inputRevision: "revision",
          state: "sent",
        },
      ],
    });
    store.set("operations", "operation", {
      state: "done",
      fingerprint: "fingerprint",
      result: { verified: true },
    });
    store.set("input_deliveries", "operation", {
      taskId: task.id,
      participantId: "participant",
      operationId: "operation",
      fingerprint: "fingerprint",
      execution,
      outputSequence: 0,
    });
    store.set("task_input_applied", "operation", true);
    store.set("task_settled_outputs", "output", {
      taskId: task.id,
      participantId: "participant",
      sequence: 1,
      observedAt: "time",
      entry: { id: "output", role: "assistant", text: "我已回应前一位，材料见本轮 notes.md。" },
    });
    assert.equal(read(), false, "natural prose alone is not validated workflow participation");
    const block = { nodeId: "node", operationId: "operation", inputRevision: "revision" };
    store.set("workflow_status_blocks", "output", { taskId: task.id, block });
    store.set("workflow_conversation_evidence", "output", {
      taskId: task.id,
      participantId: "participant",
      outputId: "output",
    });
    assert.equal(read(), true);
    store.set("workflow_status_blocks", "output", {
      taskId: task.id,
      block: { ...block, inputRevision: "stale" },
    });
    assert.equal(read(), false);
    store.set("workflow_status_blocks", "output", { taskId: task.id, block });
    store.set("workflow_conversation_evidence", "output", {
      taskId: "foreign",
      participantId: "participant",
      outputId: "output",
    });
    assert.equal(read(), false);
  } finally {
    store.close();
  }
});
