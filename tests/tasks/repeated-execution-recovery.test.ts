import assert from "node:assert/strict";
import test from "node:test";
import type { Participant } from "../../src/core/types.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import type { ExecutionRecovery } from "../../src/tasks/execution-recovery.js";
import { recordTrustEffect, startupTrustStatus } from "../../src/tasks/readiness.js";
import { TaskService } from "../../src/tasks/service.js";
import { actor, discussion, setup } from "./helpers.js";

for (const [legacy, phase] of [
  [false, "ready"],
  [true, "ready"],
  [false, "starting"],
  [false, "awaiting_trust"],
] as const) {
  test(`a closed replacement is repaired again without fresh business input (${phase}, legacy=${legacy})`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    let outputs = 0;
    const h = setup({
      output: async () => {
        outputs += 1;
      },
    });
    try {
      const task = await h.service.create(actor, {
        ...discussion,
        participants: [{ kind: "codex", name: "Codex" }],
      });
      await h.service.tick();
      const original = h.service.get(actor, task.id).participants[0];
      assert.ok(original?.execution);
      h.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
      await assert.rejects(h.service.send(actor, task.id, original.id, "old uncertain work"));
      h.herdr.agents.delete(original.execution.paneId);
      const start = h.herdr.startAgent.bind(h.herdr);
      h.herdr.startAgent = async (...args) => {
        const agent = await start(...args);
        if (phase === "starting")
          Object.assign(agent, { launchPending: true, interactiveReady: false });
        if (phase === "awaiting_trust") Object.assign(agent, { status: "blocked" });
        h.herdr.agents.set(agent.paneId, agent);
        return agent;
      };
      await h.service.tick();
      h.herdr.startAgent = start;
      const first = h.service.get(actor, task.id).participants[0];
      assert.ok(first?.execution && first.executionRecovery);
      assert.equal(first.recoveryPending, true);
      const journal = h.store.get<ExecutionRecovery>(
        "execution_recoveries",
        first.executionRecovery,
      );
      assert.ok(journal);
      assert.equal(journal.state, phase === "ready" ? "ready" : "building");
      if (legacy) {
        delete journal.at;
        h.store.set("execution_recoveries", journal.id, journal);
      }
      const trustId = `${first.id}:directory-trust:uncertain`;
      recordTrustEffect(h.store, first as Participant, trustId);
      h.store.set<OperationReceipt>("operations", trustId, {
        id: trustId,
        fingerprint: "startup-trust",
        state: "uncertain",
        updatedAt: new Date().toISOString(),
      });
      const receipts = h.store.entries<OperationReceipt>("operations");
      const sends = h.herdr.sends.length;
      h.herdr.finish(first.execution.paneId, "unsolicited output from unused replacement");
      h.herdr.agents.delete(first.execution.paneId);
      await h.service.tick();
      await new TaskService(h.options).tick();
      assert.equal(h.herdr.creates, 2, "rapid exits do not churn workspaces");
      t.mock.timers.tick(60_001);
      await new TaskService(h.options).tick();
      const next = h.service.get(actor, task.id).participants[0];
      assert.ok(next?.execution && next.executionRecovery);
      assert.notEqual(next.execution.paneId, first.execution.paneId);
      assert.notEqual(next.executionRecovery, first.executionRecovery);
      assert.equal(next.id, first.id);
      assert.equal(next.recoveryPending, true, "lifecycle repair never resumes business input");
      assert.equal(h.service.get(actor, task.id).discussion.paused, true);
      assert.equal(h.herdr.creates, 3);
      assert.equal(h.herdr.starts, 3);
      assert.equal(h.herdr.sends.length, sends);
      assert.equal(outputs, 0, "an unused replacement cannot produce a business completion");
      assert.deepEqual(h.store.get("execution_recoveries", journal.id), journal);
      for (const [id, receipt] of receipts)
        assert.deepEqual(h.store.get("operations", id), receipt);
      assert.equal(startupTrustStatus(h.store, next as Participant).frozen, false);
      assert.equal(startupTrustStatus(h.store, first as Participant).frozen, true);
      await new TaskService(h.options).tick();
      assert.equal(h.herdr.creates, 3, "a live replacement is never recreated");
      h.herdr.agents.delete(next.execution.paneId);
      await new TaskService(h.options).tick();
      assert.equal(h.herdr.creates, 3, "each replacement has its own durable cooldown");
    } finally {
      h.close();
    }
  });
}
