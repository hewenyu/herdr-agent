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
import type { Logger } from "../core/ports.js";
import { evaluateClaimPolicy } from "./claim-policy.js";
import { requiresToolForRequest } from "./claims.js";
import {
  boundToolResultContent,
  boundToolResultMessage,
  MODEL_RESULT_MAX_BYTES,
  modelInputBudgetTokens,
  serializedBytes,
} from "./model-context.js";
import { SUMMARY_PROMPT } from "./prompts.js";
import { type ProvisionEvidence, recordProvisionEvidence } from "./provision-evidence.js";
import { isPageReadValue } from "./result-projection-pages.js";
import type {
  ConversationEngine,
  EngineInput,
  EngineOptions,
  EngineResult,
  SummaryInput,
  ToolResultProjectionInput,
} from "./types.js";

export function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 3) + 16;
}

/** Budget inputs and per-run bookkeeping for the model-facing context surface. */
interface ModelSurface {
  system: string;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  /** Input tokens available for system + tools + messages (output reserve removed). */
  budget: number;
  project?: EngineInput["projectToolResult"];
  /** Persist the compacted transcript before any request that depends on it. */
  persist?: (messages: AgentMessage[]) => Promise<void> | void;
  /** First typed failure raised while preparing a request; rethrown outside the loop. */
  failure?: OperationError;
  /** Oversized value with no durable projection; reported, never silently inlined. */
  lossy?: { tool: string; bytes: number };
  /** Leading messages folded into `summary`: one durable prefix, shared with checkpoints. */
  compaction?: { keptFrom: number; anchor: string; summary: string };
  /** Write calls that already reached their canonical effect boundary. */
  writes: number;
  /** Per-call error flags, applied through pi's documented afterToolCall hook. */
  errorResults: Map<string, boolean>;
}

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
      provider: "myrix",
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
    let executedCalls = 0;
    let toolCallsSeen = 0;
    let writes = 0;
    let successfulToolCalls = 0;
    let successfulWriteCalls = 0;
    let unknownToolResults = 0;
    let notExecutedToolResults = 0;
    const rejectedAttempts = new Map<
      string,
      { retry: string; target: string; code: unknown; corrected: boolean }
    >();
    const retryKey = (name: string, args: Record<string, unknown>) =>
      JSON.stringify([name, args.action]);
    const attemptKey = (name: string, args: Record<string, unknown>) =>
      JSON.stringify([name, args.taskId ?? input.actor.taskId, args.participantId, args.action]);
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
    const surface: ModelSurface = {
      system: input.systemPrompt,
      tools: input.tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
      budget: modelInputBudgetTokens(this.contextTokens),
      project: input.projectToolResult,
      persist: input.onCheckpoint
        ? async (messages) => {
            await input.onCheckpoint?.(safeMessages(messages));
          }
        : undefined,
      writes: 0,
      errorResults: new Map(),
    };
    this.logger?.info("pi 开始处理", {
      event: "pi.turn_started",
      ...trace,
      model: this.config.model,
      toolCount: input.tools.length,
    });
    let uncertain = false;
    let finalText = "";
    let closed = false;
    const operationTimeouts = new Set<ReturnType<typeof setTimeout>>();
    // Protect each individual provider request or tool operation from hanging.
    // Completed work clears its timer; there is no cumulative turn-time quota.
    const watchOperation = () => {
      const timeout = setTimeout(() => abort(), this.config.timeoutMs);
      operationTimeouts.add(timeout);
      return () => {
        clearTimeout(timeout);
        operationTimeouts.delete(timeout);
      };
    };
    if (input.resume) {
      const previousCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
      for (const message of input.messages) {
        if (message.role === "assistant")
          for (const part of message.content) {
            if (part.type === "toolCall") {
              toolCallsSeen++;
              previousCalls.set(part.id, { name: part.name, args: part.arguments });
            }
          }
        if (message.role !== "toolResult") continue;
        const call = previousCalls.get(message.toolCallId);
        const tool = input.tools.find((candidate) => candidate.name === call?.name);
        if (!call || !tool) continue;
        let value: unknown;
        try {
          value = JSON.parse(
            message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          );
        } catch {
          continue;
        }
        const outcome = toolResultOutcome(value);
        if (outcome === "unknown") {
          unknownToolResults++;
          if (!tool.readOnly) uncertain = true;
        } else if (outcome === "not_executed" || message.isError) {
          notExecutedToolResults++;
          rejectedAttempts.set(attemptKey(call.name, call.args), {
            retry: retryKey(call.name, call.args),
            target: String(call.args.taskId ?? input.actor.taskId ?? ""),
            code: value && typeof value === "object" && "code" in value ? value.code : undefined,
            corrected: false,
          });
        } else {
          successfulToolCalls++;
          if (!tool.readOnly) {
            successfulWriteCalls++;
            writes++;
          }
          rejectedAttempts.delete(attemptKey(call.name, call.args));
          recordProvisionEvidence(provisioning, call.name, call.args, value, input.actor.taskId);
        }
      }
    }
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
        if (!tool.readOnly) {
          writes++;
          surface.writes++;
        }
        const toolStartedAt = Date.now();
        this.logger?.info("pi 调用工具", {
          event: "pi.tool_started",
          ...trace,
          tool: tool.name,
          readOnly: tool.readOnly,
        });
        const stopWatching = watchOperation();
        try {
          const result = await tool.execute(args as Record<string, unknown>, input.actor, signal);
          // Outcome and provisioning evidence are evaluated on the canonical
          // value, BEFORE the model-facing projection can change or fail it.
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
            });
          } else {
            rejectedAttempts.delete(attemptKey(tool.name, args as Record<string, unknown>));
            for (const attempt of rejectedAttempts.values()) {
              if (attempt.retry === retryKey(tool.name, args as Record<string, unknown>))
                attempt.corrected = true;
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
          const projected = await this.projectResult(surface, {
            tool: tool.name,
            args: args as Record<string, unknown>,
            toolCallId: _id,
            result,
            isError: outcome !== "successful",
            timestamp: toolStartedAt,
          });
          this.logger?.info("pi 工具已返回", {
            event: "pi.tool_completed",
            ...trace,
            tool: tool.name,
            outcome: outcome === "successful" ? "returned" : outcome,
            durationMs: Date.now() - toolStartedAt,
          });
          surface.errorResults.set(_id, outcome !== "successful");
          return { content: [{ type: "text", text: projected }], details: {} };
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
            });
          } else unknownToolResults++;
          const envelope = { error: safe.message, ...safe };
          // Error envelopes go through the same canonical-first projection and
          // byte bound as successful results; a giant error is never inlined.
          const projected = await this.projectResult(surface, {
            tool: tool.name,
            args: args as Record<string, unknown>,
            toolCallId: _id,
            result: envelope,
            isError: true,
            timestamp: toolStartedAt,
          });
          surface.errorResults.set(_id, true);
          return { content: [{ type: "text", text: projected }], details: {} };
        } finally {
          stopWatching();
        }
      },
    }));
    // A claims recovery turn must force a tool call only on its first provider
    // request. Once that request returns a tool call, pi needs to ask the model
    // for a normal follow-up answer with provider `auto`; leaving `required`
    // latched forces every continuation into another unnecessary tool call.
    let requireToolCall = input.requireToolCall === true;
    const stream: StreamFn = async (model, context, options) => {
      if (closed || input.signal?.aborted) throw new OperationError("cancelled", "本轮已取消。");
      // A failed context preparation must never fall back to an unbounded
      // request. The typed failure is rethrown after the loop settles.
      if (surface.failure || surface.lossy) {
        const refused =
          surface.failure ??
          new OperationError(
            "context_budget",
            "工具结果超出模型上下文容量且没有可用的持久化投影；已执行的操作不会重放，请查询实际状态。",
          );
        throw refused;
      }
      const stopWatching = watchOperation();
      try {
        let requestOptions = options;
        if (requireToolCall && input.tools.length) {
          requireToolCall = false;
          const toolChoice =
            this.config.provider === "anthropic-messages"
              ? ("any" as const)
              : ("required" as const);
          requestOptions = {
            ...(options ?? {}),
            // The provider adapters accept `any` (Anthropic) or `required` (Responses),
            // while pi's provider-neutral option type exposes only auto/none.
            toolChoice,
          } as unknown as NonNullable<Parameters<StreamFn>[2]>;
        }
        // Old checkpoints retain their protocol identity on disk. Treat the former
        // product name as an alias only for transport, preserving signatures and IDs.
        const requestContext = {
          ...context,
          messages: context.messages.map((message) =>
            message.role === "assistant" && message.provider === "herdr-agent"
              ? { ...message, provider: "myrix" }
              : message,
          ),
        };
        const response = await this.stream(model, requestContext, requestOptions);
        // Receiving the stream object is not completion: cover stalled bodies
        // and adapters that ignore AbortSignal until their final result exists.
        void response.result().then(stopWatching, stopWatching);
        return response;
      } catch (error) {
        stopWatching();
        throw error;
      }
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
      // pi documents that both hooks must never throw: throwing interrupts the
      // low-level loop without a normal event sequence, which would surface as an
      // untyped failure and could hide an already confirmed write. Both hooks
      // catch internally and return a safe fallback; the typed failure is
      // rethrown by `run` after the loop has settled.
      transformContext: async (messages, signal) => {
        try {
          return await this.boundRequestContext(messages, surface, signal);
        } catch (error) {
          surface.failure ??= this.contextFailure(error, successfulWriteCalls > 0 || uncertain);
          // A safe fallback, not a silent success: the loop stops at the next
          // request boundary because `stream` refuses to send this context.
          return messages;
        }
      },
      afterToolCall: async (context) => {
        const isError = surface.errorResults.get(context.toolCall.id);
        return isError === undefined ? undefined : { isError };
      },
    });
    let rejectAborted!: (reason: OperationError) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    const abort = () => {
      agent.abort();
      rejectAborted(
        new OperationError("model_failed", "pi 调度回复已中断；已登记的操作保留。", "unknown"),
      );
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    let checkpointError = false;
    agent.subscribe(async (event) => {
      if (closed) return;
      if (event.type === "message_end" || event.type === "agent_end") {
        try {
          // Persist the ACTUAL compacted Agent state, not a temporary request
          // view: a resume must replay exactly what the run was using, or
          // compaction would be undone by its own checkpoint.
          await input.onCheckpoint?.(
            safeMessages(this.checkpointMessages(agent.state.messages, surface)),
          );
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
      await Promise.race([
        agent.prompt(
          input.resume
            ? "继续完成检查点中原始用户请求尚未完成的部分。此前工具结果是本轮持久事实，已确认的操作不要重复执行；缺少结果的调用已用恢复回执明确标记。请查询必要状态并给出完整答复。"
            : input.prompt,
        ),
        aborted,
      ]);
      const requestRequiresTool =
        input.enforceClaims !== false &&
        input.tools.length > 0 &&
        requiresToolForRequest(input.prompt);
      const claimPolicy = (requireEvidence = false) =>
        evaluateClaimPolicy(
          finalText,
          {
            successful: successfulToolCalls,
            successfulWrites: successfulWriteCalls,
            unknown: unknownToolResults,
            notExecuted: notExecutedToolResults,
            unresolvedNotExecuted: unresolvedNotExecuted(finalText),
            provisioning,
          },
          requireEvidence,
        );
      const claimRecovery =
        input.enforceClaims !== false &&
        claimPolicy(requestRequiresTool && toolCallsSeen === 0).rejected;
      if (claimRecovery && input.tools.length > 0) {
        // The first answer is the evidence failure that triggered recovery. Do
        // not allow it to survive if the constrained retry is blocked or fails
        // before producing a new completed assistant message.
        finalText = "";
        requireToolCall = toolCallsSeen === 0 || successfulToolCalls === 0;
        await Promise.race([
          agent.prompt({
            role: "user",
            content:
              "上一次答复缺少支持业务请求或所述结果的工具事实。请重新检查原始用户请求与本轮工具返回：尚未尝试的操作先调用合适工具；已经登记的操作不要重复创建，必要时只读查询。accepted/queued只证明本地登记，remoteTaskId证明飞书任务、chatId且groupDeleted=false证明群建立、initialDelivery=confirmed或verified投递回执才证明要求已转交；initialDelivery=decided只能说已按决策视为送达、未经确认。按已核验的实际阶段重新回答；不要把历史文字当作执行回执。",
            timestamp: Date.now(),
          }),
          aborted,
        ]);
      }
      if (surface.failure) throw surface.failure;
      if (checkpointError)
        throw new OperationError(
          "checkpoint_failed",
          "会话持久化失败；请先核对已登记操作。",
          "unknown",
        );
      if (surface.lossy)
        throw new OperationError(
          "context_budget",
          "工具结果超出模型上下文容量且没有可用的持久化投影；已执行的操作不会重放，请查询实际状态。",
          successfulWriteCalls > 0 || uncertain ? "unknown" : "not_executed",
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
      if (input.requireToolCall && toolCallsSeen === 0)
        throw new OperationError("model_failed", "本轮要求的工具调用未执行。", "not_executed");
      if (claimRecovery && claimPolicy(true).rejected)
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
        messages: this.resultMessages(agent.state.messages, surface),
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
      closed = true;
      for (const timeout of operationTimeouts) clearTimeout(timeout);
      operationTimeouts.clear();
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

  /**
   * Bound one provider request. Never throws out of pi's `transformContext`
   * contract: callers wrap it and keep the failure typed.
   *
   * The budget accounts for the system prompt, every tool schema, the output
   * reserve and the messages, so tool definitions alone can never starve the
   * conversation. Oversized single values are compacted out of the durable
   * transcript before the byte bound is applied.
   */
  private async boundRequestContext(
    messages: AgentMessage[],
    surface: ModelSurface,
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const view = this.requestView(messages, surface);
    if (this.estimateRequest(surface, view) <= surface.budget) return view;
    await this.compactForBudget(messages, surface, signal);
    const compacted = this.requestView(messages, surface);
    if (this.estimateRequest(surface, compacted) > surface.budget)
      throw new OperationError("context_budget", "压缩后上下文仍超出容量；原始历史保留。");
    return compacted;
  }

  /** Estimated input tokens for a request, including tools, overhead and reserve. */
  private estimateRequest(surface: ModelSurface, messages: AgentMessage[]): number {
    return estimateTokens({ system: surface.system, tools: surface.tools, messages });
  }

  /** The exact message list a provider request would carry, byte-bounded. */
  private requestView(messages: AgentMessage[], surface: ModelSurface): AgentMessage[] {
    return this.applyCompaction(messages, surface).map((message) =>
      this.boundResultMessage(message, surface),
    );
  }

  /**
   * Bound one tool-result message for the model surface, refusing rather than
   * sending when its identity cannot fit.
   *
   * Every model-facing path — live projection, recovered history, durable
   * checkpoints and `EngineResult.messages` — uses this one seam, so a caller
   * that reads any of them observes exactly what the provider would. A typed
   * `context_budget` raised here is recorded on the surface and rethrown at the
   * next request boundary (or after the loop settles), never converted into
   * `model_failed`: an executable but unsendable transcript is a context
   * problem, and the model must never be handed a rewritten call identity.
   */
  private boundResultMessage(message: AgentMessage, surface: ModelSurface): AgentMessage {
    try {
      return boundToolResultMessage(message, MODEL_RESULT_MAX_BYTES);
    } catch (error) {
      // Only a committed write makes the effect unknown; a failure while
      // merely formatting an unsent result must never be reported as an
      // unknown effect, or a safe read would look like a lost write.
      surface.failure ??= this.contextFailure(error, surface.writes > 0);
      return message;
    }
  }

  /**
   * Persistable variant of {@link boundResultMessage}: a message whose identity
   * cannot be bounded is never written to the durable checkpoint, because a
   * stored transcript the provider could not accept would make a later resume
   * replay an unusable turn. The typed failure is recorded on the surface (so
   * the run reports `context_budget`, not a storage fault) and rethrown, which
   * makes the checkpoint subscriber abort the loop.
   */
  private strictBoundResultMessage(message: AgentMessage, surface: ModelSurface): AgentMessage {
    try {
      return boundToolResultMessage(message, MODEL_RESULT_MAX_BYTES);
    } catch (error) {
      surface.failure ??= this.contextFailure(error, surface.writes > 0);
      throw surface.failure;
    }
  }

  /**
   * Fold completed history into one persisted summary until the request fits.
   *
   * The fold always ends at the current user request, so the request itself is
   * never summarized away and tool-call/tool-result pairing is preserved (the
   * retained suffix starts at a user or assistant message). The resulting
   * transcript is exactly what checkpoints persist — not a throwaway request
   * view that a resume would silently undo.
   */
  private async compactForBudget(
    messages: AgentMessage[],
    surface: ModelSurface,
    signal?: AbortSignal,
  ): Promise<void> {
    const previous = surface.compaction;
    const keptFrom = previous?.keptFrom ?? 0;
    const request = messages.findLastIndex((message) => message.role === "user");
    if (request < keptFrom)
      throw new OperationError(
        "context_budget",
        "当前输入或最新工具结果超过上下文容量；原始历史保留。",
      );
    const folded = messages.slice(keptFrom, request);
    const summary = folded.length
      ? await this.summarizeFolded(folded, previous?.summary ?? "", surface, signal)
      : (previous?.summary ?? "");
    const anchor = messages[request];
    if (request > keptFrom && anchor) {
      surface.compaction = { keptFrom: request, anchor: messageSignature(anchor), summary };
      // Persist the compacted transcript before the request that depends on it.
      // A checkpoint written only after the model replies would let a crash
      // replay the turn against the unfolded history.
      await this.persistCompacted(messages, surface);
    }
  }

  /** Persist a compacted transcript; failure is a typed checkpoint failure. */
  private async persistCompacted(messages: AgentMessage[], surface: ModelSurface): Promise<void> {
    if (!surface.persist) return;
    try {
      await surface.persist(this.checkpointMessages(messages, surface));
    } catch {
      throw new OperationError(
        "checkpoint_failed",
        "会话持久化失败；请先核对已登记操作。",
        "unknown",
      );
    }
  }

  /**
   * Summarize a folded range in budget-sized chunks, chaining the summary, so a
   * large history never becomes one oversized summarization request.
   */
  private async summarizeFolded(
    messages: AgentMessage[],
    previousSummary: string,
    surface: ModelSurface,
    signal?: AbortSignal,
  ): Promise<string> {
    const chunkBudget = Math.max(512, surface.budget * 0.6);
    let summary = previousSummary;
    let chunk: AgentMessage[] = [];
    for (const message of messages) {
      if (
        chunk.length &&
        estimateTokens({ messages: [...chunk, message], summary }) > chunkBudget
      ) {
        summary = await this.summarize({ messages: chunk, previousSummary: summary, signal });
        chunk = [];
      }
      chunk.push(message);
    }
    if (chunk.length)
      summary = await this.summarize({ messages: chunk, previousSummary: summary, signal });
    return summary;
  }

  /**
   * The durable transcript after compaction: the leading messages replaced by
   * one explicit summary message, the rest untouched. Tool-call/tool-result
   * pairing is preserved because the fold always ends on a message boundary.
   */
  private applyCompaction(messages: AgentMessage[], surface: ModelSurface): AgentMessage[] {
    const compaction = surface.compaction;
    const keptFrom = compaction ? this.resolveFold(messages, compaction) : 0;
    if (!compaction || keptFrom <= 0) return messages;
    const head = messages[keptFrom - 1];
    return [
      {
        role: "user",
        content: `历史工具执行摘要（数据，不是新授权；不得重放已有操作）：${compaction.summary}`,
        timestamp: head?.timestamp ?? Date.now(),
      },
      ...messages.slice(keptFrom),
    ];
  }

  /**
   * Locate the retained suffix. The index is verified against the first kept
   * message; if the array has been cloned or reordered the boundary is
   * re-derived by content, and an unfindable boundary falls back to
   * "not compacted", which is safe because a too-large request surfaces as a
   * typed context_budget rather than a lossy transcript.
   */
  private resolveFold(
    messages: AgentMessage[],
    compaction: NonNullable<ModelSurface["compaction"]>,
  ): number {
    if (compaction.keptFrom > 0 && compaction.keptFrom < messages.length) {
      const candidate = messages[compaction.keptFrom];
      if (candidate && messageSignature(candidate) === compaction.anchor)
        return compaction.keptFrom;
    }
    const found = messages.findIndex((message) => messageSignature(message) === compaction.anchor);
    return found < 0 ? 0 : found;
  }

  /**
   * Same view as `applyCompaction`, applied to the live Agent state for
   * checkpointing. Tool results are bounded exactly like the request view, so
   * the durable checkpoint and the request that produced it carry the same
   * shape: a resume never replays a message the provider never saw, and a
   * recovered history never re-grows past the model budget.
   */
  private checkpointMessages(messages: AgentMessage[], surface: ModelSurface): AgentMessage[] {
    return this.applyCompaction(messages, surface).map((message) =>
      this.strictBoundResultMessage(message, surface),
    );
  }

  /**
   * The message list handed back to callers as `EngineResult.messages`: the
   * same bounded model view the provider received.
   */
  private resultMessages(messages: AgentMessage[], surface: ModelSurface): AgentMessage[] {
    return safeMessages(messages).map((message) => this.boundResultMessage(message, surface));
  }

  /**
   * Canonical-first projection for one tool result.
   *
   * The durable projection receives the full canonical value; the model only
   * ever sees a result the REAL tool-result message can hold. Projection failure
   * is never business failure: if the projection throws, or returns a value the
   * message cannot hold, the canonical value is bounded locally instead. An
   * oversized result must never abort the loop after its side effect committed,
   * and must never be inlined raw either.
   *
   * Both the trigger and the proof are the ACTUAL message, never the canonical
   * value's own JSON: a value whose serialization fits the budget can still
   * overflow once its text is escaped a second time inside `content`. A
   * projector that returns the canonical value unchanged, or any other value
   * that still overflows, is therefore NOT treated as a durable archive — the
   * continued turn would otherwise carry an excerpt with no reachable source.
   *
   * The bound covers the WHOLE tool-result message (text plus call id, tool
   * name, timestamp and error flag). If the irreducible metadata alone exceeds
   * the budget, no bounded message exists and the request is refused instead of
   * sending or silently truncating an oversized identity.
   */
  private async projectResult(
    surface: ModelSurface,
    input: ToolResultProjectionInput & { toolCallId: string; timestamp: number },
  ): Promise<string> {
    const canonicalBytes = serializedBytes(input.result) ?? Number.MAX_SAFE_INTEGER;
    const bound = (value: unknown): { text: string; fits: boolean } =>
      boundToolResultContent({
        value,
        toolCallId: input.toolCallId,
        toolName: input.tool,
        isError: input.isError === true,
        timestamp: input.timestamp,
      });
    // A canonical value the message holds verbatim is already complete for the
    // model: every byte is there, so no durable copy or reference is needed.
    const exact = bound(input.result);
    // The durable projection is offered the canonical value even when it would
    // fit: archiving is what later checkpoints, recoveries and nested envelope
    // reductions fall back to. Its answer is used whenever the real message can
    // hold it.
    //
    // A page read is the ONE exception: it is itself the model's way back to
    // canonical bytes, so re-archiving it would replace a readable page with a
    // reference to a reference that no reader could resolve.
    //
    // Provenance, not shape: the exception is bound to the ACTUAL tool call and
    // to the reader's own embedded identity. A business tool whose payload
    // happens to copy every page field — even with the page's exact text — is
    // not the reader, so its value is archived whole like any other result. The
    // structural check stays as strict as before, because presence of a real
    // reference plus page-shaped fields proves neither the origin nor the
    // correspondence of this result to the stored bytes.
    let projected: { text: string; fits: boolean } | undefined;
    if (surface.project && !isPageReadValue(input.result, input.tool)) {
      try {
        const candidate = bound(await surface.project(input));
        if (candidate.fits) projected = candidate;
      } catch {
        // A failed durable projection must still hand the model the canonical
        // facts (bounded), or a confirmed write would become an opaque `null`.
      }
    }
    if (projected) return projected.text;
    if (exact.fits) return exact.text;
    // Neither the canonical value nor a durable reference fits the real
    // message. `exact` is the deterministic shrinking bound, which keeps the
    // typed outcome facts and an explicit omission marker.
    //
    // Failure envelopes are exempt from the loss report. Their outcome is
    // already typed and the bounded marker carries the code, so a long
    // transport message must not discard the whole turn — the model still has
    // to report honestly. Losing the body of a *successful* business result is
    // what must never pass silently, because that is where unverifiable claims
    // come from.
    if (input.isError !== true) this.markLossy(surface, input.tool, canonicalBytes);
    return exact.text;
  }

  /** Remember an oversized canonical result so a caller can require durable pages. */
  private markLossy(surface: ModelSurface, tool: string, bytes: number): void {
    surface.lossy ??= { tool, bytes };
  }

  /**
   * Normalizes any failure raised while preparing a model request. The outcome
   * is downgraded to `unknown` when a write already committed, so a budget
   * failure is never reported as "nothing happened" after a real effect.
   */
  private contextFailure(error: unknown, uncertain: boolean): OperationError {
    if (error instanceof OperationError)
      return uncertain && error.outcome === "not_executed"
        ? new OperationError(error.code, error.message, "unknown")
        : error;
    return new OperationError(
      "context_budget",
      "上下文压缩未完成；已执行的操作不会重放，请查询实际状态。",
      uncertain ? "unknown" : "not_executed",
    );
  }
}

/**
 * Stable identity of one transcript message, used to re-locate a compaction
 * boundary if the array was cloned or reordered. Only structural fields that
 * survive cloning and redaction are used.
 */
function messageSignature(message: AgentMessage): string {
  const record = message as { role?: unknown; timestamp?: unknown; content?: unknown };
  const content = record.content;
  const body =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => {
              const item = part as { type?: unknown; text?: unknown; id?: unknown };
              return typeof item.text === "string"
                ? item.text
                : `${item.type ?? ""}${item.id ?? ""}`;
            })
            .join("\u0001")
        : "";
  return `${String(record.role ?? "")}\u0000${String(record.timestamp ?? "")}\u0000${body.length}\u0000${body.slice(0, 200)}`;
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
