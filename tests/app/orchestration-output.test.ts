import assert from "node:assert/strict";
import test from "node:test";
import { orchestrationOutputTool } from "../../src/app/orchestration-output.js";
import type { SettledTaskOutput } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import { MODEL_RESULT_MAX_BYTES } from "../../src/runtime/model-context.js";

const actor = {
  ownerId: "owner",
  sessionId: "leader",
  taskId: "task",
  chatId: "chat",
  messageId: "event",
};
function output(text: string): SettledTaskOutput {
  return {
    taskId: "task",
    participantId: "participant",
    entry: { id: "output", role: "assistant", final: true, text },
    observedAt: new Date(0).toISOString(),
  };
}
interface Page {
  text: string;
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
}

for (const unit of ["\u0000", "\ud800", '"\\\n', "中文🙂"])
  test(`native output pages bound the complete envelope and preserve ${JSON.stringify(unit)}`, async () => {
    const source = output(unit.repeat(12000));
    let checks = 0;
    const tool = orchestrationOutputTool(
      () => [source],
      () => {
        checks++;
      },
    );
    const pages: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = (await tool.execute(
        { outputId: "output", offset, limit: 12000 },
        actor,
      )) as Page;
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MODEL_RESULT_MAX_BYTES);
      assert.equal(page.offset, offset);
      assert.equal(page.totalCharacters, source.entry.text.length);
      assert.ok(page.nextOffset === null || page.nextOffset > offset);
      pages.push(page.text);
      offset = page.nextOffset;
    }
    assert.equal(pages.join(""), source.entry.text);
    assert.ok(pages.length > 1);
    assert.equal(checks, pages.length);
  });

test("native output reads reject foreign IDs, invalid pages and stale revisions", async () => {
  const tool = orchestrationOutputTool(
    () => [output("original")],
    () => {},
  );
  await assert.rejects(tool.execute({ outputId: "foreign" }, actor), {
    code: "orchestration_evidence",
  });
  for (const args of [
    { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 12001 },
    { offset: "0" },
  ])
    await assert.rejects(tool.execute({ outputId: "output", ...args }, actor), { code: "input" });
  const stale = orchestrationOutputTool(
    () => {
      assert.fail("must check revision before reads");
    },
    () => {
      throw new OperationError("orchestration_superseded", "new revision");
    },
  );
  await assert.rejects(stale.execute({ outputId: "output" }, actor), {
    code: "orchestration_superseded",
  });
});

test("native output metadata cannot bypass the serialized result bound", async () => {
  const source = { ...output("text"), participantId: "m".repeat(MODEL_RESULT_MAX_BYTES) };
  const tool = orchestrationOutputTool(
    () => [source],
    () => {},
  );
  await assert.rejects(tool.execute({ outputId: "output" }, actor), { code: "context_budget" });
});
