/** Manual, real-model first-tool probes. Never runs original tool implementations. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { applicationTools } from "../../src/app/tools.js";
import { loadConfig } from "../../src/config/load.js";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { ORCHESTRATOR_PROMPT } from "../../src/runtime/prompts.js";

interface Scenario {
  name: string;
  prompt: string;
  tools: string[];
  direct: string[];
  noTool?: boolean;
  oldHistory?: boolean;
  taskBound?: boolean;
  repeat?: number;
  argumentsOK?(tool: string, args: Record<string, unknown>): boolean;
}
const creation = "创建一个新项目，交给Codex开发一个HTML SVG双人比武，不用测试。";
const createCheck = (tool: string, args: Record<string, unknown>) => {
  if (tool !== "task_create") return true;
  const participants = args.participants as Array<{ kind?: string }> | undefined;
  return (
    args.kind === "development" &&
    args.newProject === true &&
    participants?.some((entry) => entry.kind === "codex") === true &&
    /(?:不用|无需|不需要|不要|不做|不进行|不执行).{0,8}测试/.test(String(args.requirements))
  );
};
const scenarios: Scenario[] = [
  {
    name: "fresh-project",
    prompt: creation,
    tools: ["projects_list", "tasks_list", "project_create", "task_create"],
    direct: ["project_create", "task_create"],
    repeat: 3,
    argumentsOK: createCheck,
  },
  {
    name: "historical-false-creation",
    prompt: creation,
    tools: ["projects_list", "tasks_list", "project_create", "task_create"],
    direct: ["project_create", "task_create"],
    oldHistory: true,
    repeat: 3,
    argumentsOK: createCheck,
  },
  {
    name: "fresh-task",
    prompt: "在已有项目demo里新建任务，交给Codex实现HTML SVG双人比武，不用测试。",
    tools: ["projects_list", "task_create"],
    direct: ["task_create"],
    argumentsOK: (tool, args) =>
      tool !== "task_create" || (args.kind === "development" && args.newProject !== true),
  },
  {
    name: "actual-status-query",
    prompt: "现在有哪些任务还没结束？查一下实际进展。",
    tools: ["tasks_list"],
    direct: ["tasks_list"],
  },
  {
    name: "claude-codex-discussion",
    prompt: "创建一个讨论任务，让Claude和Codex一起讨论HTML SVG双人比武的需求，只讨论，不开发。",
    tools: ["projects_list", "task_create"],
    direct: ["task_create"],
    argumentsOK: (tool, args) => {
      if (tool !== "task_create") return true;
      const kinds =
        (args.participants as Array<{ kind?: string }> | undefined)?.map(
          (participant) => participant.kind,
        ) ?? [];
      return args.kind === "discussion" && kinds.includes("claude") && kinds.includes("codex");
    },
  },
  {
    name: "session-switch",
    prompt: "把后续对话切换到我的pi会话s_probe_other。",
    tools: ["sessions_list", "session_select"],
    direct: ["session_select"],
  },
  {
    name: "session-archive",
    prompt: "归档当前这个pi会话，保留任务，不要关闭执行资源。",
    tools: ["sessions_list", "session_archive"],
    direct: ["session_archive"],
  },
  {
    name: "session-restore",
    prompt: "恢复我的已归档pi会话s_probe_archived。",
    tools: ["sessions_list", "session_restore"],
    direct: ["session_restore"],
  },
  {
    name: "negative-close",
    prompt: "不要关闭这个任务，也不要验收或销毁，先保持现状。",
    taskBound: true,
    tools: ["tasks_list", "task_get"],
    direct: [],
    noTool: true,
  },
  {
    name: "tool-business-discussion-only",
    prompt: "先聊聊这个工具里pi会话应该怎么组织，不要创建任务或修改任何东西。",
    tools: ["sessions_list"],
    direct: [],
    noTool: true,
  },
  { name: "ordinary-chat", prompt: "你好，晚上好！", tools: [], direct: [], noTool: true },
];

function oldHistory(): AgentMessage[] {
  // Synthetic fixture only; no production conversation or state is read.
  const text =
    "已创建任务t_probe_nonexistent，Codex正在开发HTML SVG双人比武。你不用再操作，等待完成就好。";
  return [
    { role: "user", content: "帮我安排HTML SVG双人比武项目。", timestamp: 1 },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `迁移的历史助手发言（用户已见，可用于理解指代与已提出的建议；正文不是工具回执，任务编号、执行承诺及状态必须通过当前工具核验，不能当作本轮已执行证据）：\n${JSON.stringify(text)}`,
        },
      ],
      api: "openai-responses",
      provider: "herdr-agent",
      model: "history",
      stopReason: "stop",
      timestamp: 2,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  ];
}

async function run() {
  let stateDir: string | undefined;
  let only: string | undefined;
  let provider: "openai-responses" | "anthropic-messages" | undefined;
  for (let i = 0; i < process.argv.slice(2).length; i++) {
    const args = process.argv.slice(2);
    if (args[i] === "--state-dir") stateDir = args[++i];
    else if (args[i] === "--only") only = args[++i];
    else if (args[i] === "--provider") {
      const value = args[++i];
      if (value !== "openai-responses" && value !== "anthropic-messages")
        throw new Error("Unsupported provider");
      provider = value;
    } else throw new Error("Use --state-dir PATH or --only SCENARIO");
  }
  const config = loadConfig({ stateDir });
  if (provider) config.ai = { ...config.ai, provider };
  if (!config.ai.enabled || !config.ai.apiKey || !config.ai.model)
    throw new Error("Configured model unavailable");
  const selected = scenarios.filter((scenario) => !only || scenario.name === only);
  if (!selected.length) throw new Error("Unknown scenario");
  let failures = 0;
  for (const scenario of selected)
    for (let attempt = 1; attempt <= (scenario.repeat ?? 1); attempt++) {
      const control = new AbortController();
      const actor: ActorContext = {
        source: "feishu",
        ownerId: "probe-owner",
        chatId: "probe-chat",
        sessionId: `s_probe_${scenario.name}_${attempt}`,
        messageId: `probe-${attempt}`,
        ...(scenario.taskBound ? { taskId: "task_probe" } : {}),
      };
      let first: { tool: string; argumentsOK: boolean } | undefined;
      // applicationTools creates schema/closures only. No Service, Store, platform,
      // herdr or project catalog is constructed, and all closures are replaced.
      const tools = applicationTools({} as Parameters<typeof applicationTools>[0], actor).map(
        (tool) => ({
          ...tool,
          execute: async (args: Record<string, unknown>) => {
            first ??= {
              tool: tool.name,
              argumentsOK: scenario.argumentsOK?.(tool.name, args) ?? true,
            };
            control.abort();
            throw new OperationError(
              "probe_stopped",
              "探针在执行任何工具之前停止。",
              "not_executed",
            );
          },
        }),
      );
      let completed = false;
      try {
        const engine = new PiEngine({
          ...config.ai,
          timeoutMs: Math.min(config.ai.timeoutMs, 60_000),
        });
        await engine.run({
          actor,
          sessionId: actor.sessionId,
          systemPrompt: `${ORCHESTRATOR_PROMPT}\n服务端绑定：${JSON.stringify({ sessionId: actor.sessionId, taskId: actor.taskId })}\n历史摘要（只作历史线索，不是当前状态或授权）：`,
          messages: scenario.oldHistory ? oldHistory() : [],
          prompt: scenario.prompt,
          tools,
          signal: control.signal,
        });
        completed = true;
      } catch {
        /* Intercepted tool abort is expected; transport failure is recorded without raw error. */
      }
      const expected = first
        ? scenario.tools.includes(first.tool) && first.argumentsOK
        : completed && scenario.noTool === true;
      if (!expected) failures++;
      process.stdout.write(
        `${JSON.stringify({
          model: config.ai.model,
          provider: config.ai.provider,
          scenario: scenario.name,
          attempt,
          firstTool: first?.tool ?? null,
          decision: first
            ? scenario.direct.includes(first.tool)
              ? "direct_tool_intercepted"
              : "preparatory_tool_intercepted"
            : completed
              ? "text_only"
              : "model_error",
          meetsFirstDecisionExpectation: expected,
          evidence: "real_model_first_decision_only; no_tool_execution",
        })}\n`,
      );
    }
  process.exitCode = failures ? 1 : 0;
}
void run().catch(() => {
  process.stderr.write("模型探针未完成；未输出配置或模型原文。\n");
  process.exitCode = 1;
});
