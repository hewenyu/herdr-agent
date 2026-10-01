import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError, safeError } from "../core/errors.js";
import { now } from "../core/ids.js";
import type { ActorContext } from "../core/types.js";
import {
  MODEL_OUTPUT_RESERVE_TOKENS,
  serialize as serializeModelValue,
} from "../runtime/model-context.js";
import type { EngineInput, EngineResult, RuntimeTool } from "../runtime/types.js";
import type { Store } from "../storage/store.js";
import {
  appendLeaderMessage,
  buildLeaderPrompt,
  LEADER_SYSTEM_PROMPT,
  leaderHistory,
} from "./leader-session-context.js";
import {
  appendLeaderJournal,
  assertLeaderResumable,
  boundCheckpointMessages,
  checkpointRequestRows,
  clearLeaderCheckpoints,
  operationIdForCall,
  readLeaderCheckpoint,
  recoverLeaderMessages,
  saveLeaderCheckpoint,
} from "./leader-session-journal.js";
import {
  assertLeaderRecordVersion,
  boundLeaderText,
  LEADER_ACTIVATIONS,
  LEADER_CHECKPOINT_MAX_BYTES,
  LEADER_CHECKPOINT_MAX_MESSAGES,
  LEADER_CHECKPOINTS,
  LEADER_EVENTS,
  LEADER_HISTORY_MAX_BYTES,
  LEADER_INBOX,
  LEADER_MAX_ATTEMPTS,
  LEADER_MESSAGE_MAX_BYTES,
  LEADER_OPERATIONS,
  LEADER_RUNTIME_VERSION,
  LEADER_SESSIONS,
  type LeaderActivationRecord,
  type LeaderCheckpointRecord,
  type LeaderInboxRecord,
  type LeaderOperationRecord,
  type LeaderProjection,
  type LeaderProjectionInput,
  type LeaderSessionRecord,
  leaderActivationId,
  leaderBytes,
  leaderCheckpointId,
  leaderEventKey,
  leaderTaskMessagesSafe,
  projectionToolCandidate,
  readLeaderRecord,
} from "./leader-session-types.js";
import {
  classifyResult,
  projectForSurface,
  projectValue,
  repairOversizedToolResult,
  sessionActor,
} from "./leader-session-writes.js";

export type ProjectedEngineInput = EngineInput & {
  projectToolResult?: (input: LeaderProjectionInput) => unknown | Promise<unknown>;
};

/** Combine the caller signal with an abort caused by a failed checkpoint. */
function combinedSignal(context: ActivationContext, controller: AbortController): AbortSignal {
  return context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
}

export interface ActivationContext {
  store: Store;
  taskId: string;
  ownerId: string;
  session: LeaderSessionRecord;
  projection: LeaderProjection;
  eventId: string;
  revision: string;
  prompt: string;
  systemPrompt: string;
  tools: RuntimeTool[];
  signal?: AbortSignal;
  assertCurrent?: () => void;
  engine: (input: EngineInput) => Promise<EngineResult>;
  /** Configured model context, used to refuse an irreducible request early. */
  engineTokens?: number;
  inbox: LeaderInboxRecord;
  attempt: number;
}

export interface ActivationOutcome {
  text: string;
  messages: AgentMessage[];
  result: EngineResult;
}

/** Conservative token estimate mirroring the engine's own accounting. */
function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(serializeModelValue(value) ?? "null", "utf8") / 3) + 16;
}

/**
 * Optional history is trimmed to fit; the mandatory request never is. When the
 * complete mandatory input cannot fit the configured context the activation is
 * refused with a typed budget error BEFORE inference, so a trailing hard
 * constraint is never silently severed.
 */
