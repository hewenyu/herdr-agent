import assert from "node:assert/strict";
import test from "node:test";
import { DirectoryTrust } from "../../src/app/directory-trust.js";
import { OperationError } from "../../src/core/errors.js";
import { stableId } from "../../src/core/ids.js";
import type { HerdrPort } from "../../src/core/ports.js";
import { executionGeneration } from "../../src/tasks/readiness.js";
import { automaticApprovalFixture } from "./automatic-approval-helpers.js";
import { logger } from "./helpers.js";

for (const [defect, row] of [
  ["negative attempts", { attempts: -1, retryAt: new Date(0).toISOString() }],
  ["fractional attempts", { attempts: 0.5, retryAt: new Date(0).toISOString() }],
  ["array record", []],
] as const) {
  test(`damaged directory-trust decision (${defect}) cannot replenish the model budget`, async () => {
    const h = await automaticApprovalFixture();
    try {
      const ref = h.participant.execution;
      assert.ok(ref);
      const id = stableId(
        h.participant.id,
        executionGeneration(h.participant),
        ref.paneId,
        h.screen.agent.stateSeq,
        "native-directory-v4",
        "",
      );
      h.store.set("directory_trust_decisions", id, row);
      let calls = 0;
      h.engine.handler = async () => {
        calls++;
        return { text: "No confirmation", messages: [] };
      };
      (h.herdr as HerdrPort).trustDirectory = async () => {
        assert.fail("a damaged decision must not authorize directory trust");
      };
      const trust = new DirectoryTrust(
        h.store,
        h.herdr,
        h.engine,
        logger,
        new AbortController().signal,
      );
      const error: unknown = await trust.handle(h.task, h.participant, h.screen, h.actor).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      assert.equal(calls, 0);
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "directory_trust_record_invalid");
      assert.deepEqual(h.store.get("directory_trust_decisions", id), row);
    } finally {
      await h.close();
    }
  });
}
