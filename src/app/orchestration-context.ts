import { fail, OperationError, safeError } from "../core/errors.js";
import type { Participant, StoredMessage, Task, TaskMutationRevision } from "../core/types.js";
import { LEADER_PROMPT_MAX_BYTES } from "../orchestration/leader-session-types.js";
import { modelInputBudgetTokens } from "../runtime/model-context.js";
import type { ConversationEngine } from "../runtime/types.js";
import type { OrchestrationDecision, OrchestrationEvent } from "./task-orchestrator.js";

/**
 * Legacy model-mode scheduling context.
 *
 * The activation payload sent to the task Leader is split into two strictly
 * different classes of data:
 *
 *  - MANDATORY facts are the authenticated task identity, EVERY authenticated
 *    user revision, the current event/revision identity, the participant
 *    roster with its role/scope constraints and the inherited parent
 *    requirements. Every one of them is carried VERBATIM. A truncation notice
 *    or a `fullText` read pointer is not authority: it cannot be substituted
 *    for a constraint the model has not actually read. When the complete
 *    mandatory core cannot fit the configured model context, the activation is
 *    refused with a typed budget error before any inference or action.
 *  - OPTIONAL observations are the output index and its note, the bounded
 *    recent output excerpts, prior decision summaries and task mutation notes.
 *    They are shortened byte-safely, halved and then removed one list at a
 *    time, down to the last authoritative output row and the output index, so a
 *    workable request is never refused because of optional history.
 *
 * The canonical records themselves are never rewritten or dropped: everything
 * shed here stays readable through the scoped read-only tools.
 */

/** One output row in the bounded index; never the body itself. */
export interface OutputIndexEntry {
  outputId: string;
  participantId: string;
  sequence?: number;
  observedAt: string;
  characters: number;
  /** The full body is reachable through the scoped orchestration_output tool. */
  fullBody: "orchestration_output";
}

export interface ContextBudgetInput {
  /** Configured model context; the whole request reserves system/tools/output. */
  engineTokens: number;
  /** Serialized activation envelope measured after escaping. */
  prompt: string;
}

/** Smallest envelope worth sending; below this the request is refused typed. */
const MIN_ACTIVATION_BYTES = 2048;
const OPTIONAL_TEXT_FLOOR = 240;
const MAX_RECENT_OUTPUTS = 8;
const MAX_RECENT_OUTPUT_CHARS = 6000;
const MAX_PRIOR_DECISIONS = 8;
const MAX_DECISION_REASON_CHARS = 2000;
/**
 * Maximum inherited parent-output excerpt. The parent task's own requirements
 * text is mandatory and is never shortened; only this optional observation is.
 */
const MAX_PARENT_OUTPUT_CHARS = 600;

export function activationBytes(prompt: string): number {
  return Buffer.byteLength(prompt, "utf8");
}

/** Conservative token estimate for one already-serialized envelope. */
export function estimateActivationTokens(prompt: string): number {
  return Math.ceil(activationBytes(prompt) / 3);
}

/**
 * Productive model context for the activation, using the same shared reserve the
 * runtime applies to every provider request (request overhead + output reserve).
 */
export function activationTokenBudget(engineTokens: number): number {
  return modelInputBudgetTokens(engineTokens);
}

/**
 * A mandatory payload must fit the model context even when every optional field
 * has been shed; otherwise no request may be attempted at all.
 */
export function assertMandatoryContextFits(input: ContextBudgetInput): void {
  const budget = activationTokenBudget(input.engineTokens);
  if (budget < 1)
    fail(
      "orchestration_context_budget",
      "当前模型上下文容量不足以容纳系统提示、工具与输出预留；未调用模型。请提高模型上下文容量后继续。",
    );
  const tokens = estimateActivationTokens(input.prompt);
  if (tokens > budget)
    fail(
      "orchestration_context_budget",
      `完整任务要求、修订与参与者约束约需 ${tokens} token，超过当前模型可用输入预算 ${budget}；为避免丢失末尾硬性约束，本轮未调用模型，原始要求完整保留。`,
    );
}