function requestContext(input: {
  systemPrompt: string;
  tools: RuntimeTool[];
  prompt: string;
  history: AgentMessage[];
  engineTokens?: number;
  requiredMessages?: AgentMessage[];
}): AgentMessage[] {
  const toolSchema = input.tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const required = input.requiredMessages;
  if (required) {
    // A recovered transcript is the durable truth of an interrupted turn: it is
    // already bounded and projected, and silently trimming it would drop tool
    // receipts. What genuinely cannot fit is refused typed, never truncated.
    if (!input.engineTokens || input.engineTokens <= 0) return required;
    const size =
      estimateTokens({
        system: input.systemPrompt,
        tools: toolSchema,
        prompt: input.prompt,
        messages: required,
      }) + MODEL_OUTPUT_RESERVE_TOKENS;
    if (size >= input.engineTokens)
      throw new OperationError(
        "orchestration_context_budget",
        `恢复所需的完整强制输入约需 ${size} token，已达到或超过当前模型容量 ${input.engineTokens}；本轮未调用模型，原始记录保留。请提高模型上下文容量或改用可投影的只读数据。`,
        "not_executed",
      );
    return required;
  }
  if (!input.engineTokens || input.engineTokens <= 0) return input.history;
  const fixed =
    estimateTokens({ system: input.systemPrompt, tools: toolSchema, prompt: input.prompt }) +
    MODEL_OUTPUT_RESERVE_TOKENS;
  if (fixed >= input.engineTokens)
    throw new OperationError(
      "orchestration_context_budget",
      `本轮完整强制输入约需 ${fixed} token，已达到或超过当前模型容量 ${input.engineTokens}；为避免丢失末尾硬性约束，本轮未调用模型。请通过有界只读工具按页读取大对象，或提高模型上下文容量。`,
      "not_executed",
    );
  const budget = input.engineTokens - fixed;
  const kept: AgentMessage[] = [];
  let used = 0;
  for (let index = input.history.length - 1; index >= 0; index--) {
    const message = input.history[index];
    if (!message) continue;
    const size = estimateTokens(message);
    // History is optional data: the oldest rows are dropped to fit, and the
    // aggregate budget is never exceeded by a single giant row.
    if (kept.length && used + size > budget) break;
    if (!kept.length && size > budget) break;
    used += size;
    kept.unshift(message);
  }
  return kept;
}

/**
 * Execute exactly one durable activation. The engine is called at most once,
 * every checkpoint is the real compacted transcript, and the inbox/activation
 * receipt is only marked recorded after the result is persisted.
 */
