import { OperationError } from "../core/errors.js";
import { now } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { ActorContext } from "../core/types.js";
import { createResultProjection } from "../runtime/tool-results.js";
import type { ConversationEngine, EngineResult, RuntimeTool } from "../runtime/types.js";
import type { Store } from "../storage/store.js";
import { leaderHistory, leaderTaskMessages } from "./leader-session-context.js";
import { executeActivation } from "./leader-session-engine.js";
import { appendLeaderJournal, leaderJournal, leaderOperations } from "./leader-session-journal.js";
import {
  LEADER_ACTIVATIONS,
  LEADER_CHECKPOINTS,
  LEADER_EVENTS,
  LEADER_INBOX,
  LEADER_MAX_ATTEMPTS,
  LEADER_OPERATIONS,
  LEADER_RUNTIME_VERSION,
  LEADER_SESSIONS,
  type LeaderActivationRecord,
  type LeaderEventRecord,
  type LeaderInboxRecord,
  type LeaderMessageRecord,
  type LeaderOperationRecord,
  type LeaderProjection,
  type LeaderProjectionInput,
  type LeaderSessionRecord,
  type LeaderSessionSummary,
  leaderEventKey,
  leaderInboxId,
  leaderScope,
  leaderSessionId,
  readLeaderRecord,
} from "./leader-session-types.js";
import { sessionActor } from "./leader-session-writes.js";

/**
 * Frozen D interface. `actor` MUST carry `taskId` and `ownerId`; the runtime
 * derives its own isolated `task-leader:<taskId>` session internally and never
 * reads or writes the outer management session or its transcript.
 */
export interface TaskLeaderInput {
  store: Store;
  engine: LeaderEngine;
  actor: ActorContext;
  eventId: string;
  revision: string;
  systemPrompt: string;
  prompt: string;
  tools: RuntimeTool[];
  signal?: AbortSignal;
  assertCurrent?: () => void;
  /**
   * Optional additive override. When omitted — which is what every production
   * caller does — the runtime wires its own durable, task-scoped projection
   * (durable oversized-result store plus the read-only paging tool) from the
   * trusted derived Leader identity. Tests may still inject their own.
   */
  projection?: LeaderProjection;
}

/**
 * The engine contract is `ConversationEngine`. It is declared here as an
 * alias so the public entry point keeps the exact contract signature while
 * the module stays independent of engine internals.
 */
export type LeaderEngine = ConversationEngine;

/** Structural projection-factory contract for the durable default wiring. */
export interface ResultProjectionLike {
  projectToolResult: (input: LeaderProjectionInput) => unknown | Promise<unknown>;
  tool?: RuntimeTool;
}

export interface LeaderRuntimeOptions {
  store: Store;
  projection?: LeaderProjection;
}

export interface LeaderRuntime {
  runTaskLeader(input: TaskLeaderInput): Promise<EngineResult>;
  /** Offline inspection only; never permission to execute or claim completion. */
  summary(taskId: string): LeaderSessionSummary;
  session(taskId: string): LeaderSessionRecord | undefined;
  inboxReceipt(taskId: string, eventId: string, revision: string): LeaderInboxRecord | undefined;
  journal(taskId: string): ReturnType<typeof leaderJournal>;
  operations(taskId: string): LeaderOperationRecord[];
  messages(taskId: string): LeaderMessageRecord[];
  /** Durable pending/unknown writes that block continuation until resolved. */
  blockedWrites(taskId: string): LeaderOperationRecord[];
  /**
   * Record an evidence- or user-decided resolution for an unknown write. The
   * Leader model can never call this: it exists for the operations boundary.
   */
  resolveWrite(input: {
    taskId: string;
    operationId: string;
    choice: "treat_done" | "abandon";
    decidedBy: "evidence" | "user";
    reason: string;
    result?: unknown;
  }): LeaderOperationRecord;
}

