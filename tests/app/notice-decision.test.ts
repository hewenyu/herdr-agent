import assert from "node:assert/strict";
import test from "node:test";
import { noticeDecision } from "../../src/app/notice-decision.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type { LifecycleEvidence } from "../../src/runtime/lifecycle-evidence.js";
import type { EngineInput } from "../../src/runtime/types.js";
import { config, response, scripted } from "../runtime/helpers.js";

const facts: LifecycleEvidence = {
  task: {
    id: "task_notice",
    status: "completed",
    closeRequested: true,
    chatId: "test-group",
    groupDeleted: false,
    keepGroup: false,
    groupRetentionSource: "default",
  },
  participants: [{ id: "p1", name: "Codex", kind: "codex", started: true, status: "gone" }],
};
const input: EngineInput = {
  actor: { ownerId: "owner", chatId: "test-group", sessionId: "notice", messageId: "notice" },
  sessionId: "notice",
  prompt: JSON.stringify({ event: "before_group_delete", ...facts }),
  systemPrompt: "Decide whether to notify and write JSON from lifecycle facts.",
  tools: [],
  messages: [],
  enforceClaims: false,
};

test("actual pi rewrites a premature completion notice without sending it or requiring tools", async () => {
  const corrected = "Codex 执行器已关闭；群将在本条通知送达后解散。";
  let calls = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response(JSON.stringify({ notify: true, text: "已完成收尾，任务群即将解散。" })),
        response(JSON.stringify({ notify: true, text: corrected })),
      ],
      () => calls++,
    ),
  });
  assert.deepEqual(await noticeDecision(engine, input, facts), { notify: true, text: corrected });
  assert.equal(calls, 2);
});

test("a repeated unsupported notice fails before any candidate can be persisted", async () => {
  const text = JSON.stringify({ notify: true, text: "群已解散，全部处理完毕。" });
  const engine = new PiEngine(config, { streamFn: scripted([response(text), response(text)]) });
  await assert.rejects(noticeDecision(engine, input, facts), { code: "notice_fact_missing" });
});

test("model can decline a notice and verified notices need no repair", async () => {
  for (const decision of [
    { notify: false, text: "" },
    { notify: true, text: "任务已确认完成，群即将解散。" },
  ]) {
    const engine = new PiEngine(config, {
      streamFn: scripted([response(JSON.stringify(decision))]),
    });
    assert.deepEqual(await noticeDecision(engine, input, facts), decision);
  }
});