export async function executeActivation(context: ActivationContext): Promise<ActivationOutcome> {
  const { store, taskId, ownerId, session, projection, eventId, revision, attempt } = context;
  const inboxId = context.inbox.id;
  const checkpoint = readLeaderCheckpoint(store, taskId, eventId, revision);
  const interrupted = context.inbox.state === "active" || context.inbox.state === "failed";
  const resuming = !!checkpoint && (interrupted || attempt > 1);
  // A pending, unknown or abandoned write blocks continuation across restarts,
  // changed arguments and new events alike. This runs BEFORE any inference, so
  // an unresolved effect can never be routed around.
  assertLeaderResumable(store, taskId);
  const activationId = leaderActivationId(taskId, eventId, revision, attempt);
  const prompt = buildLeaderPrompt({
    taskId,
    ownerId,
    eventId,
    revision,
    activationId,
    eventPrompt: context.prompt,
    priorState: sessionNote(store, taskId),
    attempts: attempt,
    maxAttempts: LEADER_MAX_ATTEMPTS,
  });
  const systemPrompt = context.systemPrompt.trim()
    ? `${context.systemPrompt.trim()}\n\n${LEADER_SYSTEM_PROMPT}`
    : LEADER_SYSTEM_PROMPT;
  const actor = sessionActor(session, eventId);
  const toolContext: ToolContext = {
    store,
    taskId,
    session,
    activationId,
    eventId,
    revision,
    // The complete canonical request of THIS event/revision. It is the row a
    // resumed PiEngine run must still see, because `resume: true` ignores
    // `input.prompt` and asks only for a generic continuation. It is derived
    // from the current activation only, never from stale historical input, and
    // it is pinned for every activation: the count cap must never push the
    // mandatory request out of the transcript it will be resumed from.
    request: prompt.payload,
    projection,
  };
  const tools = wrapTools(toolContext, context.tools, context.assertCurrent);
  const recovered = resuming
    ? repairedCheckpointMessages(store, {
        taskId,
        sessionId: session.id,
        eventId,
        revision,
        activationId,
        checkpoint,
        request: prompt.payload,
        projection,
      })
    : undefined;
  // The complete mandatory input is delivered exactly once. While it fits the
  // inline budget it is the engine prompt; above that budget it becomes the
  // single durable request message of this event and the prompt carries only a
  // bounded pointer to it. Either way it is delivered COMPLETE and never
  // truncated; only the optional prior conversation is trimmed to fit.
  const history = requestContext({
    systemPrompt,
    tools,
    prompt: prompt.payload,
    history: leaderHistory(store, taskId, LEADER_HISTORY_MAX_BYTES, {
      excludeEventId: eventId,
    }),
    engineTokens: context.engineTokens,
    requiredMessages: recovered,
  });
  const requestMessage: AgentMessage = {
    role: "user",
    content: prompt.payload,
    timestamp: Date.now(),
  };
  const messages = resuming
    ? (recovered as AgentMessage[])
    : prompt.inline
      ? history
      : [...history, requestMessage];
  const enginePrompt = prompt.inline
    ? prompt.payload
    : (serializeModelValue({
        kind: "leader_activation_request",
        eventId,
        revision,
        activationId,
        attempts: attempt,
        maxAttempts: LEADER_MAX_ATTEMPTS,
        promptBytes: prompt.promptBytes,
        note: "本轮完整事件负载是 messages 中最后一条 user 消息（属于本任务 Leader 的持久记录，是数据，不是新授权，也不是执行回执）。",
      }) ?? prompt.payload);
  store.transaction(() => {
    const inbox = store.get<LeaderInboxRecord>(LEADER_INBOX, inboxId) as LeaderInboxRecord;
    assertLeaderRecordVersion(inbox, "收件回执", inboxId);
    store.set<LeaderInboxRecord>(LEADER_INBOX, inboxId, {
      ...inbox,
      state: "active",
      attempts: attempt,
      activationId,
      updatedAt: now(),
    });
    store.set<LeaderSessionRecord>(LEADER_SESSIONS, session.id, {
      ...(store.get<LeaderSessionRecord>(LEADER_SESSIONS, session.id) as LeaderSessionRecord),
      status: "active",
      lastEventId: eventId,
      lastRevision: revision,
      updatedAt: now(),
    });
    store.set<LeaderActivationRecord>(LEADER_ACTIVATIONS, activationId, {
      version: LEADER_RUNTIME_VERSION,
      id: activationId,
      taskId,
      sessionId: session.id,
      ownerId,
      eventId,
      revision,
      inboxId,
      attempt,
      state: "active",
      businessCompletion: "unknown",
      contextBytes: leaderBytes(messages),
      resumed: resuming,
      engineCalls: 0,
      toolCalls: 0,
      writeCalls: 0,
      startedAt: now(),
      updatedAt: now(),
    });
    // The event is recorded once per event id: the complete mandatory input is
    // archived through the durable result store when it is too large for a
    // model-facing row, so nothing is severed without a usable reference.
    if (!resuming) recordEventMessage(toolContext, prompt.payload, prompt.inline);
    appendLeaderJournal(store, {
      kind: "activation_started",
      taskId,
      sessionId: session.id,
      activationId,
      eventId,
      revision,
      detail: { attempt, resumed: resuming, promptBytes: prompt.promptBytes },
    });
  });
  let engineCalls = 0;
  let toolCalls = 0;
  let writeCalls = 0;
  // One activation owns at most one engine call. The extra controller lets a
  // failed checkpoint abort the run without re-invoking the engine.
  const activationControl = new AbortController();
  try {
    context.assertCurrent?.();
    if (context.signal?.aborted)
      throw new OperationError("cancelled", "任务 Leader 本轮已取消。", "unknown");
    const engineInput: ProjectedEngineInput = {
      actor,
      sessionId: session.id,
      systemPrompt,
      messages,
      prompt: enginePrompt,
      tools,
      signal: combinedSignal(context, activationControl),
      resume: resuming,
      enforceClaims: false,
      onCheckpoint: (checkpointMessages: AgentMessage[]) => {
        persistCheckpoint(toolContext, checkpointMessages, activationControl);
      },
    };
    // The engine projection seam receives the CANONICAL value before any
    // model-facing bound, so an oversized result is archived once and referenced.
    engineInput.projectToolResult = (value) => projection.projectToolResult(value);
    const result = await context.engine(engineInput);
    engineCalls += 1;
    toolCalls += result.toolCalls ?? 0;
    writeCalls += result.writeCalls ?? result.toolEvidence?.successfulWrites ?? 0;
    // The engine returned normally, but the revision may have changed during
    // inference. Refusing here is a typed non-execution of the ACTIVATION; it
    // never rewrites an already completed canonical write receipt.
    context.assertCurrent?.();
    const text = recordResult({
      store,
      taskId,
      ownerId,
      session,
      eventId,
      revision,
      inboxId,
      activationId,
      attempt,
      text: result.text ?? "",
      engineCalls,
      toolCalls,
      writeCalls,
    });
    return { text, messages, result };
  } catch (error) {
    const failure = safeError(error);
    store.transaction(() => {
      const current = store.get<LeaderInboxRecord>(LEADER_INBOX, inboxId);
      if (current && current.state !== "recorded" && current.state !== "superseded")
        store.set<LeaderInboxRecord>(LEADER_INBOX, inboxId, {
          ...current,
          state: "failed",
          attempts: attempt,
          activationId,
          errorCode: failure.code,
          errorOutcome: failure.outcome,
          updatedAt: now(),
        });
      const activation = store.get<LeaderActivationRecord>(LEADER_ACTIVATIONS, activationId);
      if (activation)
        store.set<LeaderActivationRecord>(LEADER_ACTIVATIONS, activationId, {
          ...activation,
          state: "failed",
          engineCalls,
          toolCalls,
          writeCalls,
          errorCode: failure.code,
          errorOutcome: failure.outcome,
          updatedAt: now(),
          endedAt: now(),
        });
      appendLeaderJournal(store, {
        kind: "activation_failed",
        taskId,
        sessionId: session.id,
        activationId,
        eventId,
        revision,
        detail: { code: failure.code, outcome: failure.outcome },
      });
      const latest = store.get<LeaderSessionRecord>(LEADER_SESSIONS, session.id);
      if (latest)
        store.set<LeaderSessionRecord>(LEADER_SESSIONS, session.id, {
          ...latest,
          status: "idle",
          updatedAt: now(),
        });
    });
    throw error;
  }
}

