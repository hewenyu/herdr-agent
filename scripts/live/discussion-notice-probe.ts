/** Real model with controlled participant facts; no tools, Feishu messages, or task effects. */
import { notificationParticipants } from "../../src/app/notifications.js";
import { loadConfig } from "../../src/config/load.js";
import type { Participant } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { NOTIFICATION_PROMPT } from "../../src/runtime/prompts.js";

async function run() {
  const config = loadConfig();
  const engine = new PiEngine({ ...config.ai, timeoutMs: 60_000 });
  for (const scenario of [
    "done-without-output",
    "one-output-waiting-turn",
    "budget-paused",
  ] as const) {
    const ended = scenario === "budget-paused";
    const participants: Participant[] = ["claude", "codex"].map((kind, index) => ({
      id: `participant-${index}`,
      taskId: "discussion-fixture",
      name: kind,
      kind: kind as "claude" | "codex",
      role: "讨论者",
      status: "done",
      started: true,
      initialSent: index === 0 || ended,
      initialReceipt: "fixture-only",
      lastOutput:
        ended || (index === 0 && scenario === "one-output-waiting-turn")
          ? `${kind}的已采集观点：只讨论需求，不修改项目代码。`
          : undefined,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    }));
    const task = {
      id: "discussion-fixture",
      title: "Claude与Codex讨论需求",
      kind: "discussion",
      status: "review",
      requirements: "请Claude和Codex讨论需求，只讨论不开发，最多1轮。",
      chatId: "oc_fixture",
      groupDeleted: false,
      participantIds: participants.map((participant) => participant.id),
      discussion: {
        mode: "round_robin",
        rounds: ended ? 1 : 0,
        maxRounds: 1,
        maxMinutes: 30,
        nextParticipant: 0,
        activeParticipant: participants[0]?.id,
        paused: ended,
      },
    };
    const actor = {
      ownerId: "probe-owner",
      chatId: task.chatId,
      taskId: task.id,
      sessionId: `notice-probe-${scenario}`,
      messageId: scenario,
    };
    const result = await engine.run({
      actor,
      sessionId: actor.sessionId,
      systemPrompt: NOTIFICATION_PROMPT,
      prompt: JSON.stringify({
        event: "progress",
        task,
        participants: notificationParticipants(participants),
      }),
      messages: [],
      tools: [],
    });
    process.stdout.write(
      `${JSON.stringify({
        model: config.ai.model,
        provider: config.ai.provider,
        scenario,
        response: result.text,
        judgment: "manual_review_required",
        evidence: "real_model_with_synthetic_discussion_records; no_tools_or_external_effects",
      })}\n`,
    );
  }
}
void run().catch(() => {
  process.stderr.write("讨论通知探针未全部完成，未输出配置。\n");
  process.exitCode = 1;
});
