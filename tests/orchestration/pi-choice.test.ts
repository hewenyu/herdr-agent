import assert from "node:assert/strict";
import test from "node:test";
import { chooseWithPi } from "../../src/orchestration/pi-choice.js";
import { Engine } from "../app/helpers.js";
import { actor } from "../tasks/helpers.js";

for (const selection of ["allowed", "illegal", "empty", "error"])
  test(`restricted pi choice handles ${selection} without a service fallback`, async () => {
    const engine = new Engine();
    let checked = 0;
    engine.handler = async (input) => {
      assert.deepEqual(
        input.tools.map((tool) => tool.name),
        ["orchestration_choice"],
      );
      assert.equal(input.tools[0]?.readOnly, true);
      if (selection === "error") throw new Error("private provider body");
      if (selection !== "empty")
        await input.tools[0]?.execute({ candidateId: selection }, input.actor);
      return { text: "allowed", messages: [] };
    };
    const result = await chooseWithPi({
      engine,
      actor,
      sessionId: "restricted-choice-test",
      state: { data: "untrusted material" },
      candidates: [{ id: "allowed", description: "the only allowed action" }],
      assertCurrent() {
        checked++;
      },
    });
    assert.equal(result.adapterVersion, "workflow-pi-choice-v1");
    assert.equal(
      result.status,
      selection === "allowed" ? "success" : selection === "error" ? "error" : "invalid",
    );
    assert.equal(result.candidateId, selection === "allowed" ? "allowed" : undefined);
    assert.ok(checked >= 2);
    assert.equal(JSON.stringify(result).includes("private provider body"), false);
  });

test("restricted pi choice rechecks revisions after provider failure", async () => {
  const engine = new Engine();
  let checks = 0;
  engine.handler = async () => {
    throw new Error("provider failure");
  };
  await assert.rejects(
    chooseWithPi({
      engine,
      actor,
      sessionId: "stale-choice",
      state: {},
      candidates: [{ id: "allowed", description: "allowed" }],
      assertCurrent() {
        if (++checks > 1) throw new Error("stale revision");
      },
    }),
    /stale revision/,
  );
});