/** Byte budget for the complete escaped activation envelope, minus headroom. */
export function activationByteBudget(): number {
  return Math.max(MIN_ACTIVATION_BYTES, LEADER_PROMPT_MAX_BYTES - 256);
}

export interface PromptCandidate {
  /** Complete escaped JSON payload, never a prefix. */
  prompt: string;
  bytes: number;
  /** Optional fields removed or shortened to reach this candidate. */
  shed: string[];
  /**
   * True when the complete payload fits the inline activation budget. When
   * false the payload is still COMPLETE: the Leader runtime delivers it as its
   * single durable request message instead of severing it.
   */
  inline: boolean;
}

/** Optional text bounds, applied in this order before any list is dropped. */
const OPTIONAL_TEXT_LIMITS: Array<[string, number]> = [
  ["authoritativeOutputs", MAX_RECENT_OUTPUT_CHARS],
  ["priorDecisions", MAX_DECISION_REASON_CHARS],
  ["taskMutations", OPTIONAL_TEXT_FLOOR],
];

/** Lists whose row count may be halved (newest rows kept) before removal. */
const OPTIONAL_ROW_LISTS = ["authoritativeOutputs", "priorDecisions", "taskMutations"] as const;

/**
 * Last-resort removal order. Every optional list, including the excerpts
 * themselves and the bounded output index, may be removed when the complete
 * mandatory core fits but the optional observations do not. The excerpts go
 * before `outputIndex` because the index is the pointer the model uses to reach
 * older outputs on demand.
 */
const OPTIONAL_DROP_ORDER = [
  "taskMutations",
  "priorDecisions",
  "authoritativeOutputs",
  "reading",
  "outputIndexNote",
  "outputIndex",
];

type Envelope = Record<string, unknown>;

function serializeEnvelope(envelope: Envelope): string {
  try {
    return JSON.stringify(envelope) ?? "null";
  } catch (error) {
    throw new OperationError(
      "orchestration_context_budget",
      "任务上下文无法序列化；未调用模型，原始要求完整保留。",
      "not_executed",
      { cause: error },
    );
  }
}

function measured(envelope: Envelope, shed: string[]): PromptCandidate {
  const prompt = serializeEnvelope(envelope);
  const bytes = activationBytes(prompt);
  return { prompt, bytes, shed: [...shed], inline: bytes <= activationByteBudget() };
}

/**
 * Shed optional observations until the whole envelope fits the model context.
 *
 * Two different budgets apply, and confusing them would either sever a hard
 * constraint or needlessly refuse a workable request:
 *
 *  - The CONFIGURED MODEL CONTEXT is a hard ceiling. The complete mandatory
 *    payload must fit it, because no request can be sent at all otherwise. That
 *    check is `assertMandatoryContextFits`, run by the caller before this
 *    function.
 *  - `LEADER_PROMPT_MAX_BYTES` is a POLICY budget for delivery INLINE in the
 *    engine prompt. It is not a reason to refuse or truncate: the Leader runtime
 *    delivers a complete payload above it out-of-line as the single durable
 *    request message (`buildLeaderPrompt` returns `inline: false`). So this
 *    function only needs to bring the envelope inside the model context, and
 *    reports `inline` so the caller knows which delivery path applies.
 *
 * Mandatory fields are never touched at any point.
 */
