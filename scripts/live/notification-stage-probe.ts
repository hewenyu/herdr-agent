/** Real model, synthetic event records, no tools or external resource effects. */
import { loadConfig } from "../../src/config/load.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { NOTIFICATION_PROMPT } from "../../src/runtime/prompts.js";

async function run() {
  const config = loadConfig();
  const engine = new PiEngine({ ...config.ai, timeoutMs: Math.min(config.ai.timeoutMs, 60_000) });
  const only = process.argv[process.argv.indexOf("--only") + 1];
  const events = ["welcome", "blocked", "completed"] as const;
  for (const event of events.filter(
    (value) => !process.argv.includes("--only") || value === only,
  )) {
    const task = {
      id: "task_notification_fixture",
      title: "HTML SVG双人比武",
      status: event === "welcome" ? "starting" : event,
      requirements: "完成后等待用户验收，不自动完成或关闭任务。",
      completedAt: event === "completed" ? "2026-09-18T01:00:00.000Z" : undefined,
      closeRequested: false,
      chatId: "oc_notification_fixture",
      remoteTaskId: "remote_notification_fixture",
      participantIds: ["p1"],
      groupDeleted: false,
    };
    const participants = [
      {
        id: "p1",
        name: "Codex",
        kind: "codex",
        started: event !== "welcome",
        initialSent: event !== "welcome",
        status: event === "welcome" ? "pending" : event === "completed" ? "done" : "blocked",
      },
    ];
    const actor = {
      ownerId: "probe-owner",
      source: "system" as const,
      chatId: task.chatId,
      taskId: task.id,
      sessionId: `notification-probe-${event}`,
      messageId: `notification-probe-${event}`,
    };
    const result = await engine.run({
      actor,
      sessionId: actor.sessionId,
      systemPrompt: NOTIFICATION_PROMPT,
      prompt: JSON.stringify({ event, task, participants }),
      messages: [],
      tools: [],
    });
    process.stdout.write(
      `${JSON.stringify({
        model: config.ai.model,
        provider: config.ai.provider,
        scenario: event,
        response: result.text,
        judgment: "manual_review_required",
        evidence: "real_model_with_synthetic_event_records; no_tools_or_external_effects",
      })}\n`,
    );
  }
}
void run().catch(() => {
  process.stderr.write("通知阶段事实探针未完成，未输出配置。\n");
  process.exitCode = 1;
});
