import assert from "node:assert/strict";
import { test } from "node:test";
import { actor, discussion, setup } from "./helpers.js";

for (const requirements of [
  '只讨论，最多120字。只输出JSON对象，字段为"结论"；不要列未决问题，不要附加说明。',
  "只讨论，最多120字。只输出两项未决问题，不要给方案或总结。",
]) {
  test(`discussion prompts preserve user format across first and relayed turns: ${requirements}`, async () => {
    const outputs: string[] = [];
    const h = setup({
      output: async (_task, _participant, entry) => {
        outputs.push(entry.text);
      },
    });
    try {
      const task = await h.service.create(actor, { ...discussion, requirements });
      await h.service.tick();
      const first = h.service.get(actor, task.id).participants[0];
      assert.ok(first?.execution);
      // An overlong response remains evidence of noncompliance, never a truncated success.
      const overlong = "没有遵守篇幅限制的原始回复。".repeat(20);
      h.herdr.finish(first.execution.paneId, overlong);
      await h.service.tick();
      assert.equal(h.herdr.sends.length, 2);
      for (const sent of h.herdr.sends) {
        assert.ok(sent.text.includes(`用户要求：\n${requirements}`));
        assert.match(sent.text, /用户明确指定的篇幅、输出格式和是否列出未决问题优先/);
        assert.match(sent.text, /用户未指定时，按需要/);
        assert.doesNotMatch(sent.text, /给出具体观点、未决问题和方案；/);
        assert.match(sent.text, /不要修改项目文件或开始开发/);
        assert.match(sent.text, /等待用户或调度器安排下一轮/);
      }
      assert.ok(h.herdr.sends[1]?.text.includes("本轮安排："));
      assert.ok(h.herdr.sends[1]?.text.includes(overlong));
      assert.deepEqual(outputs, [overlong]);
    } finally {
      h.close();
    }
  });
}