/**
 * Persist the exact reduced checkpoint before the next provider request. The
 * stored transcript may never exceed the checkpoint byte budget: the complete
 * mandatory request of this event is pinned, oversized tool results are
 * projected with a usable durable reference first, then whole closed batches
 * are dropped into an explicit bounded summary. A request that cannot fit is a
 * typed refusal BEFORE inference, never a silently shortened activation.
 */
function persistCheckpoint(
  context: ToolContext,
  checkpointMessages: AgentMessage[],
  control: AbortController,
): void {
  const { store, taskId, session, activationId, eventId, revision } = context;
  try {
    const repaired = checkpointMessages.map((message) =>
      message.role === "toolResult"
        ? repairOversizedToolResult(message, context.projection)
        : message,
    );
    store.transaction(() => {
      const record = saveLeaderCheckpoint(store, {
        taskId,
        sessionId: session.id,
        activationId,
        eventId,
        revision,
        generation: session.generation,
        id: leaderCheckpointId(taskId, eventId, revision),
        messages: repaired,
        request: context.request,
        maxBytes: LEADER_CHECKPOINT_MAX_BYTES,
        maxMessages: LEADER_CHECKPOINT_MAX_MESSAGES,
      });
      appendLeaderJournal(store, {
        kind: "checkpoint",
        taskId,
        sessionId: session.id,
        activationId,
        eventId,
        revision,
        detail: {
          bytes: record.bytes,
          messages: record.messages.length,
          summary: false,
          requestBytes: context.request ? leaderBytes(context.request) : 0,
        },
      });
    });
  } catch (error) {
    // A checkpoint write failure is a typed, retryable budget failure; it never
    // silently continues on an unbounded context and never replays a write.
    // The original typed budget refusal is preserved so a caller can reduce
    // context or raise the ceiling instead of retrying an unchanged request.
    control.abort();
    if (error instanceof OperationError && error.code === "orchestration_context_budget")
      throw error;
    throw new OperationError(
      "checkpoint_failed",
      "任务 Leader 检查点未能持久化；已登记操作保留，请先核对实际状态。",
      "unknown",
      { cause: error },
    );
  }
}

