import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { automaticApprovalFixture } from "./automatic-approval-helpers.js";

for (const [name, defect] of [
  ["negative attempts", { attempts: -1 }],
  ["fractional attempts", { attempts: 0.5 }],
  ["unknown state", { state: "unrecognized" }],
  ["mismatched identity", { id: "another-decision" }],
] as const) {
  test(`damaged automatic authority (${name}) cannot select or send another key`, async () => {
    const h = await automaticApprovalFixture();
    try {
      assert.equal(await h.handle(), "handled");
      const entry = h.store.entries<Record<string, unknown>>("automatic_approval_decisions")[0];
      assert.ok(entry);
      const [id, decision] = entry;
      const corrupt = { ...decision, ...defect };
      h.store.set("automatic_approval_decisions", id, corrupt);
      h.screen.agent.status = "blocked";
      h.screen.agent.stateSeq = "200";
      h.screen.text = "Permission dialog v201\n❯ Allow once\n  Cancel\nConfirm with Enter";
      h.choose("option:1");
      const writes = [...h.writes];
      const requests = h.requests.length;
      const error: unknown = await h.handle().then(
        () => undefined,
        (cause: unknown) => cause,
      );
      assert.deepEqual(h.writes, writes);
      assert.equal(h.requests.length, requests);
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "automatic_approval_record_invalid");
      assert.deepEqual(h.store.get("automatic_approval_decisions", id), corrupt);
    } finally {
      await h.close();
    }
  });
}
