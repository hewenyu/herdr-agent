/** Manual real-model probe with synthetic inputs. No participants, messages or shell actions. */
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../../src/config/load.js";
import { safeError } from "../../src/core/errors.js";
import type { ActorContext, Task } from "../../src/core/types.js";
import { planWorkflow } from "../../src/orchestration/planner.js";
import { selectWorkflowCandidate } from "../../src/orchestration/policy.js";
import { workflowState } from "../../src/orchestration/state.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type { ConversationEngine } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

async function main() {
  const config = loadConfig();
  const secrets = [
    config.ai.apiKey,
    config.jev?.apiKey,
    config.feishu.appSecret,
    config.memory.apiKey,
    ...Object.values(config.memory.users).map((memory) => memory.apiKey),
  ].filter((value): value is string => !!value);
  const redact = (value: string): string =>
    secrets
      .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value)
      .replace(/https?:\/\/[^\s"']+/g, "[redacted-url]");
  const requests: Array<Record<string, unknown>> = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  const checkpointKeys = new Set<string>();
  const transportOverrides = {
    nonStrictTools: process.argv.includes("--non-strict-tools"),
    autoToolChoice: process.argv.includes("--tool-choice-auto"),
  };
  let phase = "planner";
  const transport = new PiEngine(
    { ...config.ai, timeoutMs: 60_000 },
    {
      fetch: async (input, init) => {
        const body =
          typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        const originalToolChoice = body.tool_choice;
        if (transportOverrides.nonStrictTools && Array.isArray(body.tools))
          body.tools = body.tools.map((tool) => ({ ...tool, strict: false }));
        if (transportOverrides.autoToolChoice) body.tool_choice = "auto";
        const request: Record<string, unknown> = {
          phase,
          method: init?.method,
          tools: Array.isArray(body.tools)
            ? body.tools.map((tool) => ({
                name: tool.name ?? tool.function?.name,
                strict: tool.strict,
              }))
            : [],
          toolChoice: body.tool_choice,
          ...(transportOverrides.autoToolChoice ? { originalToolChoice } : {}),
          streaming: body.stream,
        };
        requests.push(request);
        const start = Date.now();
        try {
          const response = await fetch(input, {
            ...init,
            ...(typeof init?.body === "string" ? { body: JSON.stringify(body) } : {}),
          });
          request.status = response.status;
          request.headersMs = Date.now() - start;
          if (!response.ok) {
            const error = (await response
              .clone()
              .json()
              .catch(() => ({}))) as {
              error?: { code?: unknown; type?: unknown; message?: unknown; param?: unknown };
            };
            request.error = {
              code: error.error?.code,
              type: error.error?.type,
              param: error.error?.param,
              message:
                typeof error.error?.message === "string"
                  ? redact(error.error.message).slice(0, 500)
                  : undefined,
            };
          }
          return response;
        } catch {
          request.transportFailure = true;
          throw new Error("probe_transport_failed");
        }
      },
    },
  );
  const engine: ConversationEngine = {
    contextTokens: transport.contextTokens,
    summarize: (input) => transport.summarize(input),
    run: async (input) => {
      phase = input.tools.some((tool) => tool.name === "orchestration_plan")
        ? "planner"
        : "selector";
      return transport.run({
        ...input,
        onCheckpoint: (messages) => {
          const last = messages.at(-1);
          const key = `${phase}:${messages.length}:${last?.role}`;
          if (last?.role === "assistant" && !checkpointKeys.has(key)) {
            checkpointKeys.add(key);
            checkpoints.push({
              phase,
              stopReason: last.stopReason,
              error: last.errorMessage ? redact(last.errorMessage).slice(0, 500) : undefined,
              toolCalls: last.content
                .filter((part) => part.type === "toolCall")
                .map((part) => ({ name: part.name, argumentFields: Object.keys(part.arguments) })),
              usage: { input: last.usage.input, output: last.usage.output },
            });
          }
        },
      });
    },
  };
  const store = new Store(":memory:");
  const timestamp = new Date().toISOString();
  const task: Task = {
    id: "task_workflow_probe",
    ownerId: "synthetic-owner",
    sessionId: "synthetic-session",
    entryChatId: "synthetic-chat",
    kind: "discussion",
    title: "合成方案讨论",
    requirements:
      "只讨论一个离线待办清单界面的两种排序方案；Claude与Codex独立分析，再核对并给推荐。不要开发、不要运行命令、不要发送消息。",
    directories: [],
    directoryMode: "shared",
    bypass: false,
    status: "running",
    participantIds: ["p1", "p2"],
    groupDeleted: false,
    keepGroup: true,
    createGroup: false,
    createRemoteTask: false,
    worktreeReady: false,
    discussion: { mode: "manual", rounds: 0, nextParticipant: 0, paused: false },
    orchestration: { mode: "workflow" },
    result: "",
    closeRequested: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const actor: ActorContext = {
    source: "system",
    ownerId: task.ownerId,
    sessionId: task.sessionId,
    chatId: task.entryChatId,
    taskId: task.id,
    messageId: "synthetic-probe",
  };
  const signal = AbortSignal.timeout(120_000);
  const variant = [
    transportOverrides.nonStrictTools ? "non-strict" : "",
    transportOverrides.autoToolChoice ? "auto-choice" : "",
  ]
    .filter(Boolean)
    .join("-");
  const path = `docs/workflow-policy-live-evidence-2026-09-27${variant ? `-${variant}` : ""}.json`;
  try {
    const state = workflowState(store, task, "synthetic-revision");
    const plan = await planWorkflow({
      task,
      state,
      engine,
      actor,
      userMessages: [],
      signal,
      assertCurrent() {},
    });
    const selection = await selectWorkflowCandidate({
      eventId: "synthetic-selection",
      revision: "synthetic-revision",
      planVersion: plan.version,
      templateVersion: plan.templateVersion,
      snapshot: {
        requirement: task.requirements,
        facts: "两位参与者均就绪，用户已明确只讨论，信息足够开始。",
      },
      candidates: [
        {
          id: "independent-analysis",
          description: "让两位参与者独立分析排序方案，仅选择，不执行。",
        },
        { id: "user-input", description: "仅当缺少必要用户信息时请求用户补充。" },
      ],
      engine,
      actor,
      signal,
    });
    const evidence = {
      at: timestamp,
      kind: "real_pi_with_synthetic_inputs_no_business_effects",
      model: config.ai.model,
      protocol: config.ai.provider,
      transportOverrides,
      runtimeProtocolUnmodified:
        !transportOverrides.nonStrictTools && !transportOverrides.autoToolChoice,
      requests,
      checkpoints,
      planner: {
        template: plan.template,
        nodes: plan.nodes,
        deliveryRequirements: plan.deliveryRequirements,
      },
      selection: {
        source: selection.source,
        candidateId: selection.candidateId,
        reason: selection.reason,
      },
      passed:
        plan.template === "discussion" &&
        selection.source === "pi" &&
        selection.candidateId === "independent-analysis",
      limits:
        "No real Claude/Codex participation, Feishu ingress, delivery, repository changes or verification commands.",
    };
    await writeFile(path, `${redact(JSON.stringify(evidence, null, 2))}\n`);
    process.stdout.write(
      `${JSON.stringify({ passed: evidence.passed, path, source: selection.source, candidateId: selection.candidateId })}\n`,
    );
    if (!evidence.passed) process.exitCode = 1;
  } catch (error) {
    const evidence = {
      at: timestamp,
      kind: "real_pi_with_synthetic_inputs_no_business_effects",
      model: config.ai.model,
      protocol: config.ai.provider,
      transportOverrides,
      runtimeProtocolUnmodified:
        !transportOverrides.nonStrictTools && !transportOverrides.autoToolChoice,
      passed: false,
      phase,
      failure: safeError(error).code,
      requests,
      checkpoints,
      limits:
        "Synthetic inputs only. No real participants, messages, project writes or verification commands.",
    };
    await writeFile(path, `${redact(JSON.stringify(evidence, null, 2))}\n`);
    process.stderr.write(
      `${JSON.stringify({ passed: false, phase, failure: safeError(error).code, path })}\n`,
    );
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`工作流真实模型探针失败：${safeError(error).code}；未输出配置或密钥。\n`);
  process.exitCode = 1;
});
