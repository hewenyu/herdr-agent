import { stableId } from "../core/ids.js";
import type { Participant, Task, UserRequestSource } from "../core/types.js";
import type { DecisionLog } from "../orchestration/decision-log.js";
import { reportText } from "../orchestration/report.js";
import { orchestrationUserMessages } from "../orchestration/user-messages.js";
import { WORKFLOWS, type WorkflowState } from "../orchestration/workflow.js";
import type { Store } from "../storage/store.js";
import type { TaskUserRevision } from "../tasks/user-request.js";
import type { OrchestrationEvent, SettledTaskOutput } from "./task-orchestrator.js";

/**
 * One pageable audit entry. `fields` is a bounded projection of the durable
 * record: every key is preserved, and an oversized value is replaced by a
 * spill marker whose `spilled` is the canonical path of a `segments` entry.
 * `segments` therefore carries the complete canonical text of every value that
 * did not fit inline, so no record is ever silently dropped or shortened.
 */
export interface DetailEntry {
  id: string;
  fields: Record<string, unknown>;
  segments: DetailSegment[];
  /** Content fingerprint of the canonical record; cursor validity depends on it. */
  digest: string;
}

export interface DetailSegment {
  /** Canonical location inside the record, e.g. `snapshot.original` or `candidates[2].description`. */
  path: string;
  /** Exact canonical content: raw text, or canonical JSON for a structured value. */
  text: string;
  encoding: "text" | "json";
}

export interface DetailSource {
  task: Task;
  state?: WorkflowState;
  store: Store;
}

export const TASK_DETAIL_SECTIONS = [
  "status",
  "participants",
  "requirements",
  "orchestration",
  "decisions",
  "planning",
  "nodes",
  "issues",
  "evidence",
  "evidence_notes",
  "status_blocks",
  "outputs",
  "artifacts",
  "delivery",
  "report",
] as const;

export type TaskDetailSection = (typeof TASK_DETAIL_SECTIONS)[number];

export const TASK_DETAIL_SECTION_HELP: Record<TaskDetailSection, string> = {
  status: "工作流阶段的完整持久状态（含计划、节点进度与未在默认摘要中展开的字段）",
  participants: "参与者完整持久记录（执行绑定、游标、错误、会话备注）",
  requirements: "任务分派摘要、创建时用户原文、显式上下文引用与后续用户修订原文",
  orchestration: "本任务调度事件：触发、状态、重试、派发、决策动作与错误",
  decisions: "不可变调度决策证据（选择策略、规则/JEV/pi 结果、完整快照与候选）",
  planning: "规划与合同/文档授权决策记录",
  nodes: "计划节点定义与进度、指令原文、依赖与产物修订",
  issues: "问题记录及全部回应历史",
  evidence: "证据记录（来源、命令、结果、修订）",
  evidence_notes: "参与者提交的原始材料与对话证据",
  status_blocks: "已接受回执块（摘要、阻塞、章节与问题/证据原文）",
  outputs: "参与者完整输出原文",
  artifacts: "产物文件证据（路径、哈希、修订）",
  delivery: "冻结的代码交付证据（仓库、分支、提交、PR）",
  report: "冻结交付报告正文",
};

/**
 * Bounds for one inlined value. A single inlined field must fit a minimal page
 * (limitBytes 512) together with its framing, so anything larger is registered
 * as a pageable segment instead of being forced into one unreadable atom.
 */
const INLINE_STRING_BYTES = 192;
/** Longest array kept inline at a nested position; longer arrays are chunked. */
const INLINE_ARRAY_ITEMS = 3;
/** Longest object kept inline at a nested position; wider objects are keyed out. */
const INLINE_OBJECT_KEYS = 3;
/** Largest serialized value kept inline at a nested position. */
const INLINE_VALUE_BYTES = 192;
const MAX_DEPTH = 16;

/** Marker keys: `$spill` names the canonical path, `$parts` its pageable parts. */
const SPILL_REF = "$spill";
const SPILL_PARTS = "$parts";

function textBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Registers a canonical segment once per path; empty text needs no page. */
function addSegment(
  segments: DetailSegment[],
  path: string,
  text: string,
  encoding: DetailSegment["encoding"],
): void {
  if (!text.length || segments.some((segment) => segment.path === path)) return;
  segments.push({ path, text, encoding });
}

/** Reads a dotted path from a canonical record; arrays use `[index]` suffixes. */
function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!part) continue;
    const match = /^([^[\]]*)((\[\d+\])*)$/.exec(part);
    if (!match || current === null || typeof current !== "object") return undefined;
    if (match[1]) current = (current as Record<string, unknown>)[match[1]];
    for (const index of (match[2] ?? "").match(/\d+/g) ?? []) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index)];
    }
  }
  return current;
}

/** Canonical JSON of a value as it is stored, never a lossy rendering. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/**
 * Compact in-place reference to canonical content that is delivered through
 * `segments` (and therefore through this section's pages). The marker stays
 * small on purpose: it is repeated on every page occurrence of the record,
 * while `segments` already carries the path, encoding and exact sizes.
 */
function spillMarker(path: string, parts: string[]): unknown {
  return { [SPILL_REF]: path, [SPILL_PARTS]: parts };
}

/**
 * Canonical projection. Every key of the record is preserved; a value that is
 * too large to inline at a nested position — or that the section declares a
 * canonical body — becomes a pageable segment, and the marker names its exact
 * canonical path. Nothing is dropped, truncated or summarised away.
 */
function project(
  value: unknown,
  path: string,
  segments: DetailSegment[],
  depth: number,
  bodyPaths: ReadonlySet<string>,
): unknown {
  if (typeof value === "string") {
    // An empty canonical body needs no page and must not claim it has one.
    if (!value.length || (textBytes(value) <= INLINE_STRING_BYTES && !bodyPaths.has(path)))
      return value;
    addSegment(segments, path, value, "text");
    return spillMarker(path, [path]);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return spillWhole(value, path, segments);
  if (Array.isArray(value)) {
    const projected = value.map(
      (item, index) => project(item, `${path}[${index}]`, segments, depth + 1, bodyPaths) ?? null,
    );
    if (depth === 0) return projected;
    if (value.length <= INLINE_ARRAY_ITEMS && textBytes(canonicalJson(value)) <= INLINE_VALUE_BYTES)
      return projected;
    // Arrays are spilled in chunks, so every part stays individually pageable
    // however many entries the canonical record holds.
    const parts: string[] = [];
    for (let start = 0; start < projected.length; start += INLINE_ARRAY_ITEMS) {
      const chunk = projected.slice(start, start + INLINE_ARRAY_ITEMS);
      const chunkPath = `${path}[${start}:${start + chunk.length}]`;
      addSegment(segments, chunkPath, canonicalJson(chunk), "json");
      parts.push(chunkPath);
    }
    return spillMarker(path, parts);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    const child = project(
      record[key],
      path ? `${path}.${key}` : key,
      segments,
      depth + 1,
      bodyPaths,
    );
    if (child !== undefined) projected[key] = child;
  }
  if (depth === 0) return projected;
  if (keys.length <= INLINE_OBJECT_KEYS && textBytes(canonicalJson(value)) <= INLINE_VALUE_BYTES)
    return projected;
  // A wide nested record is spilled one key at a time, preserving each key's
  // own canonical path instead of collapsing the whole object into one blob.
  const parts: string[] = [];
  for (const key of keys) {
    const childPath = `${path}.${key}`;
    addSegment(segments, childPath, canonicalJson(projected[key]), "json");
    parts.push(childPath);
  }
  return spillMarker(path, parts);
}

function spillWhole(value: unknown, path: string, segments: DetailSegment[]): unknown {
  addSegment(segments, path, canonicalJson(value), "json");
  return spillMarker(path, [path]);
}

interface EntryOptions {
  /** Fields delivered as pageable canonical text even when they would fit inline. */
  bodyPaths?: string[];
  /** Canonical content that lives outside `value`, e.g. a frozen report body. */
  extraSegments?: DetailSegment[];
}

/**
 * Build one entry from a canonical record. The digest covers the complete
 * canonical content, so a same-length modification still invalidates cursors.
 */
function makeEntry(id: string, value: unknown, options: EntryOptions = {}): DetailEntry {
  const segments: DetailSegment[] = [];
  const bodyPaths = new Set(options.bodyPaths ?? []);
  // Body fields are registered first, so `body` reproduces the canonical text
  // of this record in a stable order before any other spilled value.
  for (const path of bodyPaths) {
    const text = valueAt(value, path);
    if (typeof text === "string") addSegment(segments, path, text, "text");
  }
  for (const segment of options.extraSegments ?? [])
    addSegment(segments, segment.path, segment.text, segment.encoding);
  const digest = stableId(
    "task-detail-entry-v2",
    id,
    JSON.stringify(value) ?? "null",
    ...segments.map((segment) => `${segment.path}\u0000${segment.encoding}\u0000${segment.text}`),
  );
  const projected = project(value, "", segments, 0, bodyPaths);
  const fields =
    projected && typeof projected === "object" && !Array.isArray(projected)
      ? (projected as Record<string, unknown>)
      : { value: projected };
  return { id, fields, segments, digest };
}

function events(store: Store, taskId: string): OrchestrationEvent[] {
  return store
    .list<OrchestrationEvent>("task_orchestration_events")
    .filter((event) => event.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function orchestrationEntries(store: Store, taskId: string): DetailEntry[] {
  return events(store, taskId).map((event) => makeEntry(event.id, event));
}

/** Decision logs belong to this task when their key/eventId descends from one of its events. */
function decisionEntries(store: Store, taskId: string): DetailEntry[] {
  const ids = events(store, taskId).map((event) => event.id);
  const belongs = (key: string, log: DecisionLog) =>
    ids.some((id) => key.startsWith(`${id}:`) || log.eventId?.startsWith(`${id}:`));
  return store
    .entries<DecisionLog>("workflow_decisions")
    .filter(([key, log]) => belongs(key, log))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, log]) => makeEntry(key, log));
}

