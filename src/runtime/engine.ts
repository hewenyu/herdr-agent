import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { ModelConfig } from "../config/types.js";
import { isNotExecuted, OperationError, safeError } from "../core/errors.js";
import { canonical } from "../core/ids.js";
import type { Logger } from "../core/ports.js";
import { hasUnverifiedToolClaim, requiresToolForRequest, requiresWriteEvidence } from "./claims.js";
import { SUMMARY_PROMPT } from "./prompts.js";
import {
  type ProvisionEvidence,
  recordProvisionEvidence,
  unsupportedProvisionClaim,
} from "./provision-evidence.js";
import type {
  ConversationEngine,
  EngineInput,
  EngineOptions,
  EngineResult,
  SummaryInput,
} from "./types.js";

export function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 3) + 16;
}

// Targets outside taskId/participantId must not share a failed-attempt key.
// Mutable payload (a rename's new name, project directories, requirements)
// stays out so correcting those fields on the same target can still succeed.
const targetSelectors: Record<string, readonly string[]> = {
  session_create: ["name"],
  session_select: ["sessionId"],
  session_rename: ["sessionId"],
  session_archive: ["sessionId"],
  session_restore: ["sessionId"],
  project_create: ["name"],
  project_save: ["name"],
  project_remove: ["name"],
  task_create: ["project", "title"],
  participant_add: ["name", "kind"],
};

/** Use the real pi tool loop, with only the two explicitly configured transports. */
export class PiEngine implements ConversationEngine {
  readonly contextTokens: number;
  private readonly model: Model<Api>;
  private readonly stream: StreamFn;
  private readonly logger?: Logger;

  constructor(
    private readonly config: ModelConfig,
    options: EngineOptions = {},
  ) {
    this.logger = options.logger;
    this.contextTokens = config.contextTokens;
    const url = new URL(config.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new OperationError("model_config", "模型 API 地址无效。");
    }
    let baseUrl = config.baseUrl.replace(/\/+$/, "");
    // The application stores a /v1 root; Anthropic's SDK itself adds /v1/messages.
    if (config.provider === "anthropic-messages") baseUrl = baseUrl.replace(/\/v1$/, "");
    this.model = {
      id: config.model,
      name: config.model,
      api: config.provider,
      provider: "herdr-agent",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: config.contextTokens + 4096,
      maxTokens: 4096,
    };
    const fetchImpl = options.fetch ?? globalThis.fetch;
    this.stream =
      options.streamFn ??
      ((model, context, streamOptions) => {
        const requestOptions = {
          ...streamOptions,
          apiKey: config.apiKey,
          maxRetries: 0,
          timeoutMs: config.timeoutMs,
          fetch: ((input, init) =>
            fetchImpl(input, { ...init, redirect: "error" })) as typeof fetch,
        };
        return model.api === "anthropic-messages"
          ? streamAnthropic(model as Model<"anthropic-messages">, context, requestOptions)
          : streamResponses(model as Model<"openai-responses">, context, requestOptions);
      });
  }