/** Durable result factory with an optional canonical-preservation hook. */
type ResultProjectionFactory = (
  store: Store,
  actor: ActorContext,
  scope: string,
) => ResultProjectionLike & {
  preserve?: (input: {
    toolCallId: string;
    tool: string;
    value: unknown;
    isError: boolean;
  }) => void;
};

const projectionFactory: ResultProjectionFactory | undefined = createResultProjection;

/** Fixed per-store mutex: every runtime for one store serializes task activations. */
const sharedMutex = new KeyedMutex();
const runtimes = new WeakMap<Store, LeaderRuntime>();

function supersededText(eventId: string, revision: string): string {
  return JSON.stringify({
    outcome: "superseded",
    eventId,
    revision,
    note: "该事件修订已被更新的修订取代；本轮未执行任何调度动作，请按最新修订重新激活。",
  });
}

/** The frozen entry point: one independent durable Leader session per task. */
export function runTaskLeader(input: TaskLeaderInput): Promise<EngineResult> {
  return leaderRuntime(input.store).runTaskLeader(input);
}

/** Cached per store so the shared mutex really is shared across callers. */
export function leaderRuntime(
  store: Store,
  options: { projection?: LeaderProjection } = {},
): LeaderRuntime {
  const existing = runtimes.get(store);
  if (existing) return existing;
  const created = createLeaderRuntime({ store, projection: options.projection });
  runtimes.set(store, created);
  return created;
}

export function createLeaderRuntime(options: LeaderRuntimeOptions): LeaderRuntime {
  const service = new LeaderService(options);
  return {
    runTaskLeader: (input) => service.run(input),
    summary: (taskId) => service.summary(taskId),
    session: (taskId) => service.session(taskId),
    inboxReceipt: (taskId, eventId, revision) => service.inboxReceipt(taskId, eventId, revision),
    journal: (taskId) => leaderJournal(options.store, taskId),
    operations: (taskId) => leaderOperations(options.store, taskId),
    messages: (taskId) => leaderTaskMessages(options.store, taskId),
    blockedWrites: (taskId) => service.blockedWrites(taskId),
    resolveWrite: (input) => service.resolveWrite(input),
  };
}

/** Adapt a durable result factory (or test double) to the Leader projection. */
export function adoptResultProjection(
  factory: ResultProjectionLike,
  scope: string,
): LeaderProjection {
  const preserve = (factory as { preserve?: LeaderProjection["preserve"] }).preserve;
  return {
    projectToolResult: (input) => factory.projectToolResult(input),
    tool: factory.tool,
    scope,
    source: "durable-store",
    ...(preserve ? { preserve: (input) => preserve({ ...input }) } : {}),
  };
}

/**
 * Production activations use the durable result factory: a scoped store for
 * oversized results plus the read-only, scope-checked `tool_result_read` tool.
 * The scope is stable per task Leader so a reference returned by an earlier
 * activation stays readable, while owner/session/task isolation is enforced.
 */
function defaultProjection(
  store: Store,
  actor: ActorContext,
  taskId: string,
  factory: ResultProjectionFactory | undefined = projectionFactory,
): LeaderProjection | undefined {
  // An absent adapter uses the runtime's bounded projection fallback.
  if (!factory) return undefined;
  return adoptResultProjection(factory(store, actor, leaderScope(taskId)), leaderScope(taskId));
}

class LeaderService {
  private readonly store: Store;
  private readonly fallbackProjection: LeaderProjection;
  private readonly injected?: LeaderProjection;

  constructor(options: LeaderRuntimeOptions) {
    this.store = options.store;
    this.injected = options.projection;
    this.fallbackProjection = {
      scope: leaderScope("runtime-bound"),
      source: "runtime-bound",
      projectToolResult: (input) => input.result,
    };
  }