function planningEntries(store: Store, taskId: string): DetailEntry[] {
  const ids = events(store, taskId).map((event) => event.id);
  const related = (key: string) => ids.some((id) => key.startsWith(`${id}:`));
  const entries: DetailEntry[] = [];
  for (const [key, log] of store.entries<Record<string, unknown>>("workflow_planning_decisions"))
    if (related(key)) entries.push(makeEntry(key, { source: "planning", ...log }));
  for (const [key, log] of store.entries<Record<string, unknown>>("workflow_document_decisions"))
    if (related(key)) entries.push(makeEntry(key, { source: "document", ...log }));
  for (const [key, log] of store.entries<Record<string, unknown>>("workflow_contract_decisions"))
    if (log.taskId === taskId) entries.push(makeEntry(key, { source: "contract", ...log }));
  // Frozen plan versions and plans staged for an event are durable decisions;
  // the staged key is `<eventId>:<planVersion>` and belongs to this task.
  for (const [key, record] of store.entries<Record<string, unknown>>("workflow_plans"))
    if (record.taskId === taskId)
      entries.push(makeEntry(key, { source: "frozen_plan", ...record }));
  for (const [key, plan] of store.entries<Record<string, unknown>>("workflow_staged_plans"))
    if (related(key)) entries.push(makeEntry(key, { source: "staged_plan", plan }));
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

function nodeEntries(state: WorkflowState): DetailEntry[] {
  return state.plan.nodes.map((node) => {
    const progress = state.nodes[node.id];
    return makeEntry(
      node.id,
      {
        ...node,
        status: progress?.status ?? "pending",
        attempt: progress?.attempt ?? 0,
        progress: progress ?? { status: "pending", attempt: 0 },
      },
      { bodyPaths: ["instruction"] },
    );
  });
}

function issueEntries(state: WorkflowState): DetailEntry[] {
  // The description is the canonical issue body; responses stay inline because
  // each is already a short record the reader must see together with its issue.
  return state.issues.map((issue) => makeEntry(issue.id, issue, { bodyPaths: ["description"] }));
}

function evidenceEntries(state: WorkflowState): DetailEntry[] {
  return state.evidence.map((item) => makeEntry(item.id, item, { bodyPaths: ["description"] }));
}

function artifactEntries(state: WorkflowState): DetailEntry[] {
  return state.artifacts.map((artifact) =>
    makeEntry(
      stableId("workflow-artifact", artifact.outputId, artifact.path, artifact.artifactRevision),
      artifact,
    ),
  );
}

function requirementEntries(store: Store, task: Task): DetailEntry[] {
  const entries: DetailEntry[] = [
    makeEntry(
      `task_requirements:${task.id}`,
      {
        kind: "task_requirements",
        taskId: task.id,
        requirements: task.requirements,
        textBytes: textBytes(task.requirements),
      },
      { bodyPaths: ["requirements"] },
    ),
  ];
  const request = (id: string, kind: string, source: UserRequestSource | undefined) => {
    if (!source) return;
    entries.push(
      makeEntry(
        `${kind}:${id}`,
        { kind, ...source, textBytes: textBytes(source.text) },
        { bodyPaths: ["text"] },
      ),
    );
  };
  request("current", "user_request", task.userRequest);
  for (const [index, source] of (task.requestContext ?? []).entries())
    request(source.messageId || String(index), "request_context", source);
  const summary = store.get<{
    requirements: string;
    sourceMessageId: string;
    contextMessageIds: string[];
    at: string;
  }>("task_creation_summaries", task.id);
  if (summary)
    entries.push(
      makeEntry(
        `creation-summary:${task.id}`,
        {
          kind: "creation_summary",
          ...summary,
          textBytes: textBytes(summary.requirements),
        },
        { bodyPaths: ["requirements"] },
      ),
    );
  for (const message of orchestrationUserMessages(store, task)) {
    const id = message.id || message.deliveryIds?.[0] || message.createdAt;
    entries.push(
      makeEntry(
        `orchestration_message:${id}`,
        { kind: "orchestration_message", ...message, textBytes: textBytes(message.text) },
        { bodyPaths: ["text"] },
      ),
    );
  }
  // Every authenticated revision recorded for this task, including passive reads
  // that scheduling deliberately ignores; the reader still needs the original.
  for (const [key, revision] of store.entries<TaskUserRevision>("task_user_revisions"))
    if (revision.taskId === task.id && revision.source.ownerId === task.ownerId)
      entries.push(
        makeEntry(
          `revision:${key}`,
          {
            kind: "user_revision",
            usage: revision.usage,
            at: revision.at,
            ...revision.source,
            textBytes: textBytes(revision.source.text),
          },
          { bodyPaths: ["text"] },
        ),
      );
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

function participantEntries(participants: Participant[]): DetailEntry[] {
  // lastOutput is the participant's own record of its latest turn; it stays
  // pageable instead of being replaced by a summary.
  return participants.map((participant) =>
    makeEntry(participant.id, participant, {
      bodyPaths: participant.lastOutput ? ["lastOutput"] : [],
    }),
  );
}

function noteEntries(store: Store, taskId: string): DetailEntry[] {
  const entries = store
    .entries<{
      taskId: string;
      participantId: string;
      outputId: string;
      text: string;
      notes: string;
      hash: string;
    }>("workflow_conversation_evidence")
    .filter(([, record]) => record.taskId === taskId)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, record]) => makeEntry(key, record, { bodyPaths: ["notes"] }));
  // Rejected-handoff materials are canonical captured originals. Their complete
  // text must stay readable here with the same task binding as the receipt.
  for (const [key, material] of store.entries<Record<string, unknown>>(
    "workflow_recovery_materials",
  ))
    if (material.taskId === taskId)
      entries.push(
        makeEntry(
          key,
          { source: "recovery_material", ...material },
          { bodyPaths: material.notes ? ["text", "notes"] : ["text"] },
        ),
      );
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

