import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import type { InboxRecord } from "../../src/app/inbox.js";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { applicationTools } from "../../src/app/tools.js";
import { canonical, stableId } from "../../src/core/ids.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { retryUnsentInput } from "../../src/tasks/input-delivery.js";
import { deferred, logger, message, setup } from "./helpers.js";

for (const interruption of ["foreground", "cancelled"] as const)
  test(`background input rechecks ${interruption} after baseline reads and resumes from its durable refusal`, async () => {
    const h = setup();
    const entered = deferred();
    const release = deferred();
    let restarted: Application | undefined;
    let running: Promise<void> | undefined;
    let toolControl = new AbortController();
    let time = Date.now();
    const sample = h.herdr.sampleLastReply.bind(h.herdr);
    h.engine.handler = async (input) => {
      if (!input.sessionId.startsWith("orchestration:"))
        return { text: '{"notify":false,"text":""}', messages: [] };
      const state = JSON.parse(input.prompt);
      const send = input.tools.find((tool) => tool.name === "participant_send");
      const decide = input.tools.find((tool) => tool.name === "orchestration_decide");
      assert.ok(send && decide);
      await send.execute(
        { participantId: state.participants[0].id, text: "完成本轮已授权的工作" },
        input.actor,
        toolControl.signal,
      );
      await decide.execute({ action: "continue", reason: "等待实际执行结果" }, input.actor);
      return { text: "", messages: [] };
    };
    const worker = (app: Application) =>
      new TaskOrchestrator({
        store: h.store,
        engine: h.engine,
        tasks: () => app.tasks,
        tools: (actor) => applicationTools(app, actor),
        signal: app.signal,
        logger,
        clock: () => time,
      });
    try {
      const task = await h.app.tasks.create(
        { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "goal" },
        {
          kind: "development",
          title: "读基线期间的优先级",
          requirements: "完成本轮工作",
          project: "project",
          participants: [{ kind: "codex" }],
          orchestration: { mode: "model" },
          createGroup: true,
          createRemoteTask: false,
        },
      );
      await h.app.tasks.reconcile(task.id);
      assert.notEqual(
        h.app.tasks.records.get({ ownerId: "owner", chatId: "entry" }, task.id).chatId,
        "entry",
      );
      h.herdr.sampleLastReply = async (...args) => {
        entered.resolve();
        await release.promise;
        return sample(...args);
      };
      running = worker(h.app).tick();
      await entered.promise;
      if (interruption === "foreground") {
        await h.app.handlers().message(message("foreground", "当前任务进度是什么？"));
        const inbox = h.store.get<InboxRecord>("inbox", "message:foreground");
        assert.equal(inbox?.state, "queued");
        assert.equal(
          inbox?.actor?.taskId,
          undefined,
          "main private chat has no task-group binding",
        );
      } else toolControl.abort();
      release.resolve();
      await running;
      const event = h.store.list<OrchestrationEvent>("task_orchestration_events")[0];
      assert.ok(event);
      assert.equal(event.state, "pending");
      const operationId = event.dispatches[0]?.operationId;
      assert.ok(operationId);
      const receipt = h.store.get<OperationReceipt>("operations", operationId);
      assert.equal(receipt?.state, "failed");
      assert.equal(receipt?.error?.outcome, "not_executed");
      assert.equal(
        receipt?.error?.code,
        interruption === "foreground" ? "orchestration_deferred" : "cancelled",
      );
      assert.equal(h.herdr.sends.length, 0);
      assert.equal(h.store.get("input_deliveries", operationId), undefined);
      assert.equal(
        h.store.get("participant_awaiting_output", task.participantIds[0] as string),
        undefined,
      );
      if (interruption === "foreground")
        assert.equal(event.attempts, 0, "admission waits are not model failures");

      // Keep the failed receipt intact across a service restart. Recovery must
      // depend on its durable not-executed fact, not an in-memory catch cleanup.
      await h.app.shutdown();
      if (interruption === "foreground") {
        const inbox = h.store.get<InboxRecord>("inbox", "message:foreground");
        assert.ok(inbox);
        h.store.set("inbox", inbox.id, { ...inbox, state: "done" });
      }
      h.herdr.sampleLastReply = sample;
      toolControl = new AbortController();
      time += 10_000;
      restarted = new Application({
        config: h.config,
        store: h.store,
        herdr: h.herdr,
        engine: h.engine,
        platform: h.platform,
        logger,
      });
      const resumed = worker(restarted);
      await resumed.tick();
      await resumed.tick();
      assert.equal(h.herdr.sends.length, 1);
      assert.equal(h.store.get<OperationReceipt>("operations", operationId)?.state, "done");
      assert.equal(h.store.get("input_retry_counts", operationId), undefined);
      const completed = h.store.get<OrchestrationEvent>("task_orchestration_events", event.id);
      assert.equal(completed?.state, "done");
      assert.equal(completed?.decision?.action, "continue");
      assert.equal(
        h.store.list("task_orchestration_events").length,
        1,
        "same event resumes without duplicating the user's goal",
      );
    } finally {
      release.resolve();
      if (running) await Promise.allSettled([running]);
      await restarted?.shutdown();
      await h.close();
    }
  });

test("admission recovery preserves unknown, completed and conflicting input receipts", async () => {
  const h = setup();
  const parameters = { participant: "participant", text: "same native input" };
  const fingerprint = stableId(canonical(parameters));
  try {
    const receipts: OperationReceipt[] = [
      { id: "pending", fingerprint, state: "pending", updatedAt: "before-restart" },
      {
        id: "done",
        fingerprint,
        state: "done",
        result: { verified: true },
        updatedAt: "before-restart",
      },
      {
        id: "uncertain",
        fingerprint,
        state: "uncertain",
        error: { code: "cancelled", message: "unknown cancellation", outcome: "unknown" },
        updatedAt: "before-restart",
      },
      {
        id: "failed-unknown",
        fingerprint,
        state: "failed",
        error: {
          code: "orchestration_deferred",
          message: "not a definite refusal",
          outcome: "unknown",
        },
        updatedAt: "before-restart",
      },
      {
        id: "conflicting",
        fingerprint: "another-input",
        state: "failed",
        error: {
          code: "cancelled",
          message: "another input was cancelled",
          outcome: "not_executed",
        },
        updatedAt: "before-restart",
      },
    ];
    for (const receipt of receipts) {
      h.store.set("operations", receipt.id, receipt);
      retryUnsentInput(h, receipt.id, parameters);
      assert.deepEqual(h.store.get("operations", receipt.id), receipt);
    }
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    await h.close();
  }
});