/** Record the durable event row once per event id. */
function recordEventMessage(context: ToolContext, prompt: string, inline: boolean): void {
  const { store, taskId, session, activationId, eventId, revision, projection } = context;
  const existing = leaderTaskMessagesSafe(store, taskId).some(
    (message) => message.role === "event" && message.eventId === eventId,
  );
  if (existing) return;
  const row =
    inline && Buffer.byteLength(prompt, "utf8") <= LEADER_MESSAGE_MAX_BYTES
      ? prompt
      : // An oversized mandatory input is archived through the durable result
        // store, so the stored row keeps a usable paged reference instead of a
        // silently severed prefix.
        (serializeModelValue(
          projectForSurface(projection, {
            tool: "leader_activation_input",
            args: { eventId, revision },
            toolCallId: activationId,
            result: prompt,
            isError: false,
          }),
        ) ?? "null");
  appendLeaderMessage(store, {
    sessionId: session.id,
    taskId,
    ownerId: session.ownerId,
    role: "event",
    source: "event",
    text: row,
    eventId,
    revision,
    activationId,
    maxBytes: LEADER_MESSAGE_MAX_BYTES,
    sequence: leaderTaskMessagesSafe(store, taskId).length + 1,
  });
}

/**
 * Recover an interrupted activation. A checkpoint written before projection
 * existed may still contain a raw oversized tool result: the canonical body is
 * archived with the durable store, the stored checkpoint is replaced by its
 * bounded form BEFORE inference, and recovery then runs on the repaired set, so
 * no write is ever replayed to make the context fit.
 */
function repairedCheckpointMessages(
  store: Store,
  input: {
    taskId: string;
    sessionId: string;
    eventId: string;
    revision: string;
    activationId: string;
    checkpoint: LeaderCheckpointRecord;
    /** Complete canonical request of the resuming event/revision. */
    request: string;
    projection: LeaderProjection;
  },
): AgentMessage[] {
  const repaired = input.checkpoint.messages.map((message) =>
    message.role === "toolResult" ? repairOversizedToolResult(message, input.projection) : message,
  );
  // The canonical current request is re-established from THIS activation, not
  // trusted from an optional historical row: PiEngine's `resume: true` ignores
  // `input.prompt`, so the complete mandatory payload must be inside the
  // recovered messages or the model genuinely never sees it.
  const split = checkpointRequestRows(repaired, input.request, {
    taskId: input.taskId,
    eventId: input.eventId,
    revision: input.revision,
  });
  const bounded = boundCheckpointMessages(
    split.rest,
    LEADER_CHECKPOINT_MAX_BYTES,
    LEADER_CHECKPOINT_MAX_MESSAGES,
    split.pinned,
  );
  const changed =
    bounded.bytes !== input.checkpoint.bytes ||
    bounded.messages.length !== input.checkpoint.messages.length;
  if (changed)
    store.transaction(() => {
      store.set(LEADER_CHECKPOINTS, input.checkpoint.id, {
        ...input.checkpoint,
        messages: bounded.messages,
        bytes: bounded.bytes,
        updatedAt: now(),
      });
      appendLeaderJournal(store, {
        kind: "checkpoint",
        taskId: input.taskId,
        sessionId: input.sessionId,
        activationId: input.activationId,
        eventId: input.eventId,
        revision: input.revision,
        detail: { bytes: bounded.bytes, repaired: true, summary: !!bounded.summary },
      });
    });
  return recoverLeaderMessages(
    store,
    input.taskId,
    input.sessionId,
    bounded.messages,
    input.eventId,
    input.revision,
    (operation) => projectValue(input.projection, operation),
  );
}

function wrapTools(
  context: ToolContext,
  tools: RuntimeTool[],
  assertCurrent?: () => void,
): RuntimeTool[] {
  const wrapped = tools.map((tool) => wrapTool(context, tool, assertCurrent));
  const supplied = projectionToolCandidate(context.projection.tool);
  if (supplied && !wrapped.some((tool) => tool.name === supplied.name))
    wrapped.push(wrapTool(context, supplied, assertCurrent));
  return wrapped;
}

interface ToolContext {
  store: Store;
  taskId: string;
  session: LeaderSessionRecord;
  activationId: string;
  eventId: string;
  revision: string;
  /**
   * Complete canonical request payload of the current event/revision. It is
   * pinned into every checkpoint so a resume (which ignores `input.prompt`)
   * still carries the mandatory constraints.
   */
  request: string;
  projection: LeaderProjection;
}

