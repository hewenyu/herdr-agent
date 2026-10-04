import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { automaticApprovalFixture as fixture } from "./automatic-approval-helpers.js";

// A corrupt history row could hide an executing/uncertain write, so it refuses
// typed rather than being filtered out; the row is preserved and no key is sent.
test("a corrupt automatic decision row refuses typed and sends no key", async () => {
  const h = await fixture();
  try {
    assert.equal(await h.handle(), "handled");
    const entry = h.store.entries<Record<string, unknown>>("automatic_approval_decisions")[0];
    assert.ok(entry, "a decision row exists after the first automatic write");
    const [id, decision] = entry;
    const corrupt = { ...decision, retryAt: { toString: null } };
    h.store.set("automatic_approval_decisions", id, corrupt);
    // Re-observe the same blocked participant at a fresh screen so the scope
    // guard passes and the corrupt history is actually read.
    h.screen.agent.status = "blocked";
    h.screen.agent.stateSeq = "200";
    h.screen.text = "Permission dialog v201\n❯ Allow once\n  Cancel\nConfirm with Enter";
    h.choose("option:1");
    const writes = [...h.writes];
    await assert.rejects(
      h.handle(),
      (error: unknown) =>
        error instanceof OperationError && error.code === "automatic_approval_record_invalid",
    );
    assert.deepEqual(h.writes, writes, "a corrupt record must not trigger a native write");
    assert.deepEqual(h.store.get("automatic_approval_decisions", id), corrupt);
  } finally {
    await h.close();
  }
});