export function boundActivationEnvelope(
  envelope: Envelope,
  options: { maxBytes?: number; tokenBudget?: number } = {},
): PromptCandidate {
  // Default to the real model-context ceiling; the inline policy budget is
  // reported through `inline`, never enforced by severing data.
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  const tokenBudget = options.tokenBudget ?? Number.MAX_SAFE_INTEGER;
  const shed: string[] = [];
  const fits = (candidate: PromptCandidate) =>
    candidate.bytes <= maxBytes && estimateActivationTokens(candidate.prompt) <= tokenBudget;
  const current = { ...envelope };
  let candidate = measured(current, shed);
  if (fits(candidate)) return candidate;
  // 1. Shorten optional text byte-safely first. Shortening preserves the shape
  //    of the payload (identities, counts, ordering) while removing the bytes
  //    that actually caused the overflow, so the model keeps the index of what
  //    exists instead of losing it wholesale. Mandatory revision/requirement
  //    text is never shortened, and the excerpts are only reachable this way
  //    until step 3, where the whole optional list can still be removed.
  for (const [key, limit] of OPTIONAL_TEXT_LIMITS) {
    const rows = current[key];
    if (!Array.isArray(rows) || !rows.length) continue;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const text = record.text;
      if (typeof text === "string" && activationBytes(text) > limit) {
        record.text = shrinkText(text, limit);
        shed.push(`${key}.text`);
      }
      if (typeof record.entry === "object" && record.entry) {
        const entry = record.entry as Record<string, unknown>;
        const body = entry.text;
        if (typeof body === "string" && activationBytes(body) > limit) {
          entry.text = shrinkText(body, limit);
          shed.push(`${key}.entry.text`);
        }
      }
      const reason = record.reason;
      if (typeof reason === "string" && activationBytes(reason) > OPTIONAL_TEXT_FLOOR) {
        record.reason = shrinkText(reason, OPTIONAL_TEXT_FLOOR);
        shed.push(`${key}.reason`);
      }
    }
    // The reading note only explains the index/excerpt names; it is optional too.
    if (key === "authoritativeOutputs" && Array.isArray(current.reading)) {
      delete current.reading;
      shed.push("reading");
    }
    candidate = measured(current, shed);
    if (fits(candidate)) return candidate;
  }
  // 2. Halve optional row counts, newest rows kept, before dropping a list.
  for (const key of OPTIONAL_ROW_LISTS) {
    while (Array.isArray(current[key]) && (current[key] as unknown[]).length > 1) {
      current[key] = (current[key] as unknown[]).slice(
        Math.max(1, Math.ceil((current[key] as unknown[]).length / 2)),
      );
      shed.push(`${key}.rows`);
      candidate = measured(current, shed);
      if (fits(candidate)) return candidate;
    }
  }
  // 3. Remove the remaining optional lists, including the last excerpt row and
  //    the output index itself. They carry no authority: shedding them changes
  //    no requirement, role, revision or event identity, and the canonical
  //    records stay readable through the scoped read-only tools.
  for (const key of OPTIONAL_DROP_ORDER) {
    if (current[key] === undefined) continue;
    delete current[key];
    shed.push(key);
    candidate = measured(current, shed);
    if (fits(candidate)) return candidate;
  }
  candidate = measured(current, shed);
  if (fits(candidate)) return candidate;
  fail(
    "orchestration_context_budget",
    `完整任务要求、全部用户修订、事件身份与参与者约束在省略全部可选观察后仍需约 ${estimateActivationTokens(candidate.prompt)} token，无法放入当前模型输入预算；为避免把未读到的末尾硬性约束当成已授权，本轮未调用模型也未执行任何动作。请提高模型上下文容量，或通过只读工具按需读取历史。`,
  );
}

/** UTF-8 safe shortening that never splits a surrogate pair or a code point. */
export function shrinkText(text: string, maxBytes: number): string {
  const marker = "…[已按模型边界缩短；完整原文仍保存在持久记录中，可用只读工具按需读取。]";
  if (activationBytes(text) <= maxBytes) return text;
  if (maxBytes <= 0) return "";
  const markerBytes = activationBytes(marker);
  const room = Math.max(0, maxBytes - Math.min(markerBytes, Math.floor(maxBytes / 2)));
  let used = 0;
  let kept = "";
  for (const character of text) {
    const size = activationBytes(character);
    if (used + size > room) break;
    kept += character;
    used += size;
  }
  const suffix = maxBytes - used >= markerBytes ? marker : "";
  return `${kept}${suffix}`;
}

export interface PriorDecisionFact {
  eventId: string;
  action: OrchestrationDecision["action"];
  reason: string;
  outputId?: string;
  participantId?: string;
  source?: OrchestrationDecision["source"];
}

/**
 * Bounded decision summaries. The full decision history stays in durable
 * records and is readable through the scoped task detail sections.
 */