function wrapTool(
  context: ToolContext,
  tool: RuntimeTool,
  assertCurrent?: () => void,
): RuntimeTool {
  const { store, taskId, session, activationId, eventId, revision, projection } = context;
  const name = tool.name;
  const readOnly = tool.readOnly === true;
  const scoped: RuntimeTool = { ...tool, readOnly };
  return {
    ...scoped,
    execute: async (args, _actor, signal) => {
      const clean = { ...(args ?? {}) };
      delete clean.request_id;
      // Full invocation identity: task + session + event + revision + tool +
      // args. A duplicate delivery of one event deduplicates; a separately
      // authorized new event executes its own operation.
      const id = operationIdForCall(taskId, session.id, eventId, revision, name, clean);
      if (!readOnly) {
        // The replay-authorization boundary: a durable record this runtime
        // cannot interpret must never be read as a confirmed receipt (which
        // would skip work) nor as pending (which would misreport the effect).
        const previous = readLeaderRecord<LeaderOperationRecord>(
          store,
          LEADER_OPERATIONS,
          id,
          "写操作",
        );
        if (previous?.resolution?.choice === "abandon")
          // The user abandoned this exact operation: it may never be retried,
          // and its identity can never be re-created as a fresh pending row.
          // A genuinely new event has a different identity and is unaffected.
          throw new OperationError(
            "operation_abandoned",
            "该写操作已被废弃，不得重试；请登记新的证据或由用户重新授权。",
            "not_executed",
          );
        if (previous?.state === "unknown" || previous?.state === "pending")
          throw new OperationError(
            "operation_unconfirmed",
            "该写操作已尝试但未确认，不能重发；请查询实际状态。",
            "unknown",
          );
        if (previous?.state === "complete")
          // Identical confirmed writes are never replayed. The engine receives
          // the CANONICAL recorded result so business evidence is evaluated on
          // the real receipt, never on a projection of it; the engine's own
          // post-canonical projection hook bounds it before the request.
          return previous.result ?? previous.invocationResult;
        // A revision change between inference and this call fences the write
        // before it reaches the outside world.
        assertCurrent?.();
        store.transaction(() => {
          const at = now();
          store.set<LeaderOperationRecord>(LEADER_OPERATIONS, id, {
            version: LEADER_RUNTIME_VERSION,
            id,
            taskId,
            sessionId: session.id,
            ownerId: session.ownerId,
            tool: name,
            readOnly,
            args: JSON.stringify(clean),
            argsCanonical: canonicalArgs(clean),
            eventId,
            revision,
            activationId,
            state: "pending",
            createdAt: at,
            updatedAt: at,
          });
          appendLeaderJournal(store, {
            kind: "operation_pending",
            taskId,
            sessionId: session.id,
            activationId,
            eventId,
            revision,
            detail: { id, tool: name },
          });
        });
      }
      let result: unknown;
      try {
        result = await scoped.execute(clean, sessionActor(session, eventId), signal, id);
      } catch (error) {
        // A business failure is recorded from the canonical error value. No
        // effect committed, so the completed-effect rules do not apply.
        if (!readOnly) recordBusinessFailure(context, id, name, error);
        throw error;
      }
      if (readOnly) {
        // Read-only receipts are re-executable; the durable surface keeps their
        // bounded projection and an oversized body stays paged behind it.
        const projected = projectForSurface(projection, {
          tool: name,
          args: clean,
          toolCallId: id,
          result,
          isError: false,
        });
        storeSurfaceReceipt(context, { callId: id, name, value: projected, isError: false }, true);
        // The CANONICAL value is returned to the engine, which applies the
        // post-evidence projection at the request boundary, so evidence and
        // provisioning facts are never evaluated on a pre-projected reference.
        return result;
      }
      // The effect committed. The CANONICAL outcome is persisted BEFORE any
      // post-effect validation, projection, journal formatting or history
      // storage: a later failure must never turn a completed effect into a
      // not-executed receipt or enable a replay.
      const state = classifyResult(result);
      persistCanonicalReceipt(context, id, name, result, state);
      // The post-effect revision fence may now refuse the rest of the
      // activation. That refusal is about the ACTIVATION, never about the
      // effect that already committed and was recorded above.
      assertCurrent?.();
      const projected = projectForSurface(projection, {
        tool: name,
        args: clean,
        toolCallId: id,
        result,
        isError: state !== "complete",
      });
      storeSurfaceReceipt(context, { callId: id, name, value: projected, isError: false }, false);
      // Canonical, exactly as above: the engine bounds what the model sees, and
      // the durable paged reference for an oversized body is derived there.
      return result;
    },
  };
}