  async run(input: TaskLeaderInput): Promise<EngineResult> {
    validateInput(input);
    const taskId = input.actor.taskId as string;
    const ownerId = input.actor.ownerId;
    // One shared per-store/task mutex: concurrent activations of the same task
    // can never interleave, while different tasks and owners stay independent.
    return sharedMutex.run(`leader\u0000${ownerId}\u0000${taskId}`, () =>
      this.activate(taskId, ownerId, input),
    );
  }

  blockedWrites(taskId: string): LeaderOperationRecord[] {
    return leaderOperations(this.store, taskId).filter(
      (operation) => operation.state === "pending" || operation.state === "unknown",
    );
  }

  resolveWrite(input: {
    taskId: string;
    operationId: string;
    choice: "treat_done" | "abandon";
    decidedBy: "evidence" | "user";
    reason: string;
    result?: unknown;
  }): LeaderOperationRecord {
    if (input.decidedBy !== "evidence" && input.decidedBy !== "user")
      throw new OperationError("operation_resolution_invalid", "未知写入只能由证据或用户决议。");
    if (!input.reason.trim())
      throw new OperationError("operation_resolution_invalid", "决议需要说明依据。");
    return this.store.transaction(() => {
      const operation = readLeaderRecord<LeaderOperationRecord>(
        this.store,
        LEADER_OPERATIONS,
        input.operationId,
        "写操作",
      );
      if (!operation || operation.taskId !== input.taskId)
        throw new OperationError("operation_resolution_invalid", "未找到对应的 Leader 写操作。");
      if (operation.state !== "pending" && operation.state !== "unknown")
        throw new OperationError("operation_resolution_invalid", "只有未确认的写操作可以决议。");
      if (input.choice === "treat_done" && input.result === undefined)
        throw new OperationError("operation_resolution_invalid", "按已完成处理必须提供目标结果。");
      const at = now();
      const updated: LeaderOperationRecord = {
        ...operation,
        state: input.choice === "treat_done" ? "complete" : "not_executed",
        result: input.choice === "treat_done" ? input.result : operation.result,
        // An abandoned operation is not retryable even though its business
        // outcome is recorded as not executed: the durable decision forbids the
        // exact operation id from ever being re-created.
        resolution: {
          choice: input.choice,
          decidedBy: input.decidedBy,
          reason: input.reason,
          at,
        },
        error:
          input.choice === "abandon"
            ? { code: "operation_abandoned", message: input.reason, outcome: "not_executed" }
            : operation.error,
        updatedAt: at,
      };
      this.store.set<LeaderOperationRecord>(LEADER_OPERATIONS, operation.id, updated);
      appendLeaderJournal(this.store, {
        kind: "recovery_receipt",
        taskId: input.taskId,
        sessionId: operation.sessionId,
        activationId: operation.activationId,
        eventId: operation.eventId,
        revision: operation.revision,
        detail: {
          id: operation.id,
          choice: input.choice,
          decidedBy: input.decidedBy,
          reason: input.reason,
        },
      });
      return updated;
    });
  }

  summary(taskId: string): LeaderSessionSummary {
    const session = this.session(taskId);
    const inbox = this.store
      .list<LeaderInboxRecord>(LEADER_INBOX)
      .filter((record) => record.taskId === taskId);
    const activations = this.store
      .list<LeaderActivationRecord>(LEADER_ACTIVATIONS)
      .filter((record) => record.taskId === taskId);
    const operations = leaderOperations(this.store, taskId);
    const checkpoints = this.store
      .list<{ taskId: string; bytes: number }>(LEADER_CHECKPOINTS)
      .filter((record) => record.taskId === taskId);
    const count = <T extends string>(values: T[], states: readonly T[]) =>
      Object.fromEntries([
        ...states.map((state) => [state, values.filter((value) => value === state).length]),
        ["total", values.length],
      ]) as Record<T | "total", number>;
    return {
      version: LEADER_RUNTIME_VERSION,
      taskId,
      sessionId: session?.id,
      ownerId: session?.ownerId,
      messages: leaderTaskMessages(this.store, taskId).length,
      inbox: count(
        inbox.map((record) => record.state),
        ["pending", "active", "recorded", "failed", "superseded"] as const,
      ),
      activations: count(
        activations.map((record) => record.state),
        ["active", "recorded", "failed", "superseded", "abandoned"] as const,
      ),
      operations: count(
        operations.map((record) => record.state),
        ["pending", "complete", "unknown", "not_executed"] as const,
      ),
      journalEntries: leaderJournal(this.store, taskId).length,
      // The reported size is the actual stored checkpoint, including any
      // bounded summary that replaced omitted batches.
      checkpointBytes: checkpoints.reduce((total, record) => total + (record.bytes ?? 0), 0),
      businessCompletion: "unknown",
    };
  }