export function priorDecisionFacts(events: readonly OrchestrationEvent[]): PriorDecisionFact[] {
  return events
    .filter((event) => event.decision)
    .slice(-MAX_PRIOR_DECISIONS)
    .map((event) => {
      const reason = shrinkText(event.decision?.reason ?? "", MAX_DECISION_REASON_CHARS);
      return {
        // The event/revision identity is mandatory: it proves which activation
        // produced the decision and lets a reader find its immutable record.
        eventId: event.id,
        action: event.decision?.action as OrchestrationDecision["action"],
        reason,
        ...(event.decision?.outputId ? { outputId: event.decision.outputId } : {}),
        ...(event.decision?.participantId ? { participantId: event.decision.participantId } : {}),
        ...(event.decision?.source ? { source: event.decision.source } : {}),
      };
    });
}

/** One bounded index row per settled output; the body is read on demand. */
export function outputIndexEntries(
  outputs: readonly {
    entry: { id: string; text: string };
    participantId: string;
    sequence?: number;
    observedAt: string;
  }[],
): OutputIndexEntry[] {
  return outputs.map((output) => ({
    outputId: output.entry.id,
    participantId: output.participantId,
    ...(output.sequence === undefined ? {} : { sequence: output.sequence }),
    observedAt: output.observedAt,
    characters: output.entry.text.length,
    fullBody: "orchestration_output" as const,
  }));
}

/** Bounded recent excerpts; every row states that the full body is readable. */
export function recentOutputExcerpts(
  outputs: readonly {
    entry: { id: string; text: string; final?: boolean; role?: string; timestamp?: string };
    participantId: string;
    sequence?: number;
    observedAt: string;
  }[],
): Array<Record<string, unknown>> {
  return outputs.slice(-MAX_RECENT_OUTPUTS).map((output) => {
    const text = shrinkText(output.entry.text, MAX_RECENT_OUTPUT_CHARS);
    return {
      // The legacy `entry` shape is preserved exactly so existing scheduling
      // contracts keep working; only the optional body text is bounded.
      ...output,
      entry: { ...output.entry, text },
      characters: output.entry.text.length,
      // An excerpt is never a substitute for the canonical body.
      truncated: text !== output.entry.text,
      fullBody: "orchestration_output",
    };
  });
}

export interface TaskContextEnvelopeInput {
  task: Task;
  participants: readonly Participant[];
  userMessages: readonly StoredMessage[];
  mutations: readonly TaskMutationRevision[];
  outputs: readonly {
    entry: { id: string; text: string; final?: boolean; role?: string };
    participantId: string;
    sequence?: number;
    observedAt: string;
  }[];
  decisions: readonly PriorDecisionFact[];
  event: Pick<OrchestrationEvent, "id" | "trigger" | "outputIds"> & {
    /** Current revision identity when the caller can provide it. */
    userRevision?: string;
  };
}

/**
 * The complete activation envelope. Mandatory facts are the full task record
 * (including every authenticated user revision VERBATIM and the frozen
 * requirements), the current event and revision identity, the participant
 * roster with unchangeable roles/scope, and the inherited parent requirements.
 * Optional observation fields are clearly marked as bounded and removable.
 */
