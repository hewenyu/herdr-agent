import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { fail } from "../../src/core/errors.js";
import type { PlanningAssistanceLog } from "../../src/orchestration/assistance.js";
import { WorkflowOrchestrator, type WorkflowPorts } from "../../src/orchestration/runner.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

for (const interruption of ["cancelled", "orchestration_superseded", "workflow_artifact_changed"]) {
  test(`planning wait handles ${interruption} while preparing the user decision`, async () => {
    const h = setup();
    try {
      h.config.ai.enabled = true;
      assert.ok(h.config.jev);
      h.config.jev.apiKey = "fixture-only";
      const repo = join(h.directory, "repo");
      mkdirSync(repo);
      const source = join(repo, "README.md");
      writeFileSync(source, "original project source");
      await h.catalog.save({ name: "planning-wait", directories: [repo], agent: "codex" });
      const created = await h.service.create(actor, {
        ...discussion,
        project: "planning-wait",
        orchestration: { mode: "workflow" },
      });
      await h.service.reconcile(created.id);
      const task = { ...h.service.records.get(actor, created.id), promptVersion: 3 as const };
      const controller = new AbortController();
      const engine = new Engine();
      engine.handler = async () => {
        throw new Error("an interrupted wait must not invoke pi");
      };
      const events = () => h.store.list<OrchestrationEvent>("task_orchestration_events");
      let revision = "original-input";
      let interrupted = false;
      let jevCalls = 0;
      let notices = 0;
      const ports: WorkflowPorts = {
        store: h.store,
        config: h.config,
        tasks: () => h.service,
        engine,
        tools: () => [],
        signal: controller.signal,
        logger,
        current: () => task,
        foregroundPending: () => false,
        revision: () => revision,
        baseRevision: () => revision,
        userMessages: () => [],
        events,
        outputs: () => [],
        save: (event) => h.store.set("task_orchestration_events", event.id, event),
        assertCurrent: (event) => {
          // The final planning log is saved only after the selector's own guards.
          // A new interruption here therefore occurs inside prepareUserDecision.
          const deferred = h.store
            .list<PlanningAssistanceLog>("workflow_planning_decisions")
            .some((entry) => entry.decision === "deferred");
          if (deferred && !interrupted) {
            interrupted = true;
            if (interruption === "cancelled") controller.abort();
            else if (interruption === "orchestration_superseded") revision = "new-user-input";
            else writeFileSync(source, "project changed during question preparation");
          }
          if (controller.signal.aborted) fail("cancelled", "fixture stopped");
          if (event.userRevision !== revision)
            fail("orchestration_superseded", "fixture input superseded");
          return task;
        },
        reconcile() {},
        notify: async () => {
          notices++;
        },
        attention: async () => {
          notices++;
        },
        recoverNotification: async () => {},
        fetch: async (_url, init) => {
          jevCalls++;
          const ids = Object.keys(JSON.parse(String(init?.body)).questions.action.criteria);
          const primary = ids.includes("use_template");
          const choice = primary ? "use_template" : "wait_for_evidence";
          const confidence = primary ? 0.55 : 0.99;
          assert.ok(ids.includes(choice));
          return Response.json({
            model: "jev-fixture",
            answers: {
              action: {
                type: "choice",
                choice,
                confidence,
                probabilities: Object.fromEntries(
                  ids.map((id) => [
                    id,
                    id === choice ? confidence : (1 - confidence) / (ids.length - 1),
                  ]),
                ),
              },
            },
            usage: { input_tokens: 10, output_tokens: 1 },
          });
        },
      };

      await assert.doesNotReject(new WorkflowOrchestrator(ports).process(task));

      assert.equal(jevCalls, 2, "the planning selector first asks Jev whether to wait");
      assert.ok(interrupted, "the failure occurred after the planning defer decision");
      assert.equal(events().length, 1);
      const event = events()[0];
      assert.equal(event?.error?.code, interruption);
      assert.equal(event?.state, interruption === "cancelled" ? "pending" : "superseded");
      assert.equal(event?.attempts, interruption === "cancelled" ? 0 : 1);
      assert.equal(event?.nextAttemptAt, undefined);
      assert.deepEqual(event?.dispatches, []);
      const state = h.store.get<WorkflowState>(WORKFLOWS, task.id);
      assert.equal(state?.planning, "needed");
      assert.equal(state?.userDecision, undefined);
      assert.equal(state?.assistanceWait, undefined);
      assert.equal(engine.calls.length, 0);
      assert.equal(notices, 0);
      assert.equal(h.herdr.sends.length, 0);
    } finally {
      h.close();
    }
  });
}