  session(taskId: string): LeaderSessionRecord | undefined {
    return readLeaderRecord<LeaderSessionRecord>(
      this.store,
      LEADER_SESSIONS,
      leaderSessionId(taskId),
      "会话",
    );
  }

  inboxReceipt(taskId: string, eventId: string, revision: string): LeaderInboxRecord | undefined {
    return readLeaderRecord<LeaderInboxRecord>(
      this.store,
      LEADER_INBOX,
      leaderInboxId(taskId, eventId, revision),
      "收件回执",
    );
  }

  private activate(taskId: string, ownerId: string, input: TaskLeaderInput): Promise<EngineResult> {
    const session = this.ensureSession(taskId, ownerId);
    const inboxId = leaderInboxId(taskId, input.eventId, input.revision);
    const event = this.recordEvent(
      taskId,
      ownerId,
      session.id,
      input.eventId,
      input.revision,
      inboxId,
    );
    // The inbox receipt decides duplicate delivery and attempt counting; a
    // record this runtime cannot interpret must refuse here, before the engine.
    const inbox = readLeaderRecord<LeaderInboxRecord>(
      this.store,
      LEADER_INBOX,
      inboxId,
      "收件回执",
    ) as LeaderInboxRecord;
    if (inbox.state === "recorded" || inbox.state === "superseded")
      // Duplicate delivery of the same event and revision returns the recorded
      // receipt; the engine is never called a second time.
      return Promise.resolve({
        text: inbox.resultText ?? "",
        messages: leaderHistory(this.store, taskId),
        toolCalls: 0,
        writeCalls: 0,
      });
    if (event.currentRevision !== input.revision) {
      // Only a revision recorded as newer than the current one may advance it.
      // Anything else is a stale or unknown revision and never executes.
      const known = event.revisions.indexOf(input.revision);
      const current = event.revisions.indexOf(event.currentRevision);
      if (known >= 0 && known < current)
        return Promise.resolve(
          this.markSuperseded(taskId, session.id, input.eventId, input.revision, inboxId, event),
        );
      throw new OperationError(
        "revision_stale",
        "该事件修订不是当前最新修订；本轮未执行任何调度动作。",
        "not_executed",
      );
    }
    if (inbox.attempts >= LEADER_MAX_ATTEMPTS)
      throw new OperationError(
        "context_budget",
        "任务 Leader 激活已达重试上限；未确认的写入不得重放，请先核对实际状态。",
        "unknown",
      );
    const projection =
      input.projection ??
      this.injected ??
      defaultProjection(this.store, sessionActor(session, input.eventId), taskId) ??
      this.fallbackProjection;
    return this.activateOnce({
      taskId,
      ownerId,
      session,
      projection,
      input,
      inbox,
      attempt: inbox.attempts + 1,
    });
  }