/**
 * What the engine receives from a Leader tool. A value that fits one model
 * message is returned CANONICALLY, so tool evidence and provisioning facts are
 * evaluated on the real receipt. An oversized value is replaced by its durable
 * paged projection; the full value stays in the canonical journal or the
 * durable result store and is reachable through the scoped read tool.
 */
function recordBusinessFailure(
  context: ToolContext,
  id: string,
  name: string,
  error: unknown,
): void {
  const failure = safeError(error);
  context.store.transaction(() => {
    const previous = context.store.get<LeaderOperationRecord>(LEADER_OPERATIONS, id);
    context.store.set<LeaderOperationRecord>(LEADER_OPERATIONS, id, {
      ...(previous as LeaderOperationRecord),
      state: failure.outcome === "not_executed" ? "not_executed" : "unknown",
      error: failure,
      updatedAt: now(),
    });
    appendLeaderJournal(context.store, {
      kind: failure.outcome === "not_executed" ? "operation_not_executed" : "operation_unknown",
      taskId: context.taskId,
      sessionId: context.session.id,
      activationId: context.activationId,
      eventId: context.eventId,
      revision: context.revision,
      detail: { id, tool: name, code: failure.code },
    });
    recordToolMessage(context, { callId: id, name, value: failure, isError: true });
  });
}

/** Persist the canonical outcome of a completed effect before anything else. */
function persistCanonicalReceipt(
  context: ToolContext,
  id: string,
  name: string,
  result: unknown,
  state: LeaderOperationRecord["state"],
): void {
  context.store.transaction(() => {
    const previous = context.store.get<LeaderOperationRecord>(LEADER_OPERATIONS, id);
    context.store.set<LeaderOperationRecord>(LEADER_OPERATIONS, id, {
      ...(previous as LeaderOperationRecord),
      state,
      result,
      invocationResult: result,
      resultBytes: leaderBytes(result),
      updatedAt: now(),
    });
    appendLeaderJournal(context.store, {
      kind:
        state === "complete"
          ? "operation_complete"
          : state === "unknown"
            ? "operation_unknown"
            : "operation_not_executed",
      taskId: context.taskId,
      sessionId: context.session.id,
      activationId: context.activationId,
      eventId: context.eventId,
      revision: context.revision,
      detail: { id, tool: name, resultBytes: leaderBytes(result) },
    });
  });
}

/**
 * Store one model-facing receipt on the bounded durable surface. This is a
 * surface concern only: a projection or history-storage failure never changes a
 * canonical receipt and never enables a replay. Read-only receipts are
 * re-executable, so their surface failure is never reported as a business one.
 */
function storeSurfaceReceipt(
  context: ToolContext,
  value: { callId: string; name: string; value: unknown; isError: boolean },
  readOnly: boolean,
): void {
  try {
    context.store.transaction(() => {
      recordToolMessage(context, value);
    });
  } catch (error) {
    if (readOnly) return;
    throw new OperationError(
      "context_persist_failed",
      "写操作已确认完成，但其模型可见回执未能持久化；不得重发该操作，请先查询实际状态。",
      "unknown",
      { cause: error },
    );
  }
}

function recordToolMessage(
  context: ToolContext,
  value: { callId: string; name: string; value: unknown; isError: boolean },
): void {
  // Only the bounded projection of a receipt enters the durable model surface;
  // the canonical value stays in the operation journal.
  const text = boundedReceiptText(value);
  appendLeaderMessage(context.store, {
    sessionId: context.session.id,
    taskId: context.taskId,
    ownerId: context.session.ownerId,
    role: "tool",
    source: value.isError ? "tool_error" : "tool_result",
    text,
    eventId: context.eventId,
    revision: context.revision,
    activationId: context.activationId,
    callId: value.callId,
    maxBytes: LEADER_MESSAGE_MAX_BYTES,
    sequence: leaderTaskMessagesSafe(context.store, context.taskId).length + 1,
  });
}

