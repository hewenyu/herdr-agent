import { visibleOutput } from "../orchestration/status-block.js";
import type { WorkflowState } from "../orchestration/workflow.js";
import type { ProvisionEvidence } from "../runtime/provision-evidence.js";
import { readinessOf } from "../tasks/readiness.js";

/**
 * Model-facing task projections. Every value that leaves these helpers is a
 * bounded summary of a durable store record; raw audit history is only
 * available through the task_detail pages. Keep the domain records untouched.
 */

/** Must stay within the runtime's serialized tool-result budget. */
export const TASK_VIEW_MAX_BYTES = 16_384;
/** Envelope reserve for the tool name, arguments and message wrapper. */
export const TASK_VIEW_ENVELOPE_BYTES = 1_024;
const SUMMARY_CHARS = 480;
const ERROR_CHARS = 800;
const STRING_CAP_BYTES = 2_048;
const TOTAL_CONVERSATION_BYTES = 4_096;
const MIN_ENTRY_BYTES = 256;
const OMITTED_NOTE =
  "（原文超出模型投影字节预算，已省略；完整内容用 task_detail 对应 section 分页读取）";

export { OMITTED_NOTE as TASK_VIEW_OMITTED_NOTE };

export function modelBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
}

export function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…（已截断）`;
}

/**
 * Bounded UTF-8 prefix plus an explicit omission marker. The marker is counted
 * inside the budget, so the returned string never exceeds `maxBytes` and a
 * shortened value can never read as the complete original.
 */
export function truncateBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  const marker = OMITTED_NOTE;
  if (Buffer.byteLength(marker, "utf8") >= maxBytes) return prefixBytes(value, maxBytes);
  const room = maxBytes - Buffer.byteLength(marker, "utf8");
  if (room <= 0) return prefixBytes(marker, maxBytes);
  return `${prefixBytes(value, room)}${marker}`;
}

/** Largest prefix that stays inside the byte budget, without splitting a surrogate pair. */
function prefixBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    let prefix = value.slice(0, middle);
    const last = prefix.charCodeAt(prefix.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
    if (Buffer.byteLength(prefix, "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let prefix = value.slice(0, low);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix;
}

export interface BoundOptions {
  /** Degradation steps, run in order while the projection is still oversized. */
  shed?: Array<(draft: Record<string, unknown>) => boolean>;
  /** Last-resort value that must always fit: identities plus outcome facts. */
  critical?: Record<string, unknown>;
}

/**
 * Bound the FULL serialized projection, not one field. Oversized strings are
 * shortened first, then each shed step removes one audit-scale structure; the
 * result always states that it was truncated, so a partial view can never be
 * mistaken for the complete record. Returns the value unchanged when it fits.
 */
export function boundTaskView<T>(value: T, options: BoundOptions = {}): T {
  if (modelBytes(value) <= TASK_VIEW_MAX_BYTES) return value;
  const draft = structuredClone(value) as unknown;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return value;
  const record = draft as Record<string, unknown>;
  if (shedStrings(record, STRING_CAP_BYTES)) markTruncated(record);
  if (modelBytes(record) <= TASK_VIEW_MAX_BYTES) return record as T;
  for (const step of options.shed ?? []) {
    if (!step(record)) continue;
    markTruncated(record);
    if (modelBytes(record) <= TASK_VIEW_MAX_BYTES) return record as T;
  }
  const critical = options.critical ?? {};
  return { ...critical, truncated: true, truncatedNote: OMITTED_NOTE } as T;
}

function markTruncated(record: Record<string, unknown>): void {
  record.truncated = true;
  record.truncatedNote ??= OMITTED_NOTE;
}

/** Replaces oversized strings in place; reports whether anything changed. */
function shedStrings(value: unknown, cap: number, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  let changed = false;
  if (Array.isArray(value)) {
    for (const entry of value) changed = shedStrings(entry, cap, depth + 1) || changed;
    return changed;
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") {
      if (Buffer.byteLength(entry, "utf8") > cap) {
        record[key] = truncateBytes(entry, cap);
        changed = true;
      }
    } else {
      changed = shedStrings(entry, cap, depth + 1) || changed;
    }
  }
  return changed;
}

/** Bound a task list while keeping the array shape callers already rely on. */
export function boundTaskList(tasks: unknown[]): unknown[] {
  if (modelBytes(tasks) <= TASK_VIEW_MAX_BYTES) return tasks;
  const draft = structuredClone(tasks) as unknown[];
  shedStrings(draft, STRING_CAP_BYTES);
  let omitted = 0;
  while (draft.length > 1 && modelBytes([...draft, marker(omitted + 1)]) > TASK_VIEW_MAX_BYTES) {
    draft.pop();
    omitted++;
  }
  if (!omitted) return draft;
  return [...draft, marker(omitted)];
}

function marker(omitted: number): Record<string, unknown> {
  return {
    omittedTasks: omitted,
    note: `另有 ${omitted} 条任务记录超出模型投影字节预算，未在本页显示；可用 tasks_list 缩小范围或用 task_detail 按任务读取。`,
  };
}

export interface ParticipantViewInput {
  id: string;
  name: string;
  kind: string;
  role?: string;
  status: string;
  started: boolean;
  initialSent: boolean;
  initialDelivery?: "confirmed" | "decided" | "pending";
  readiness?: { phase: string; reason: string };
  error?: string;
  sessionNote?: string;
  lastOutput?: string;
  execution?: { paneId: string; kind: string; cwd: string; sessionId?: string };
}

/** Delivery and start facts that a success claim depends on; no audit prose. */
export function participantFacts(participant: ParticipantViewInput) {
  // A definite terminal native status must beat an older durable snapshot, so
  // this always classifies rather than trusting a possibly stale stored phase.
  const readiness = readinessOf(participant as never);
  return {
    id: participant.id,
    name: participant.name,
    kind: participant.kind,
    ...(participant.role ? { role: truncateText(participant.role, 120) } : {}),
    status: participant.status,
    started: participant.started,
    initialSent: participant.initialSent,
    ...(participant.initialDelivery === undefined
      ? {}
      : { initialDelivery: participant.initialDelivery }),
    hasExecution: !!participant.execution,
    hasNativeSessionId: !!participant.execution?.sessionId,
    hasOutput: !!participant.lastOutput?.trim(),
    // Managed-execution readiness, distinct from started/initialSent and from
    // the business task status. `ready` means input-capable, not "business done".
    readiness: readiness.phase,
    readinessReason: readiness.reason,
    error: participant.error ? truncateText(participant.error, ERROR_CHARS) : null,
    sessionNote: participant.sessionNote
      ? truncateText(participant.sessionNote, ERROR_CHARS)
      : null,
  };
}

export interface ParticipantRuntimeView {
  participantId: string;
  status: "ok" | "changed" | "gone" | "error";
  state?: string;
  sessionId?: string;
  context?: string;
  error?: string;
}

/** One runtime probe result: a status fact or an explicit read failure. */
export function runtimeFacts(
  participantId: string,
  outcome:
    | { kind: "observed"; status: string; sessionId?: string; context: string }
    | { kind: "changed"; message: string }
    | { kind: "gone" }
    | { kind: "error"; message: string },
): ParticipantRuntimeView {
  if (outcome.kind === "observed")
    return {
      participantId,
      status: "ok",
      state: outcome.status,
      ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
      context: truncateText(outcome.context, 200),
    };
  if (outcome.kind === "changed")
    return { participantId, status: "changed", error: truncateText(outcome.message, ERROR_CHARS) };
  if (outcome.kind === "gone") return { participantId, status: "gone" };
  return { participantId, status: "error", error: truncateText(outcome.message, ERROR_CHARS) };
}

export interface ConversationEntryView {
  text: string;
  truncated: boolean;
}

/**
 * Bound a participant conversation page as a whole. Entries state whether they
 * were shortened, and the page states how many entries were left out, so a
 * bounded page cannot read as the participant's complete transcript.
 */
export function boundConversation(
  entries: Array<{ text: string }>,
  budget = TOTAL_CONVERSATION_BYTES,
): { entries: ConversationEntryView[]; omittedEntries: number; truncated: boolean } {
  const newestFirst: ConversationEntryView[] = [];
  let used = 0;
  let omitted = 0;
  let shortened = false;
  // Walk newest to oldest: the current turn matters most, and anything that no
  // longer fits is reported as omitted rather than silently dropped.
  for (const entry of [...entries].reverse()) {
    const text = visibleOutput(entry.text);
    if (!text.trim()) continue;
    const remaining = budget - used;
    if (remaining < MIN_ENTRY_BYTES) {
      omitted++;
      continue;
    }
    const bounded = truncateBytes(text, remaining);
    const truncated = bounded.length < text.length;
    if (truncated) shortened = true;
    used += Buffer.byteLength(bounded, "utf8");
    newestFirst.push({ text: bounded, truncated });
  }
  while (newestFirst.length > 1 && modelBytes([...newestFirst].reverse()) > budget) {
    newestFirst.pop();
    omitted++;
  }
  return {
    entries: newestFirst.reverse(),
    omittedEntries: omitted,
    truncated: omitted > 0 || shortened,
  };
}

export function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const name = key(value);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/** Status/plan/blocker/count summary; node, issue and evidence bodies stay in pages. */
export function workflowSummary(state: WorkflowState) {
  const nodes = state.plan.nodes.map((node) => ({
    id: node.id,
    phase: node.phase,
    role: node.role,
    access: node.access,
    purpose: truncateText(node.purpose, 160),
    status: state.nodes[node.id]?.status ?? "pending",
    attempt: state.nodes[node.id]?.attempt ?? 0,
    ...(state.nodes[node.id]?.outputId ? { outputId: state.nodes[node.id]?.outputId } : {}),
    ...(state.nodes[node.id]?.error
      ? { error: truncateText(state.nodes[node.id]?.error ?? "", ERROR_CHARS) }
      : {}),
  }));
  const openIssues = state.issues.filter((issue) => issue.status === "open");
  return {
    taskId: state.taskId,
    phase: state.phase,
    plan: {
      id: state.plan.id,
      version: state.plan.version,
      template: state.plan.template,
      templateVersion: state.plan.templateVersion,
      goal: truncateText(state.plan.goal, SUMMARY_CHARS),
      nodeCount: state.plan.nodes.length,
      // Requirements are user constraints; keep them all, but each one bounded.
      deliveryRequirements: state.plan.deliveryRequirements.map((item) => truncateText(item, 120)),
      ...(state.plan.requiredArtifacts?.length
        ? { requiredArtifacts: state.plan.requiredArtifacts.slice(0, 16) }
        : {}),
      ...(state.plan.validation ? { validation: state.plan.validation } : {}),
    },
    counts: {
      nodes: state.plan.nodes.length,
      nodeStatus: countBy(nodes, (node) => node.status),
      issues: state.issues.length,
      issueStatus: countBy(state.issues, (issue) => issue.status),
      openIssues: openIssues.length,
      blockingIssues: openIssues.filter((issue) => issue.blocking).length,
      evidence: state.evidence.length,
      evidenceResult: countBy(state.evidence, (item) => item.result),
      artifacts: state.artifacts.length,
      consumedOutputs: state.consumedOutputs.length,
    },
    nodes,
    // Only the open issues that still block a decision carry prose here; every
    // issue body (and the ones left out of this list) is a task_detail page.
    openIssues: openIssues.map((issue) => ({
      id: issue.id,
      description: truncateText(issue.description, 200),
      blocking: issue.blocking,
      needsRevalidation: issue.needsRevalidation === true,
      raisedBy: issue.raisedBy,
      responses: issue.responses.length,
    })),
    records: {
      nodes: "task_detail:nodes",
      issues: "task_detail:issues",
      evidence: "task_detail:evidence",
      report: "task_detail:report",
      orchestration: "task_detail:orchestration",
      decisions: "task_detail:decisions",
    },
    stall: state.stall,
    ...(state.planning ? { planning: state.planning } : {}),
    ...(state.planningReason
      ? { planningReason: truncateText(state.planningReason, SUMMARY_CHARS) }
      : {}),
    ...(state.error ? { error: truncateText(state.error, ERROR_CHARS) } : {}),
  };
}

/**
 * Reduce a workflow summary that still exceeds the budget, while keeping the
 * answerable facts: phase, plan version, node states and every count. Shed
 * steps drop listed bodies (issue prose first, then node prose) and state that
 * they were dropped, so no reader can mistake the summary for the full record.
 */
export function boundWorkflowSummary<T extends Record<string, unknown>>(summary: T): T {
  if (modelBytes(summary) <= TASK_VIEW_MAX_BYTES) return summary;
  const draft = structuredClone(summary) as Record<string, unknown>;
  draft.truncated = true;
  draft.truncatedNote = OMITTED_NOTE;
  const issues = draft.openIssues;
  if (Array.isArray(issues)) {
    draft.openIssues = issues.map((issue) =>
      issue && typeof issue === "object"
        ? {
            ...(issue as Record<string, unknown>),
            description: undefined,
            describedIn: "task_detail:issues",
          }
        : issue,
    );
    if (modelBytes(draft) <= TASK_VIEW_MAX_BYTES) return draft as T;
    draft.openIssueCount = issues.length;
    draft.openIssues = undefined;
  }
  const nodes = draft.nodes;
  if (Array.isArray(nodes)) {
    draft.nodes = nodes.map((node) =>
      node && typeof node === "object"
        ? {
            id: (node as Record<string, unknown>).id,
            status: (node as Record<string, unknown>).status,
            attempt: (node as Record<string, unknown>).attempt,
            outputId: (node as Record<string, unknown>).outputId,
          }
        : node,
    );
    if (modelBytes(draft) <= TASK_VIEW_MAX_BYTES) return draft as T;
    draft.nodeStates = nodes.map((node) =>
      node && typeof node === "object"
        ? [
            (node as Record<string, unknown>).id,
            (node as Record<string, unknown>).status,
            (node as Record<string, unknown>).attempt,
          ]
        : node,
    );
    draft.nodes = undefined;
  }
  return draft as T;
}

/** Report facts and its address; the frozen body is a durable artifact. */
export function reportFacts(state: WorkflowState) {
  const report = state.report;
  if (!report) return undefined;
  return {
    id: report.id,
    hash: report.hash,
    outputId: report.outputId,
    artifactRevision: report.artifactRevision,
    ...(report.deliveryRevision ? { deliveryRevision: report.deliveryRevision } : {}),
    path: report.path,
    body: "task_detail:report",
  };
}

/** Code delivery evidence summarized per repository; errors stay visible. */
export function deliveryFacts(state: WorkflowState) {
  const evidence = state.deliveryEvidence;
  if (!evidence) return undefined;
  return {
    observedAt: evidence.observedAt,
    repositories: evidence.repositories.map((repository) => ({
      directory: repository.directory,
      ...(repository.branch ? { branch: repository.branch } : {}),
      ...(repository.commit ? { commit: repository.commit } : {}),
      ...(repository.dirty === undefined ? {} : { dirty: repository.dirty }),
      ...(repository.upstream ? { upstream: repository.upstream } : {}),
      ...(repository.pr ? { pr: repository.pr } : {}),
      ...(repository.error ? { error: truncateText(repository.error, ERROR_CHARS) } : {}),
    })),
  };
}

/**
 * Answerable decision facts: status, identity and the exact questions. The
 * durable record keeps options, sources and diagnostics; those bodies are
 * readable through `task_detail:status`.
 */
export function decisionFacts(
  decision:
    | {
        status: "ready" | "system" | "failed";
        fingerprint?: string;
        questions: Array<{ question: string }>;
        diagnostics?: string[];
        reason?: string;
      }
    | undefined,
) {
  if (!decision) return undefined;
  return {
    status: decision.status,
    ...(decision.fingerprint ? { fingerprint: decision.fingerprint } : {}),
    questions: decision.questions.map((question) => truncateText(question.question, SUMMARY_CHARS)),
    ...(decision.reason ? { reason: truncateText(decision.reason, ERROR_CHARS) } : {}),
  };
}

/** Turn-level provisioning snapshot reused by the runtime claim policy. */
export function provisioningFacts(evidence: ProvisionEvidence) {
  return {
    created: [...evidence.created],
    tasks: evidence.tasks.map((task) => ({
      id: task.id,
      remoteTask: task.remoteTask,
      group: task.group,
      participants: task.participants.map((participant) => ({
        id: participant.id,
        name: participant.name,
        kind: participant.kind,
        sent: participant.sent,
      })),
      deliveries: [...task.deliveries],
    })),
  };
}