export function taskContextEnvelope(input: TaskContextEnvelopeInput): Envelope {
  const parent = input.task.parentContext;
  return {
    event: {
      id: input.event.id,
      trigger: input.event.trigger,
      outputIds: [...input.event.outputIds],
      // The exact revision this activation is authorized for is mandatory: the
      // same event re-activated under a changed revision must not look current.
      ...(input.event.userRevision ? { userRevision: input.event.userRevision } : {}),
      note: "本轮事件身份；同一事件与修订的重复激活会命中持久回执而不会重复执行。",
    },
    task: {
      ...input.task,
      result: undefined,
      // Participant roles and parent requirements are mandatory constraints.
      // Only the inherited parent-output EXCERPT is bounded: a truncation notice
      // is never a substitute for the parent task's own requirements.
      parentContext: parent
        ? {
            ...parent,
            result: undefined,
            participants: parent.participants.map(({ name, kind, lastOutput }) => ({
              name,
              kind,
              lastOutput: shrinkText(lastOutput ?? "", MAX_PARENT_OUTPUT_CHARS),
            })),
          }
        : undefined,
      revision: undefined,
    },
    // Participant roles are mandatory constraints: the roster keeps its legacy
    // shape (existing schedulers read `id`/`initialSent`), with the explicit
    // statement that role authority cannot be changed by the scheduling model.
    participants: input.participants.map((participant) => ({
      ...participant,
      lastOutput: undefined,
      constraint: "角色与授权范围不可由调度模型更改；只能按原任务范围安排该参与者。",
    })),
    // Every authenticated user revision is mandatory and carried VERBATIM. A
    // `fullText` pointer into `task_detail` is NOT sufficient on its own: there
    // is no enforced read gate, so a pointer or truncation notice could hide a
    // trailing hard constraint from the model that is about to act. The model
    // can still page the canonical record for audit, but the authority itself
    // is always in front of it.
    userRevisions: input.userMessages.map((message) => ({
      id: message.id,
      createdAt: message.createdAt,
      text: message.text,
      fullText: "task_detail:requirements",
    })),
    taskMutations: input.mutations.map((mutation) => ({
      taskId: mutation.taskId,
      action: mutation.action,
      participantId: mutation.participantId,
      at: mutation.at,
      note: "已提交的任务配置变更，不是新的用户指令。",
    })),
    outputIndex: outputIndexEntries(input.outputs),
    outputIndexNote:
      "outputIndex 只有编号、参与者、长度与时间，没有正文；它不是完整历史，省略它不改变任何强制约束。",
    authoritativeOutputs: recentOutputExcerpts(input.outputs),
    reading: [
      "outputIndex 只有编号、参与者、长度与时间，没有正文；它不是完整历史。",
      "较早或更完整的原文用 orchestration_output 按 outputId 分页读取。",
      "完整需求、修订、决策证据与参与者输出还可用 task_detail 的 requirements/decisions/outputs 分页读取，再用 orchestration_output 取正文。",
      "列表被省略或缩短不代表记录不存在，也不改变任何强制约束。",
    ],
    priorDecisions: input.decisions,
  };
}

/**
 * The smallest honest version of the envelope: every optional observation list
 * removed, mandatory facts untouched. `userRevisions` is deliberately NOT in
 * this list: authenticated revisions are mandatory authority, so the model
 * context must be able to carry them before any request is attempted.
 */
export const OPTIONAL_ENVELOPE_KEYS = [
  "outputIndex",
  "outputIndexNote",
  "authoritativeOutputs",
  "priorDecisions",
  "taskMutations",
  "reading",
] as const;

export function mandatoryOnlyPrompt(envelope: Envelope): string {
  const mandatory: Envelope = { ...envelope };
  for (const key of OPTIONAL_ENVELOPE_KEYS) delete mandatory[key];
  return serializeEnvelope(mandatory);
}

/**
 * Direct child activation keys of one orchestration event. The Leader runtime
 * exposes its durable child records under these prefixes, so a stale activation
 * of the same event can be identified exactly instead of guessing.
 */
export function leaderEventChildPrefixes(eventId: string): string[] {
  return [`${eventId}:`];
}

/**
 * Reconcile exact native Leader receipts before a legacy activation. Any failure
 * here is reported, never promoted into a business failure or a replay.
 */
export function safeReconcile(
  reconcile: () => { changed: boolean; resolved: unknown[]; blocked: unknown[] },
  onError: (error: { code: string; message: string; outcome: string }) => void,
): { changed: boolean; resolved: number; blocked: number } {
  try {
    const report = reconcile();
    return {
      changed: report.changed,
      resolved: report.resolved.length,
      blocked: report.blocked.length,
    };
  } catch (error) {
    onError(safeError(error));
    return { changed: false, resolved: 0, blocked: 0 };
  }
}

/** True when a Leader refusal is a typed context/evidence refusal, not a model fault. */
export function isTypedLeaderRefusal(code: string): boolean {
  return [
    "orchestration_context_budget",
    "context_budget",
    "operation_unconfirmed",
    "leader_record_version_unsupported",
    "revision_stale",
    "orchestration_superseded",
    "stopping",
  ].includes(code);
}

export type { ConversationEngine };