  private async activateOnce(input: {
    taskId: string;
    ownerId: string;
    session: LeaderSessionRecord;
    projection: LeaderProjection;
    input: TaskLeaderInput;
    inbox: LeaderInboxRecord;
    attempt: number;
  }): Promise<EngineResult> {
    const outcome = await executeActivation({
      store: this.store,
      taskId: input.taskId,
      ownerId: input.ownerId,
      session: input.session,
      projection: input.projection,
      eventId: input.input.eventId,
      revision: input.input.revision,
      prompt: input.input.prompt,
      systemPrompt: input.input.systemPrompt,
      tools: input.input.tools,
      signal: input.input.signal,
      assertCurrent: input.input.assertCurrent,
      engine: (engineInput) => input.input.engine.run(engineInput),
      engineTokens: input.input.engine.contextTokens,
      inbox: input.inbox,
      attempt: input.attempt,
    });
    return {
      ...outcome.result,
      text: outcome.text,
      // The returned surface is the Leader's own bounded durable history, never
      // the engine's raw transcript and never any outer-session content.
      messages: leaderHistory(this.store, input.taskId),
    };
  }

  private ensureSession(taskId: string, ownerId: string): LeaderSessionRecord {
    const id = leaderSessionId(taskId);
    // An existing session written by another version is never reused AND never
    // overwritten: this path refuses typed instead of recreating the record,
    // because its identity fields may not mean what this runtime assumes.
    const existing = readLeaderRecord<LeaderSessionRecord>(this.store, LEADER_SESSIONS, id, "会话");
    if (existing) {
      if (existing.ownerId !== ownerId || existing.taskId !== taskId)
        throw new OperationError("invalid_scope", "任务 Leader 会话归属不匹配。");
      return existing;
    }
    const at = now();
    const session: LeaderSessionRecord = {
      version: LEADER_RUNTIME_VERSION,
      id,
      taskId,
      ownerId,
      generation: 0,
      status: "idle",
      createdAt: at,
      updatedAt: at,
    };
    this.store.set<LeaderSessionRecord>(LEADER_SESSIONS, id, session);
    return session;
  }

  private recordEvent(
    taskId: string,
    ownerId: string,
    sessionId: string,
    eventId: string,
    revision: string,
    inboxId: string,
  ): LeaderEventRecord {
    return this.store.transaction(() => {
      const key = leaderEventKey(taskId, eventId);
      const existing = readLeaderRecord<LeaderEventRecord>(this.store, LEADER_EVENTS, key, "事件");
      const at = now();
      if (!readLeaderRecord<LeaderInboxRecord>(this.store, LEADER_INBOX, inboxId, "收件回执"))
        this.store.set<LeaderInboxRecord>(LEADER_INBOX, inboxId, {
          version: LEADER_RUNTIME_VERSION,
          id: inboxId,
          key,
          taskId,
          sessionId,
          ownerId,
          eventId,
          revision,
          state: "pending",
          attempts: 0,
          createdAt: at,
          updatedAt: at,
        });
      if (!existing) {
        const record: LeaderEventRecord = {
          version: LEADER_RUNTIME_VERSION,
          taskId,
          eventId,
          ownerId,
          revisions: [revision],
          currentRevision: revision,
          state: "pending",
          inboxIds: [inboxId],
          createdAt: at,
          updatedAt: at,
        };
        this.store.set<LeaderEventRecord>(LEADER_EVENTS, key, record);
        return record;
      }
      if (existing.ownerId !== ownerId)
        throw new OperationError("invalid_scope", "任务 Leader 事件归属不匹配。");
      if (existing.revisions.includes(revision)) return existing;
      // A revision may only supersede pending work for the same event. Once an
      // activation has been recorded, a different revision is stale: a genuinely
      // newer revision is a new event id, which is how this codebase already
      // derives event identity from the user revision.
      if (this.recordedActivation(existing)) return existing;
      const updated: LeaderEventRecord = {
        ...existing,
        revisions: [...existing.revisions, revision],
        currentRevision: revision,
        state: "pending",
        inboxIds: [...existing.inboxIds, inboxId],
        updatedAt: at,
      };
      this.store.set<LeaderEventRecord>(LEADER_EVENTS, key, updated);
      for (const older of existing.revisions) {
        const olderId = leaderInboxId(taskId, eventId, older);
        const olderInbox = readLeaderRecord<LeaderInboxRecord>(
          this.store,
          LEADER_INBOX,
          olderId,
          "收件回执",
        );
        if (!olderInbox || olderInbox.state !== "pending") continue;
        this.store.set<LeaderInboxRecord>(LEADER_INBOX, olderId, {
          ...olderInbox,
          state: "superseded",
          supersededBy: inboxId,
          resultText: supersededText(eventId, older),
          updatedAt: at,
        });
        appendLeaderJournal(this.store, {
          kind: "event_superseded",
          taskId,
          sessionId,
          eventId,
          revision: older,
          detail: { inboxId: olderId, supersededBy: inboxId },
        });
      }
      return updated;
    });
  }