function statusBlockEntries(store: Store, state: WorkflowState | undefined): DetailEntry[] {
  if (!state) return [];
  const consumed = new Set(state.consumedOutputs);
  return store
    .entries<{ taskId: string; block: Record<string, unknown> }>("workflow_status_blocks")
    .filter(([, record]) => record.taskId === state.taskId)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, record]) =>
      makeEntry(
        key,
        { consumed: consumed.has(key), block: record.block },
        { bodyPaths: ["block.summary"] },
      ),
    );
}

function outputEntries(store: Store, taskId: string): DetailEntry[] {
  return store
    .list<SettledTaskOutput>("task_settled_outputs")
    .filter((output) => output.taskId === taskId)
    .sort(
      (a, b) =>
        (a.sequence ?? 0) - (b.sequence ?? 0) ||
        a.observedAt.localeCompare(b.observedAt) ||
        a.entry.id.localeCompare(b.entry.id),
    )
    .map((output) => makeEntry(output.entry.id, output, { bodyPaths: ["entry.text"] }));
}

function deliveryEntries(state: WorkflowState | undefined): DetailEntry[] {
  const evidence = state?.deliveryEvidence;
  if (!evidence) return [];
  return evidence.repositories.map((repository, index) =>
    makeEntry(stableId("delivery", repository.directory, String(index)), {
      observedAt: evidence.observedAt,
      ...repository,
    }),
  );
}

