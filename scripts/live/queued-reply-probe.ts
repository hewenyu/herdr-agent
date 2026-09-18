/** Real-model narration probe with synthetic, explicitly isolated tool state. No real tools run. */
import { applicationTools } from "../../src/app/tools.js";
import { loadConfig } from "../../src/config/load.js";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { ORCHESTRATOR_PROMPT } from "../../src/runtime/prompts.js";

async function run() {
  const config = loadConfig();
  if (!config.ai.enabled || !config.ai.apiKey) throw new Error("model unavailable");
  const scenarios = process.argv.includes("--once")
    ? (["queued", "resources-created-input-not-sent"] as const)
    : (["queued", "queued", "queued", "resources-created-input-not-sent"] as const);
  for (const state of scenarios) {
    const actor: ActorContext = {
      ownerId: "probe-owner",
      source: "web",
      chatId: "probe-chat",
      sessionId: `probe-${state}-${Date.now()}`,
      messageId: "probe-request",
    };
    const calls: string[] = [];
    const task = {
      id: "task_probe_fixture",
      ownerId: actor.ownerId,
      sessionId: actor.sessionId,
      title: "投递阶段验收",
      kind: "development",
      requirements: "交给Codex制作HTML SVG双人比武，不用测试。",
      status: "queued",
      project: "probe-project",
      createGroup: true,
      createRemoteTask: true,
      participantIds: ["participant_probe_fixture"],
      groupDeleted: false,
    };
    const tools = applicationTools({} as Parameters<typeof applicationTools>[0], actor).map(
      (tool) => ({
        ...tool,
        execute: async () => {
          calls.push(tool.name);
          if (tool.name === "projects_list")
            return {
              projects: [
                { name: "probe-project", agent: "codex", directories: ["/fixture/never-created"] },
              ],
              defaultProject: "probe-project",
              bypass: false,
            };
          if (tool.name === "tasks_list") return [];
          if (tool.name === "task_create") return { accepted: true, task };
          if (tool.name === "task_get")
            return {
              ...task,
              ...(state === "resources-created-input-not-sent"
                ? {
                    status: "starting",
                    remoteTaskId: "remote_probe_fixture",
                    chatId: "oc_probe_fixture",
                  }
                : {}),
              participants: [
                {
                  id: "participant_probe_fixture",
                  kind: "codex",
                  status: "pending",
                  started: false,
                  initialSent: false,
                },
              ],
            };
          throw new OperationError("probe_unavailable", "此验收上下文没有其他已确认操作。");
        },
      }),
    );
    try {
      const engine = new PiEngine({
        ...config.ai,
        timeoutMs: Math.min(config.ai.timeoutMs, 60_000),
      });
      const result = await engine.run({
        actor,
        sessionId: actor.sessionId,
        systemPrompt: `${ORCHESTRATOR_PROMPT}\n服务端绑定：${JSON.stringify({ sessionId: actor.sessionId })}`,
        prompt:
          "在已有项目probe-project里创建一个任务，交给Codex制作HTML SVG双人比武，创建专属任务群，不用测试。请告诉我现在实际办到了哪一步。",
        messages: [],
        tools,
      });
      process.stdout.write(
        `${JSON.stringify({
          model: config.ai.model,
          provider: config.ai.provider,
          scenario: state,
          turn: 1,
          toolCalls: calls,
          response: result.text,
          judgment: "manual_review_required",
          evidence: "real_model_with_synthetic_tool_returns; no_external_effects",
        })}\n`,
      );
      calls.length = 0;
      const followup = await engine.run({
        actor: { ...actor, messageId: "probe-followup" },
        sessionId: actor.sessionId,
        systemPrompt: `${ORCHESTRATOR_PROMPT}\n服务端绑定：${JSON.stringify({ sessionId: actor.sessionId })}`,
        prompt: "所以现在任务群已经有了，而且已经交给Codex开始做了，对吗？请核实现在的状态。",
        messages: result.messages,
        tools,
      });
      process.stdout.write(
        `${JSON.stringify({
          model: config.ai.model,
          provider: config.ai.provider,
          scenario: state,
          turn: 2,
          toolCalls: calls,
          response: followup.text,
          judgment: "manual_review_required",
          evidence: "real_model_with_synthetic_tool_returns; no_external_effects",
        })}\n`,
      );
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          model: config.ai.model,
          scenario: state,
          toolCalls: calls,
          result: "model_error",
          evidence: "real_model_with_synthetic_tool_returns; no_external_effects",
        })}\n`,
      );
      process.exitCode = 1;
    }
  }
}
void run().catch(() => {
  process.stderr.write("阶段事实探针未完成，未输出配置。\n");
  process.exitCode = 1;
});