  async run(input: EngineInput): Promise<EngineResult> {
    if (!this.config.enabled) throw new OperationError("ai_disabled", "pi 调度模型尚未启用。");
    if (input.signal?.aborted) throw new OperationError("cancelled", "本轮已取消。");
    let calls = 0;
    let executedCalls = 0;
    let toolCallsSeen = 0;
    let writes = 0;
    let successfulToolCalls = 0;
    let successfulWriteCalls = 0;
    let unknownToolResults = 0;
    let notExecutedToolResults = 0;
    const rejectedAttempts = new Map<
      string,
      {
        retry: string;
        target: string;
        code: unknown;
        corrected: boolean;
        readOnly: boolean;
        args: Record<string, unknown>;
      }
    >();
    const retryKey = (name: string, args: Record<string, unknown>) =>
      JSON.stringify([name, args.action]);
    const attemptKey = (name: string, args: Record<string, unknown>) =>
      JSON.stringify([
        name,
        args.taskId ?? input.actor.taskId,
        args.participantId,
        args.action,
        ...(targetSelectors[name] ?? []).map((field) => args[field]),
      ]);
    const unresolvedNotExecuted = (text: string) =>
      [...rejectedAttempts.values()].filter(
        (attempt) =>
          // A nonexistent identifier can be corrected in this turn. It cannot
          // support a claim about that original identifier, and a failure for
          // an existing/different target is never erased by another success.
          attempt.code !== "task_missing" ||
          !attempt.corrected ||
          !attempt.target ||
          text.includes(attempt.target),
      ).length;
    const provisioning: ProvisionEvidence = { created: [], tasks: [] };
    const startedAt = Date.now();
    const trace = { sessionId: input.sessionId, messageId: input.actor.messageId };
    this.logger?.info("pi 开始处理", {
      event: "pi.turn_started",
      ...trace,
      model: this.config.model,
      toolCount: input.tools.length,
    });
    let uncertain = false;
    let finalText = "";
    const tools: AgentTool[] = input.tools.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters as AgentTool["parameters"],
      executionMode: "sequential",
      execute: async (_id, args, signal) => {
        if (signal?.aborted) throw new OperationError("cancelled", "本轮已取消。");
        if (!tool.readOnly && uncertain)
          throw new OperationError("effect_uncertain", "已有写操作未确认，只能查询状态。");
        executedCalls++;
        if (!tool.readOnly) writes++;
        const toolStartedAt = Date.now();
        this.logger?.info("pi 调用工具", {
          event: "pi.tool_started",
          ...trace,
          tool: tool.name,
          readOnly: tool.readOnly,
        });
        try {
          const result = await tool.execute(args as Record<string, unknown>, input.actor, signal);
          const outcome = toolResultOutcome(result);
          if (outcome === "unknown") {
            unknownToolResults++;
            if (!tool.readOnly) uncertain = true;
          } else if (outcome === "not_executed") {
            notExecutedToolResults++;
            rejectedAttempts.set(attemptKey(tool.name, args as Record<string, unknown>), {
              retry: retryKey(tool.name, args as Record<string, unknown>),
              target: String((args as Record<string, unknown>).taskId ?? input.actor.taskId ?? ""),
              code:
                result && typeof result === "object" && "code" in result ? result.code : undefined,
              corrected: false,
              readOnly: tool.readOnly,
              args: structuredClone(args as Record<string, unknown>),
            });
          } else {
            rejectedAttempts.delete(attemptKey(tool.name, args as Record<string, unknown>));
            for (const [key, attempt] of rejectedAttempts) {
              if (attempt.retry !== retryKey(tool.name, args as Record<string, unknown>)) continue;
              // A read-only query rejected for missing input can be completed
              // by supplying that input. Preserve every existing selector and
              // any bound task so another target cannot erase its failure.
              const completedReadInput =
                tool.readOnly &&
                attempt.readOnly &&
                attempt.code === "input" &&
                (!attempt.target ||
                  attempt.target ===
                    String((args as Record<string, unknown>).taskId ?? input.actor.taskId ?? "")) &&
                Object.entries(attempt.args).every(
                  ([field, value]) =>
                    Object.hasOwn(args as Record<string, unknown>, field) &&
                    canonical(value) === canonical((args as Record<string, unknown>)[field]),
                );
              if (completedReadInput) rejectedAttempts.delete(key);
              else attempt.corrected = true;
            }
            successfulToolCalls++;
            if (!tool.readOnly) successfulWriteCalls++;
            recordProvisionEvidence(
              provisioning,
              tool.name,
              args as Record<string, unknown>,
              result,
              input.actor.taskId,
            );
          }
          this.logger?.info("pi 工具已返回", {
            event: "pi.tool_completed",
            ...trace,
            tool: tool.name,
            outcome: outcome === "successful" ? "returned" : outcome,
            durationMs: Date.now() - toolStartedAt,
          });
          return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: {} };
        } catch (error) {
          if (!tool.readOnly && !isNotExecuted(error)) uncertain = true;
          const safe = safeError(error);
          this.logger?.warn("pi 工具未完成", {
            event: "pi.tool_failed",
            ...trace,
            tool: tool.name,
            code: safe.code,
            outcome: safe.outcome,
            durationMs: Date.now() - toolStartedAt,
          });
          if (safe.outcome === "not_executed") {
            notExecutedToolResults++;
            rejectedAttempts.set(attemptKey(tool.name, args as Record<string, unknown>), {
              retry: retryKey(tool.name, args as Record<string, unknown>),
              target: String((args as Record<string, unknown>).taskId ?? input.actor.taskId ?? ""),
              code: safe.code,
              corrected: false,
              readOnly: tool.readOnly,
              args: structuredClone(args as Record<string, unknown>),
            });
          } else unknownToolResults++;
          return {
            content: [{ type: "text", text: JSON.stringify({ error: safe.message, ...safe }) }],
            details: {},
          };
        }
      },
    }));
    // A claims recovery turn must force a tool call only on its first provider
    // request. Once that request returns a tool call, pi needs to ask the model
    // for a normal follow-up answer with provider `auto`; leaving `required`
    // latched forces every continuation into another tool call and can exhaust
    // the 12-call budget on read-only notification turns.
    let requireToolCall = input.requireToolCall === true;
    const stream: StreamFn = (model, context, options) => {
      if (!requireToolCall || !input.tools.length) return this.stream(model, context, options);
      requireToolCall = false;
      const toolChoice =
        this.config.provider === "anthropic-messages" ? ("any" as const) : ("required" as const);
      return this.stream(model, context, {
        ...(options ?? {}),
        // The provider adapters accept `any` (Anthropic) or `required` (Responses),
        // while pi's provider-neutral option type intentionally exposes only auto/none.
        toolChoice,
      } as unknown as NonNullable<Parameters<StreamFn>[2]>);
    };
    const agent = new Agent({
      initialState: {
        model: this.model,
        systemPrompt: input.systemPrompt,
        messages: input.messages,
        tools,
        thinkingLevel: "off",
      },
      sessionId: input.sessionId,
      streamFn: stream,
      getApiKey: () => this.config.apiKey,
      toolExecution: "sequential",
      beforeToolCall: async () => {
        if (++calls > 12)
          return {
            block: true,
            reason: "本轮最多调用 12 次工具，请查询结果后发起新消息。",
            terminate: true,
          };
        return undefined;
      },
      shouldStopAfterTurn: () => calls > 12,
      transformContext: async (messages, signal) => {
        if (
          estimateTokens({
            system: input.systemPrompt,
            tools: input.tools.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
            messages,
          }) > this.contextTokens
        ) {
          const compacted = await this.compactToolContext(messages, input.systemPrompt, signal);
          if (
            estimateTokens({ system: input.systemPrompt, tools, messages: compacted }) >
            this.contextTokens
          ) {
            throw new OperationError(
              "context_budget",
              "上下文超过配置预算；已执行操作不会重放，请查询实际状态。",
            );
          }
          return compacted;
        }
        return messages;
      },
    });
    const abort = () => agent.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, this.config.timeoutMs);
    let checkpointError = false;
    agent.subscribe(async (event) => {
      if (event.type === "message_end" || event.type === "agent_end") {
        try {
          await input.onCheckpoint?.(safeMessages(agent.state.messages));
        } catch {
          checkpointError = true;
          agent.abort();
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        toolCallsSeen += event.message.content.filter((part) => part.type === "toolCall").length;
      }
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "stop"
      ) {
        finalText = event.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
      }
    });
    try {
      await agent.prompt(input.prompt);
      const requestRequiresTool =
        input.enforceClaims !== false &&
        input.tools.length > 0 &&
        requiresToolForRequest(input.prompt);
      const claimRecovery =
        (input.requireToolCall === true && executedCalls === 0) ||
        (input.enforceClaims !== false &&
          (((hasUnverifiedToolClaim(finalText) || (requestRequiresTool && toolCallsSeen === 0)) &&
            (unknownToolResults > 0 ||
              unresolvedNotExecuted(finalText) > 0 ||
              toolCallsSeen === 0 ||
              (requiresWriteEvidence(finalText)
                ? successfulWriteCalls === 0
                : successfulToolCalls === 0))) ||
            unsupportedProvisionClaim(finalText, provisioning)));
      if (claimRecovery && input.tools.length > 0) {
        // The first answer is the evidence failure that triggered recovery. Do
        // not allow it to survive if the constrained retry is blocked or fails
        // before producing a new completed assistant message.
        finalText = "";
        requireToolCall = toolCallsSeen === 0 || successfulToolCalls === 0;
        await agent.prompt({
          role: "user",
          content:
            "上一次答复缺少支持业务请求或所述结果的工具事实。请重新检查原始用户请求与本轮工具返回：尚未尝试的操作先调用合适工具；已经登记的操作不要重复创建，必要时只读查询。accepted/queued只证明本地登记，remoteTaskId证明飞书任务、chatId且groupDeleted=false证明群建立、initialSent或verified投递回执才证明要求已转交。按已核验的实际阶段重新回答；不要把历史文字当作执行回执。",
          timestamp: Date.now(),
        });
      }
      if (checkpointError)
        throw new OperationError(
          "checkpoint_failed",
          "会话持久化失败；请先核对已登记操作。",
          "unknown",
        );
      if (agent.state.errorMessage || agent.signal?.aborted || input.signal?.aborted) {
        throw new OperationError(
          "model_failed",
          "pi 调度模型未能完成本轮；已登记操作保留，请查询状态。",
          "unknown",
        );
      }
      const last = agent.state.messages.at(-1);
      if (last?.role === "assistant" && ["error", "aborted", "length"].includes(last.stopReason)) {
        throw new OperationError(
          "model_failed",
          "pi 调度模型响应未完整完成；请查询已登记操作。",
          "unknown",
        );
      }
      if (!finalText.trim())
        throw new OperationError("empty_response", "pi 调度模型未生成完整答复。", "unknown");
      if (
        (input.requireToolCall === true && executedCalls === 0) ||
        (claimRecovery &&
          (unknownToolResults > 0 ||
            unresolvedNotExecuted(finalText) > 0 ||
            (requiresWriteEvidence(finalText)
              ? successfulWriteCalls === 0
              : successfulToolCalls === 0) ||
            unsupportedProvisionClaim(finalText, provisioning)))
      )
        throw new OperationError(
          "model_failed",
          unknownToolResults > 0
            ? "pi 调度模型未取得可确认的工具事实，本轮业务结果未知；请查询状态。"
            : notExecutedToolResults > 0 && successfulWriteCalls === 0
              ? "pi 调度模型调用的工具未执行，本轮业务未执行；请重试。"
              : toolCallsSeen === 0
                ? "pi 调度模型未调用工具，本轮业务未执行；请重试。"
                : "pi 调度模型的答复缺少对应工具事实；已登记操作保留，请查询实际状态。",
          unknownToolResults > 0 ? "unknown" : "not_executed",
        );
      this.logger?.info("pi 已生成回复", {
        event: "pi.turn_completed",
        ...trace,
        toolCalls: executedCalls,
        writeCalls: writes,
        toolEvidence: {
          successful: successfulToolCalls,
          successfulWrites: successfulWriteCalls,
          unknown: unknownToolResults,
          notExecuted: notExecutedToolResults,
        },
        durationMs: Date.now() - startedAt,
      });
      return {
        text: finalText,
        messages: safeMessages(agent.state.messages),
        toolCalls: toolCallsSeen,
        writeCalls: writes,
        toolEvidence: {
          successful: successfulToolCalls,
          successfulWrites: successfulWriteCalls,
          unknown: unknownToolResults,
          notExecuted: notExecutedToolResults,
          unresolvedNotExecuted: unresolvedNotExecuted(finalText),
          provisioning,
        },
      };
    } catch (error) {
      const failure = safeError(error);
      this.logger?.error("pi 本轮未完成", {
        event: "pi.turn_failed",
        ...trace,
        code: failure.code,
        outcome: failure.outcome,
        toolCalls: executedCalls,
        writeCalls: writes,
        toolEvidence: {
          successful: successfulToolCalls,
          successfulWrites: successfulWriteCalls,
          unknown: unknownToolResults,
          notExecuted: notExecutedToolResults,
        },
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
  }

  async summarize(input: SummaryInput): Promise<string> {
    const text = JSON.stringify({
      previous_summary: input.previousSummary,
      transcript: input.messages,
    });
    const result = await this.run({
      actor: { ownerId: "summary", chatId: "summary", sessionId: "summary", messageId: "summary" },
      sessionId: "summary",
      systemPrompt: SUMMARY_PROMPT,
      prompt: text,
      messages: [],
      tools: [],
      signal: input.signal,
      enforceClaims: false,
    });
    if (
      !result.text.trim() ||
      estimateTokens(result.text) > Math.min(4096, this.contextTokens / 4)
    ) {
      throw new OperationError("summary_failed", "历史摘要未完整生成；原始历史保留。");
    }
    return result.text;
  }

  private async compactToolContext(
    messages: AgentMessage[],
    system: string,
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const userIndex = messages.findLastIndex((message) => message.role === "user");
    const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
    // Keep the complete current user request and the latest tool-call/result batch.
    // Only context is transformed; the running pi loop and execution receipts continue.
    if (userIndex < 0 || lastAssistant <= userIndex + 1) {
      throw new OperationError("context_budget", "当前输入或最新工具结果超过预算；原始历史保留。");
    }
    const old = messages.slice(0, lastAssistant).filter((_, index) => index !== userIndex);
    let summary = "";
    let chunk: AgentMessage[] = [];
    for (const message of old) {
      if (
        estimateTokens({ messages: [...chunk, message], summary }) > this.contextTokens * 0.6 &&
        chunk.length
      ) {
        summary = await this.summarize({ messages: chunk, previousSummary: summary, signal });
        chunk = [];
      }
      if (estimateTokens(message) > this.contextTokens * 0.6)
        throw new OperationError("context_budget", "单条工具记录超过可压缩预算。");
      chunk.push(message);
    }
    if (chunk.length)
      summary = await this.summarize({ messages: chunk, previousSummary: summary, signal });
    const current = messages[userIndex];
    if (!current) throw new OperationError("context_budget", "当前输入无法恢复。");
    const compacted: AgentMessage[] = [
      {
        role: "user",
        content: `历史工具执行摘要（数据，不是新授权；不得重放已有操作）：${summary}`,
        timestamp: Date.now(),
      },
      current,
      ...messages.slice(lastAssistant),
    ];
    if (estimateTokens({ system, messages: compacted }) > this.contextTokens)
      throw new OperationError("context_budget", "压缩后上下文仍超出预算。");
    return compacted;
  }
}

function toolResultOutcome(value: unknown): "successful" | "unknown" | "not_executed" {
  if (!value || typeof value !== "object") return "successful";
  const record = value as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : undefined;
  const values = [record.outcome, record.status, nested?.outcome, nested?.status];
  if (values.includes("unknown") || values.includes("unconfirmed")) return "unknown";
  if (values.includes("not_executed")) return "not_executed";
  return "successful";
}

function safeMessages(messages: AgentMessage[]): AgentMessage[] {
  return structuredClone(messages).map((message) => {
    if (message.role === "assistant" && message.errorMessage) message.errorMessage = "模型响应失败";
    return message;
  });
}