async function reportEntries(state: WorkflowState | undefined): Promise<DetailEntry[]> {
  const report = state?.report;
  if (!state || !report) return [];
  let body: string | undefined;
  let readError: string | undefined;
  try {
    body = await reportText(state);
  } catch (error) {
    readError = error instanceof Error ? error.message : "报告正文读取失败。";
  }
  const segments: DetailSegment[] =
    body === undefined ? [] : [{ path: "body", text: body, encoding: "text" }];
  return [
    makeEntry(
      report.id,
      {
        ...report,
        bodyBytes: body === undefined ? undefined : textBytes(body),
        readError,
      },
      { extraSegments: segments },
    ),
  ];
}

function statusEntries(state: WorkflowState | undefined): DetailEntry[] {
  if (!state) return [];
  // The complete durable state, plus the reader-facing identifiers that were
  // previously only summarised; oversized plan text is paged, never dropped.
  return [
    makeEntry(state.taskId, {
      ...state,
      planId: state.plan.id,
      planVersion: state.plan.version,
      nodeIds: state.plan.nodes.map((node) => node.id),
    }),
  ];
}

/** Build every detail section for one task; callers page the result. */
export async function taskDetailSections(
  store: Store,
  task: Task,
  state: WorkflowState | undefined,
  participants: Participant[],
): Promise<Record<TaskDetailSection, DetailEntry[]>> {
  return {
    status: statusEntries(state),
    participants: participantEntries(participants),
    requirements: requirementEntries(store, task),
    orchestration: orchestrationEntries(store, task.id),
    decisions: decisionEntries(store, task.id),
    planning: planningEntries(store, task.id),
    nodes: state ? nodeEntries(state) : [],
    issues: state ? issueEntries(state) : [],
    evidence: state ? evidenceEntries(state) : [],
    evidence_notes: noteEntries(store, task.id),
    status_blocks: statusBlockEntries(store, state),
    outputs: outputEntries(store, task.id),
    artifacts: state ? artifactEntries(state) : [],
    delivery: deliveryEntries(state),
    report: await reportEntries(state),
  };
}

export function workflowOf(store: Store, taskId: string): WorkflowState | undefined {
  return store.get<WorkflowState>(WORKFLOWS, taskId);
}
