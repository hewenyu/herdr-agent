import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type OrchestrationEvent,
  type SettledTaskOutput,
  TaskOrchestrator,
} from "../../src/app/task-orchestrator.js";
import { stableId } from "../../src/core/ids.js";
import type { Task } from "../../src/core/types.js";
import { actor, discussion, setup } from "../tasks/helpers.js";
import { Engine, logger } from "./helpers.js";

for (const action of ["wait", "deliver"] as const)
  for (const checkpoint of ["sending", "uncertain"] as const)
    for (const evidence of ["safe", "unknown", "no-hook"] as const)
      test(`${action} notification at ${checkpoint} recovers only with exact retry proof (${evidence})`, async () => {
        const h = setup();
        try {
          h.config.ai.enabled = true;
          const task = await h.service.create(actor, {
            ...discussion,
            orchestration: { mode: "model" },
          });
          await h.service.reconcile(task.id);
          const participants = h.service.records.participants(task);
          for (const participant of participants) {
            participant.initialSent = true;
            h.service.records.saveParticipant(participant);
          }
          const output: SettledTaskOutput = {
            taskId: task.id,
            participantId: participants[0]?.id ?? "",
            entry: { id: "verified-output", role: "assistant", final: true, text: "真实交付正文" },
            observedAt: new Date().toISOString(),
          };
          if (action === "deliver") h.store.set("task_settled_outputs", output.entry.id, output);
          const event: OrchestrationEvent = {
            id: "notification-before-callback",
            taskId: task.id,
            trigger: action === "deliver" ? "output" : "ready",
            outputIds: action === "deliver" ? [output.entry.id] : [],
            userRevision: stableId(task.requirements),
            state: checkpoint === "sending" ? "done" : "attention",
            attempts: 1,
            dispatches: [],
            decision: { action, reason: "需要用户提供必需信息", outputId: output.entry.id },
            notified: false,
            notificationState: checkpoint,
            notificationAttempts: 1,
            error:
              checkpoint === "uncertain"
                ? {
                    code: "orchestration_notification_unknown",
                    message: "旧通知错误",
                    outcome: "unknown",
                  }
                : undefined,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          h.store.set("task_orchestration_events", event.id, event);
          const current = h.store.get<Task>("tasks", task.id);
          assert.ok(current);
          const unrelated = action === "deliver" && checkpoint === "uncertain";
          current.status = "attention";
          current.error = unrelated ? "另一个独立故障" : event.error?.message;
          h.service.records.save(current);
          const engine = new Engine();
          const replies: string[] = [];
          const worker = new TaskOrchestrator({
            store: h.store,
            tasks: () => h.service,
            tools: () => [],
            engine,
            signal: new AbortController().signal,
            logger,
            replyRetryable:
              evidence === "no-hook"
                ? undefined
                : async (proofTask, eventId) => {
                    assert.equal(proofTask.id, task.id);
                    assert.equal(eventId, event.id);
                    return evidence === "safe";
                  },
            onReply: async (replyTask, text, eventId) => {
              assert.equal(replyTask.id, task.id);
              assert.equal(eventId, event.id);
              replies.push(text);
            },
          });
          await worker.tick();
          await worker.tick();
          const saved = h.store.get<OrchestrationEvent>("task_orchestration_events", event.id);
          if (evidence === "safe") {
            assert.equal(replies.length, 1);
            assert.match(replies[0] ?? "", action === "deliver" ? /真实交付正文/ : /必需信息/);
            assert.equal(saved?.state, "done");
            assert.equal(saved?.notificationState, "sent");
            assert.equal(saved?.notified, true);
            assert.equal(saved?.error, undefined);
            assert.equal(
              h.store.get<Task>("tasks", task.id)?.error,
              unrelated ? "另一个独立故障" : undefined,
            );
          } else {
            assert.equal(replies.length, 0);
            assert.equal(saved?.state, "attention");
            assert.equal(saved?.notificationState, "uncertain");
            assert.equal(saved?.notified, false);
          }
          assert.equal(engine.calls.length, 0, "recovery never re-runs the model decision");
          assert.equal(h.herdr.sends.length, 0);
        } finally {
          h.close();
        }
      });