/**
 * Bound the WHOLE serialized receipt envelope (tool name, error flag, value,
 * JSON escaping) so a per-message model budget is never exceeded by metadata
 * added after the value itself was bounded.
 */
function boundedReceiptText(value: {
  callId: string;
  name: string;
  value: unknown;
  isError: boolean;
}): string {
  const envelope = { tool: value.name, isError: value.isError, value: value.value };
  const serialized = serializeModelValue(envelope) ?? "null";
  if (Buffer.byteLength(serialized, "utf8") <= LEADER_MESSAGE_MAX_BYTES) return serialized;
  return (
    serializeModelValue({
      tool: value.name,
      isError: value.isError,
      omitted: "该回执的模型可见部分超出单条消息上限；完整结果保留在持久记录中。",
      text: boundLeaderText(serialized, LEADER_MESSAGE_MAX_BYTES - 256).text,
    }) ?? "null"
  );
}

function recordResult(input: {
  store: Store;
  taskId: string;
  ownerId: string;
  session: LeaderSessionRecord;
  eventId: string;
  revision: string;
  inboxId: string;
  activationId: string;
  attempt: number;
  text: string;
  engineCalls: number;
  toolCalls: number;
  writeCalls: number;
}): string {
  const { store } = input;
  return store.transaction(() => {
    // The stored answer is bounded with an explicit marker; the value returned
    // to the caller is the same stored text, so a replayed receipt is identical.
    const text = boundLeaderText(input.text ?? "", LEADER_MESSAGE_MAX_BYTES).text;
    const at = now();
    const inbox = store.get<LeaderInboxRecord>(LEADER_INBOX, input.inboxId) as LeaderInboxRecord;
    store.set<LeaderInboxRecord>(LEADER_INBOX, input.inboxId, {
      ...inbox,
      state: "recorded",
      attempts: input.attempt,
      activationId: input.activationId,
      resultText: text,
      errorCode: undefined,
      errorOutcome: undefined,
      updatedAt: at,
    });
    const key = leaderEventKey(input.taskId, input.eventId);
    const event = store.get<{ state: string; updatedAt: string }>(LEADER_EVENTS, key);
    if (event) store.set(LEADER_EVENTS, key, { ...event, state: "recorded", updatedAt: at });
    appendLeaderMessage(store, {
      sessionId: input.session.id,
      taskId: input.taskId,
      ownerId: input.ownerId,
      role: "assistant",
      source: "leader",
      text,
      eventId: input.eventId,
      revision: input.revision,
      activationId: input.activationId,
      maxBytes: LEADER_MESSAGE_MAX_BYTES,
      sequence: leaderTaskMessagesSafe(store, input.taskId).length + 1,
    });
    const activation = store.get<LeaderActivationRecord>(LEADER_ACTIVATIONS, input.activationId);
    if (activation)
      store.set<LeaderActivationRecord>(LEADER_ACTIVATIONS, input.activationId, {
        ...activation,
        state: "recorded",
        engineCalls: input.engineCalls,
        toolCalls: input.toolCalls,
        writeCalls: input.writeCalls,
        updatedAt: at,
        endedAt: at,
      });
    const session = store.get<LeaderSessionRecord>(LEADER_SESSIONS, input.session.id);
    if (session)
      store.set<LeaderSessionRecord>(LEADER_SESSIONS, input.session.id, {
        ...session,
        status: "idle",
        lastEventId: input.eventId,
        lastRevision: input.revision,
        updatedAt: at,
      });
    appendLeaderJournal(store, {
      kind: "activation_recorded",
      taskId: input.taskId,
      sessionId: input.session.id,
      activationId: input.activationId,
      eventId: input.eventId,
      revision: input.revision,
      // A returned activation is never business completion.
      detail: { businessCompletion: "unknown", toolCalls: input.toolCalls },
    });
    clearLeaderCheckpoints(store, input.taskId);
    return text;
  });
}

function sessionNote(store: Store, taskId: string): string | undefined {
  const last = leaderTaskMessagesSafe(store, taskId).at(-1);
  if (!last) return undefined;
  return JSON.stringify({
    role: last.role,
    sequence: last.sequence,
    text: last.text.slice(0, 512),
  });
}

/** Canonical JSON used for write identity; mirrors core canonical ordering. */
function canonicalArgs(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

export type { ActorContext };