  /** True when any revision of this event already produced a durable result. */
  private recordedActivation(event: LeaderEventRecord): boolean {
    return event.inboxIds.some((id) => {
      const inbox = readLeaderRecord<LeaderInboxRecord>(this.store, LEADER_INBOX, id, "收件回执");
      return inbox?.state === "recorded" || inbox?.state === "active";
    });
  }

  private markSuperseded(
    taskId: string,
    sessionId: string,
    eventId: string,
    revision: string,
    inboxId: string,
    event: LeaderEventRecord,
  ): EngineResult {
    return this.store.transaction(() => {
      const text = supersededText(eventId, revision);
      const inbox = this.store.get<LeaderInboxRecord>(LEADER_INBOX, inboxId) as LeaderInboxRecord;
      this.store.set<LeaderInboxRecord>(LEADER_INBOX, inboxId, {
        ...inbox,
        state: "superseded",
        resultText: text,
        updatedAt: now(),
      });
      appendLeaderJournal(this.store, {
        kind: "duplicate_event",
        taskId,
        sessionId,
        eventId,
        revision,
        detail: { inboxId, reason: "stale_revision", currentRevision: event.currentRevision },
      });
      return { text, messages: [], toolCalls: 0, writeCalls: 0 };
    });
  }
}

function validateInput(input: TaskLeaderInput): void {
  if (!input.store || typeof input.store.get !== "function")
    throw new OperationError("invalid_scope", "任务 Leader 缺少持久存储。");
  if (!input.engine || typeof input.engine.run !== "function")
    throw new OperationError("invalid_scope", "任务 Leader 缺少对话引擎。");
  if (!input.actor?.ownerId?.trim())
    throw new OperationError("identity_required", "任务 Leader 缺少所有者身份。");
  const taskId = input.actor.taskId;
  if (!taskId?.trim()) throw new OperationError("task_required", "任务 Leader 必须绑定任务。");
  if (taskId !== taskId.trim() || /[^\x21-\x7e]/.test(taskId))
    throw new OperationError("invalid_scope", "任务标识无效，禁止跨任务激活。");
  if (!input.eventId?.trim())
    throw new OperationError("event_required", "任务 Leader 缺少事件标识。");
  if (!input.revision?.trim())
    throw new OperationError("revision_required", "任务 Leader 缺少修订标识。");
  const names = new Set<string>();
  for (const tool of input.tools ?? []) {
    const name = typeof tool?.name === "string" ? tool.name.trim() : "";
    if (!name) throw new OperationError("invalid_scope", "任务 Leader 工具缺少名称。");
    if (names.has(name))
      throw new OperationError("invalid_scope", `任务 Leader 工具重复：${name}。`);
    names.add(name);
    if (typeof tool.execute !== "function")
      throw new OperationError("invalid_scope", `任务 Leader 工具 ${name} 缺少执行入口。`);
    if (tool.readOnly !== true && tool.readOnly !== false)
      throw new OperationError("invalid_scope", `任务 Leader 工具 ${name} 未声明读写范围。`);
  }
  if (!input.systemPrompt?.trim() && !input.prompt?.trim())
    throw new OperationError("invalid_input", "任务 Leader 缺少本轮输入。");
}
