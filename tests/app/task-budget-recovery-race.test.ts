import assert from "node:assert/strict";
import { test } from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { stableId } from "../../src/core/ids.js";
import type { Task } from "../../src/core/types.js";
import { actor, discussion, setup } from "../tasks/helpers.js";
import { Engine, logger } from "./helpers.js";

for (const mutation of ["pause", "close", "complete", "pending"] as const)
  test(`retired budget recovery preserves a ${mutation} committed after the worker snapshot`, async () => {
    const h = setup();
    try {
      h.config.ai.enabled = true;
      const task = await h.service.create(actor, {
        ...discussion,
        orchestration: { mode: "model" },
      });
      await h.service.reconcile(task.id);
      const event: OrchestrationEvent = {
        id: "retired-budget-race",
        taskId: task.id,
        trigger: "ready",
        outputIds: [],
        userRevision: stableId(task.requirements),
        state: "attention",
        attempts: 0,
        dispatches: [],
        error: { code: "orchestration_budget", message: "旧预算阻塞", outcome: "not_executed" },
        notified: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      h.store.set("task_orchestration_events", event.id, event);
      const attention = h.store.get<Task>("tasks", task.id);
      assert.ok(attention);
      attention.status = "attention";
      attention.error = event.error?.message;
      h.service.records.save(attention);
      const engine = new Engine();
      engine.handler = async (input) => {
        const decide = input.tools.find((tool) => tool.name === "orchestration_decide");
        assert.ok(decide);
        await decide.execute({ action: "wait", reason: "等待必需的用户决定。" }, input.actor);
        return { text: "", messages: [] };
      };
      const worker = new TaskOrchestrator({
        store: h.store,
        tasks: () => h.service,
        tools: () => [],
        engine,
        signal: new AbortController().signal,
        logger,
      });
      // tick has read its task snapshot and yielded at notification recovery.
      const run = worker.tick();
      const committed = h.store.get<Task>("tasks", task.id);
      assert.ok(committed);
      if (mutation === "pause") {
        committed.status = "paused";
        committed.discussion.paused = true;
      } else if (mutation === "close") committed.closeRequested = true;
      else if (mutation === "complete") committed.completionRequest = "complete";
      else {
        committed.pending = "native-operation-unknown";
        committed.error = "原生输入正在等待投递凭证";
      }
      h.service.records.save(committed);
      await run;
      const current = h.store.get<Task>("tasks", task.id);
      assert.equal(current?.status, committed.status);
      assert.equal(current?.discussion.paused, committed.discussion.paused);
      assert.equal(current?.closeRequested, committed.closeRequested);
      assert.equal(current?.completionRequest, committed.completionRequest);
      assert.equal(current?.pending, committed.pending);
      assert.equal(current?.error, committed.error);
      assert.equal(engine.calls.length, 0);
      const retained = h.store.get<OrchestrationEvent>("task_orchestration_events", event.id);
      assert.equal(retained?.state, "attention");
      assert.equal(retained?.retiredBudgetRecovery, undefined);
    } finally {
      h.close();
    }
  });
