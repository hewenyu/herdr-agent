import { fail, safeError } from "../core/errors.js";
import type { Participant, Task } from "../core/types.js";
import type { RuntimeTool } from "../runtime/types.js";
import type { Store } from "../storage/store.js";
import type { WorkflowCandidate } from "./candidates.js";
import { currentOpenIssues } from "./state.js";
import type { StatusBlock } from "./status-block.js";
import {
  WORKFLOWS,
  type WorkflowEvidence,
  type WorkflowIssue,
  type WorkflowState,
} from "./workflow.js";

/** Hard bounds for every model-facing read. Canonical records keep full content. */
export const LEADER_DETAIL_MAX_CHARS = 4000;
/** Offsets index the canonical record; long originals must stay addressable. */
export const LEADER_DETAIL_MAX_OFFSET = 100_000_000;
export const LEADER_PAGE_MAX_BYTES = 16384;
export const LEADER_REASON_MAX_CHARS = 1200;
export const LEADER_INSTRUCTION_MAX_CHARS = 2000;
export const LEADER_SUMMARY_MAX_CHARS = 600;

export type LeaderActionKind =
  | "dispatch"
  | "rework"
  | "verify"
  | "replan"
  | "add_reviewer"
  | "wait"
  | "deliver";

/** The single scheduling action a Leader commits in one activation. */
export interface LeaderActionRequest {
  action: LeaderActionKind;
  candidateId: string;
  reason: string;
  instruction?: string;
}

export interface LeaderActionReceipt {
  action: LeaderActionKind;
  candidateId: string;
  applied: true;
  nodeIds: string[];
  participantIds: string[];
  note: string;
}

export interface LeaderToolContext {
  store: Store;
  task: Task;
  state: WorkflowState;
  eventId: string;
  userRevision: string;
  artifactRevision: string;
  planVersion: number;
  candidates: readonly WorkflowCandidate[];
  participants: readonly Participant[];
  /** Configured verification command descriptions, already task-scoped. */
  commands: readonly string[];
  reportMissing: readonly string[];
  configRevision?: string;
  /** Board directory for this task, used only to render relative references. */
  boardDirectory?: string;
  /** Current user-revision hash; a change invalidates this activation's action. */
  revision(): string;
  assertCurrent(): void;
  /** Commits the validated action through the existing executor gates. */
  commit(action: LeaderActionRequest): Promise<void>;
  /** Lets the Leader record a grounded user question instead of guessing. */
  defer?(reason: string, code: string): Promise<void>;
}

const ACTION_KINDS: Record<
  Exclude<LeaderActionKind, "wait" | "deliver">,
  WorkflowCandidate["kind"]
> = {
  dispatch: "dispatch",
  rework: "rework",
  verify: "verify",
  replan: "replan",
  add_reviewer: "add_reviewer",
};

const USER_CANDIDATE_PREFIX = "user:";
const DELIVER_CANDIDATE_ID = "deliver:report";

function bounded(text: string, max = LEADER_SUMMARY_MAX_CHARS): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 24))}…[已截断，见详情工具]`;
}

/**
 * Page a canonical string so the COMPLETE returned envelope stays inside the
 * model byte budget. JSON escaping can expand one character to six bytes, so
 * the budget is measured after serialization, never on raw characters.
 */
function page(
  text: string,
  offset: number,
  limit: number,
  envelope: Record<string, unknown> = {},
): {
  text: string;
  offset: number;
  nextOffset?: number;
  total: number;
  truncated: boolean;
  bytes: number;
} {
  const total = text.length;
  const safeOffset = Math.min(Math.max(0, Math.floor(offset)), LEADER_DETAIL_MAX_OFFSET);
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), LEADER_DETAIL_MAX_CHARS);
  const frame = { ...envelope, offset: safeOffset, total };
  let length = Math.min(safeLimit, Math.max(0, total - safeOffset));
  let bytes = 0;
  for (let attempt = 0; attempt < 24; attempt++) {
    const end = safeOffset + length;
    const candidate = {
      ...frame,
      text: text.slice(safeOffset, end),
      truncated: end < total,
      ...(end < total ? { nextOffset: end } : {}),
      // The final envelope adds this field; account for it before measuring.
      bytes: 99999,
    };
    bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (bytes <= LEADER_PAGE_MAX_BYTES || length === 0) break;
    // Escaping is bounded at six bytes per code unit; shrink proportionally.
    length = Math.max(
      0,
      Math.min(length - 1, Math.floor((length * LEADER_PAGE_MAX_BYTES) / bytes)),
    );
  }
  const slice = text.slice(safeOffset, safeOffset + length);
  const next = safeOffset + slice.length;
  return {
    text: slice,
    offset: safeOffset,
    ...(next < total ? { nextOffset: next } : {}),
    total,
    truncated: next < total,
    bytes,
  };
}

function readPage(args: Record<string, unknown>): { offset: number; limit: number } {
  const offset = args.offset === undefined ? 0 : Number(args.offset);
  const limit = args.limit === undefined ? LEADER_DETAIL_MAX_CHARS : Number(args.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > LEADER_DETAIL_MAX_OFFSET)
    fail("workflow_leader_tool", "分页偏移无效。");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LEADER_DETAIL_MAX_CHARS)
    fail("workflow_leader_tool", "分页长度无效。");
  return { offset, limit };
}

function textArg(args: Record<string, unknown>, key: string, max: number): string;
function textArg(
  args: Record<string, unknown>,
  key: string,
  max: number,
  required: false,
): string | undefined;
function textArg(
  args: Record<string, unknown>,
  key: string,
  max: number,
  required = true,
): string | undefined {
  const value = args[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail("workflow_leader_tool", `${key} 必须是不超过 ${max} 字符的文本。`);
  return value.trim();
}

function nodeEntries(state: WorkflowState) {
  return state.plan.nodes.map((node) => ({
    id: node.id,
    phase: node.phase,
    role: node.role,
    purpose: bounded(node.purpose, 200),
    access: node.access,
    dependsOn: node.dependsOn,
    participantId: node.participantId,
    documentPaths: node.documentPaths,
    status: state.nodes[node.id]?.status ?? "pending",
    attempt: state.nodes[node.id]?.attempt ?? 0,
    error: state.nodes[node.id]?.error
      ? bounded(state.nodes[node.id]?.error ?? "", 300)
      : undefined,
  }));
}

function issueSummary(issue: WorkflowIssue) {
  return {
    id: issue.id,
    status: issue.status,
    blocking: issue.blocking,
    raisedBy: issue.raisedBy,
    description: bounded(issue.description, 300),
    evidenceRefs: issue.evidenceRefs.slice(0, 20),
  };
}

function evidenceSummary(evidence: WorkflowEvidence) {
  return {
    id: evidence.id,
    source: evidence.source,
    result: evidence.result,
    description: bounded(evidence.description ?? "", 240),
    command: evidence.command,
    artifactRevision: evidence.artifactRevision,
  };
}

function statusPayload(context: LeaderToolContext) {
  const ready = context.state.plan.nodes
    .filter(
      (node) =>
        context.state.nodes[node.id]?.status === "pending" &&
        node.dependsOn.every((id) => context.state.nodes[id]?.status === "completed"),
    )
    .map((node) => node.id);
  const blocked = Object.entries(context.state.nodes)
    .filter(([, progress]) => progress.status === "blocked")
    .map(([id]) => id);
  return {
    task: {
      id: context.task.id,
      kind: context.task.kind,
      title: bounded(context.task.title, 200),
      phase: context.state.phase,
      template: context.state.plan.template,
      planVersion: context.planVersion,
      userRevision: context.userRevision,
      artifactRevision: context.artifactRevision,
      configRevision: context.configRevision,
    },
    nodes: nodeEntries(context.state),
    ready,
    blocked,
    issues: currentOpenIssues(context.state).map(issueSummary),
    historyIssues: context.state.issues
      .filter((issue) => issue.status !== "open" || issue.needsRevalidation)
      .slice(-20)
      .map(issueSummary),
    evidence: context.state.evidence.slice(-20).map(evidenceSummary),
    reportMissing: context.reportMissing.map((entry) => bounded(entry, 200)),
    stall: {
      unchanged: context.state.stall.unchanged,
      awaitingUser: context.state.stall.awaitingUser,
    },
    participants: context.participants.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      role: entry.role,
      status: entry.status,
      started: entry.started,
      error: entry.error ? bounded(entry.error, 200) : undefined,
    })),
    configuredCommands: context.commands.map((command) => bounded(command, 200)),
    legalActions: context.candidates.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      description: bounded(candidate.description, 240),
    })),
    boardDirectory: context.boardDirectory,
    note: "这是有界摘要；原文与完整审计仍在持久记录中，可用 workflow_detail 分页读取。",
  };
}

function statusText(context: LeaderToolContext): string {
  return JSON.stringify(statusPayload(context), null, 1);
}

function conversationEntries(context: LeaderToolContext) {
  return context.state.consumedOutputs.slice(-12).map((id) => {
    const record = context.store.get<{
      text: string;
      notes: string;
      hash: string;
      participantId: string;
    }>("workflow_conversation_evidence", id);
    const progress = context.state.nodes;
    const node = context.state.plan.nodes.find((entry) => progress[entry.id]?.outputId === id);
    const accepted = context.store.get<{ taskId: string; block: StatusBlock }>(
      "workflow_status_blocks",
      id,
    );
    return {
      outputId: id,
      nodeId: node?.id,
      participantId: record?.participantId ?? progress[node?.id ?? ""]?.participantId,
      accepted: accepted?.taskId === context.task.id,
      summary:
        accepted?.taskId === context.task.id ? bounded(accepted.block.summary, 400) : undefined,
      blockers:
        accepted?.taskId === context.task.id
          ? accepted.block.blockers.map((entry) => bounded(entry, 240))
          : undefined,
      notesBytes: record?.notes ? Buffer.byteLength(record.notes, "utf8") : undefined,
      textBytes: record?.text ? Buffer.byteLength(record.text, "utf8") : undefined,
    };
  });
}

function boardSection(context: LeaderToolContext, section: string): string | undefined {
  const state = context.state;
  switch (section) {
    case "plan":
      return JSON.stringify(state.plan, null, 1);
    case "progress":
      return JSON.stringify(
        { phase: state.phase, nodes: state.nodes, stall: state.stall, report: state.report },
        null,
        1,
      );
    case "issues":
      return JSON.stringify(state.issues, null, 1);
    case "evidence":
      return JSON.stringify(state.evidence, null, 1);
    case "conversation":
      return JSON.stringify(conversationEntries(context), null, 1);
    case "recovery":
      return JSON.stringify(
        Object.entries(state.nodes)
          .filter(([, progress]) => !!progress.repair)
          .map(([nodeId, progress]) => ({
            nodeId,
            participantId: progress.participantId,
            outputId: progress.outputId,
            repair: progress.repair,
            note: "未通过回执校验的材料，只用于诊断修复，不是已接受证据或新授权。",
          })),
        null,
        1,
      );
    default:
      return undefined;
  }
}

const BOARD_SECTIONS = ["plan", "progress", "issues", "evidence", "conversation", "recovery"];

const DETAIL_KINDS = ["node", "issue", "evidence", "output", "participant", "recovery"] as const;

function detailPayload(context: LeaderToolContext, kind: string, id: string): string | undefined {
  const state = context.state;
  switch (kind) {
    case "node": {
      const node = state.plan.nodes.find((entry) => entry.id === id);
      if (!node) return undefined;
      return JSON.stringify({ node, progress: state.nodes[node.id] }, null, 1);
    }
    case "issue": {
      const issue = state.issues.find((entry) => entry.id === id);
      return issue ? JSON.stringify(issue, null, 1) : undefined;
    }
    case "evidence": {
      const evidence = state.evidence.find((entry) => entry.id === id);
      return evidence ? JSON.stringify(evidence, null, 1) : undefined;
    }
    case "participant": {
      const participant = context.participants.find((entry) => entry.id === id);
      return participant ? JSON.stringify(participant, null, 1) : undefined;
    }
    case "recovery": {
      const progress = state.nodes[id];
      if (!progress?.repair) return undefined;
      return JSON.stringify(
        {
          nodeId: id,
          participantId: progress.participantId,
          error: progress.error,
          repair: progress.repair,
          note: "未验证的恢复材料，仅用于诊断和修复。",
        },
        null,
        1,
      );
    }
    case "output": {
      const accepted = context.store.get<{ taskId: string; block: StatusBlock }>(
        "workflow_status_blocks",
        id,
      );
      if (accepted?.taskId !== context.task.id) return undefined;
      const record = context.store.get<{ text: string; notes: string }>(
        "workflow_conversation_evidence",
        id,
      );
      return JSON.stringify(
        {
          outputId: id,
          block: accepted.block,
          notes: record?.notes,
          text: record?.text,
          note: "已接受的交接回执与原文；缺失字段表示未保存该面。",
        },
        null,
        1,
      );
    }
    default:
      return undefined;
  }
}

function readTool(
  context: LeaderToolContext,
  name: string,
  description: string,
  run: (args: Record<string, unknown>) => unknown,
): RuntimeTool {
  return {
    name,
    description,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (args) => {
      context.assertCurrent();
      if (context.revision() !== context.userRevision)
        fail("orchestration_superseded", "用户要求已变化，本轮读取结果不再对应当前修订。");
      const value = run(args ?? {});
      context.assertCurrent();
      return value;
    },
  };
}

/** Bounded, owner/task-scoped reads. They never grant authorization by themselves. */
export function createLeaderReadTools(context: LeaderToolContext): RuntimeTool[] {
  const status = readTool(
    context,
    "workflow_status",
    "读取本任务当前阶段、节点、问题、已接受证据与合法调度动作的有界摘要。原文不在本结果中。",
    () => JSON.parse(statusText(context)) as unknown,
  );
  const board = readTool(
    context,
    "workflow_board",
    "按分页读取任务看板的一个区块（plan/progress/issues/evidence/conversation/recovery）。看板是持久状态投影，不授予权限。",
    (args) => {
      const section = typeof args.section === "string" ? args.section : "progress";
      if (!BOARD_SECTIONS.includes(section)) fail("workflow_leader_tool", "看板区块无效。");
      const { offset, limit } = readPage(args);
      const value = boardSection(context, section);
      if (value === undefined) fail("workflow_leader_tool", "看板区块不存在。");
      return { section, ...page(value, offset, limit, { section }) };
    },
  );
  board.parameters = {
    type: "object",
    properties: {
      section: { type: "string", enum: BOARD_SECTIONS },
      offset: { type: "integer", minimum: 0, maximum: LEADER_DETAIL_MAX_OFFSET },
      limit: { type: "integer", minimum: 1, maximum: LEADER_DETAIL_MAX_CHARS },
    },
    required: ["section"],
    additionalProperties: false,
  };
  const detail = readTool(
    context,
    "workflow_detail",
    "按编号分页读取单个节点、问题、证据、参与者、已接受输出或恢复材料。只读取本任务且已绑定所有者与修订的记录。",
    (args) => {
      const kind = typeof args.kind === "string" ? args.kind : "";
      if (!(DETAIL_KINDS as readonly string[]).includes(kind))
        fail("workflow_leader_tool", "详情类型无效。");
      const id = textArg(args, "id", 200);
      const { offset, limit } = readPage(args);
      const value = detailPayload(context, kind, id);
      if (value === undefined) fail("workflow_leader_tool", "该编号在本任务中不存在。");
      return { kind, id, ...page(value, offset, limit, { kind, id }) };
    },
  );
  detail.parameters = {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...DETAIL_KINDS] },
      id: { type: "string" },
      offset: { type: "integer", minimum: 0, maximum: LEADER_DETAIL_MAX_OFFSET },
      limit: { type: "integer", minimum: 1, maximum: LEADER_DETAIL_MAX_CHARS },
    },
    required: ["kind", "id"],
    additionalProperties: false,
  };
  return [status, board, detail];
}

export function leaderCandidate(
  candidates: readonly WorkflowCandidate[],
  kind: WorkflowCandidate["kind"],
  candidateId: string,
): WorkflowCandidate {
  const candidate = candidates.find((entry) => entry.id === candidateId);
  if (!candidate)
    fail(
      "workflow_leader_tool",
      "该编号不在程序本轮核定的合法骨架中；请用 workflow_status 重新读取。",
    );
  if (candidate.kind !== kind)
    fail("workflow_leader_tool", `编号 ${candidateId} 不属于 ${kind} 动作。`);
  return candidate;
}

function actionTool(
  context: LeaderToolContext,
  name: string,
  description: string,
  kind: LeaderActionKind,
  parameters: Record<string, unknown>,
  build: (args: Record<string, unknown>) => LeaderActionRequest,
): RuntimeTool {
  return {
    name,
    description,
    readOnly: false,
    parameters,
    execute: async (args) => {
      context.assertCurrent();
      if (context.revision() !== context.userRevision)
        fail("orchestration_superseded", "用户要求已变化，本轮调度动作已作废。");
      const request = build(args ?? {});
      const { candidate, nodeIds, participantIds } = describeAction(
        context,
        kind,
        request.candidateId,
      );
      await context.commit({ ...request, candidateId: candidate.id });
      return {
        action: kind,
        candidateId: candidate.id,
        accepted: true,
        nodeIds,
        participantIds,
        note: "动作已按当前修订与既有执行门禁提交；本结果不是业务完成，也不代表用户验收。",
      };
    },
  };
}

function describeAction(
  context: LeaderToolContext,
  kind: LeaderActionKind,
  candidateId: string,
): { candidate: WorkflowCandidate; nodeIds: string[]; participantIds: string[] } {
  if (kind === "wait") {
    const candidate = context.candidates.find((entry) =>
      entry.id.startsWith(USER_CANDIDATE_PREFIX),
    );
    if (!candidate)
      fail(
        "workflow_leader_tool",
        "没有已核定的等待候选：只有确实缺少用户决定、权限或必需信息时才可等待。",
      );
    return { candidate, nodeIds: [], participantIds: [] };
  }
  if (kind === "deliver") {
    const candidate = context.candidates.find((entry) => entry.id === DELIVER_CANDIDATE_ID);
    if (!candidate)
      fail("workflow_leader_tool", "报告合同尚未满足，不能交付；请先补齐证据或评审。");
    return { candidate, nodeIds: [], participantIds: [] };
  }
  const candidate = leaderCandidate(context.candidates, ACTION_KINDS[kind], candidateId);
  return {
    candidate,
    nodeIds: (candidate.assignments ?? []).map((assignment) => assignment.nodeId),
    participantIds: (candidate.assignments ?? []).map((assignment) => assignment.participantId),
  };
}

/**
 * Explicit scheduling actions. Each commits at most one authorized action per
 * activation through the existing executor gates (current revision, plan DAG,
 * resource admission, independent review); they never touch task lifecycle.
 */
export function createLeaderActionTools(context: LeaderToolContext): RuntimeTool[] {
  const assignmentParameters = (extra: Record<string, unknown> = {}) => ({
    type: "object",
    properties: {
      candidateId: { type: "string" },
      reason: { type: "string", maxLength: LEADER_REASON_MAX_CHARS },
      ...extra,
    },
    required: ["candidateId", "reason"],
    additionalProperties: false,
  });
  const assignable = context.candidates
    .filter((candidate) => ["dispatch", "rework"].includes(candidate.kind))
    .map((candidate) => candidate.id);
  const verifiable = context.candidates
    .filter((candidate) => candidate.kind === "verify")
    .map((candidate) => candidate.id);
  const replannable = context.candidates
    .filter((candidate) => candidate.kind === "replan")
    .map((candidate) => candidate.id);
  const reviewerCandidates = context.candidates
    .filter((candidate) => candidate.kind === "add_reviewer")
    .map((candidate) => candidate.id);
  const tools: RuntimeTool[] = [];
  if (assignable.length)
    tools.push(
      actionTool(
        context,
        "workflow_dispatch",
        "把已就绪节点派给兼容参与者，或对阻塞节点安排返工补证据。必须引用 workflow_status 列出的候选编号。",
        "dispatch",
        assignmentParameters({
          candidateId: { type: "string", enum: assignable },
          instruction: { type: "string", maxLength: LEADER_INSTRUCTION_MAX_CHARS },
        }),
        (args) => ({
          action: (args.candidateId as string).startsWith("rework:") ? "rework" : "dispatch",
          candidateId: textArg(args, "candidateId", 200) as string,
          reason: textArg(args, "reason", LEADER_REASON_MAX_CHARS) as string,
          instruction: textArg(args, "instruction", LEADER_INSTRUCTION_MAX_CHARS, false),
        }),
      ),
    );
  if (verifiable.length)
    tools.push(
      actionTool(
        context,
        "workflow_verify",
        "在当前代码版本上运行一条已配置的验证命令。程序仍负责目录占用与版本核对。",
        "verify",
        {
          type: "object",
          properties: {
            candidateId: { type: "string", enum: verifiable },
            reason: { type: "string", maxLength: LEADER_REASON_MAX_CHARS },
          },
          required: ["candidateId", "reason"],
          additionalProperties: false,
        },
        (args) => ({
          action: "verify",
          candidateId: textArg(args, "candidateId", 200) as string,
          reason: textArg(args, "reason", LEADER_REASON_MAX_CHARS) as string,
        }),
      ),
    );
  if (replannable.length)
    tools.push(
      actionTool(
        context,
        "workflow_replan",
        "结构不适用时按缺失证据重规划；不扩展用户授权，也不改换模板。",
        "replan",
        {
          type: "object",
          properties: {
            candidateId: { type: "string", enum: replannable },
            reason: { type: "string", maxLength: LEADER_REASON_MAX_CHARS },
          },
          required: ["candidateId", "reason"],
          additionalProperties: false,
        },
        (args) => ({
          action: "replan",
          candidateId: textArg(args, "candidateId", 200) as string,
          reason: textArg(args, "reason", LEADER_REASON_MAX_CHARS) as string,
        }),
      ),
    );
  if (reviewerCandidates.length)
    tools.push(
      actionTool(
        context,
        "workflow_add_reviewer",
        "为缺少兼容独立评审者的节点增加评审参与者；不能替换固定评审者，也不能由实现者自证。",
        "add_reviewer",
        {
          type: "object",
          properties: {
            candidateId: { type: "string", enum: reviewerCandidates },
            reason: { type: "string", maxLength: LEADER_REASON_MAX_CHARS },
          },
          required: ["candidateId", "reason"],
          additionalProperties: false,
        },
        (args) => ({
          action: "add_reviewer",
          candidateId: textArg(args, "candidateId", 200) as string,
          reason: textArg(args, "reason", LEADER_REASON_MAX_CHARS) as string,
        }),
      ),
    );
  if (context.candidates.some((candidate) => candidate.id.startsWith(USER_CANDIDATE_PREFIX)))
    tools.push(
      actionTool(
        context,
        "workflow_wait",
        "只在确实缺少用户决定、权限或必需信息时，登记一个由程序核验的用户问题并暂停；不要用它回避常规返工。",
        "wait",
        {
          type: "object",
          properties: {
            reason: { type: "string", maxLength: LEADER_REASON_MAX_CHARS },
          },
          required: ["reason"],
          additionalProperties: false,
        },
        (args) => ({
          action: "wait",
          candidateId: "",
          reason: textArg(args, "reason", LEADER_REASON_MAX_CHARS) as string,
        }),
      ),
    );
  if (context.candidates.some((candidate) => candidate.id === DELIVER_CANDIDATE_ID))
    tools.push(
      actionTool(
        context,
        "workflow_deliver",
        "报告合同与独立评审均已满足时，把完整报告交给用户验收。交付不等于完成或关闭任务。",
        "deliver",
        {
          type: "object",
          properties: {
            reason: { type: "string", maxLength: LEADER_REASON_MAX_CHARS },
          },
          required: ["reason"],
          additionalProperties: false,
        },
        (args) => ({
          action: "deliver",
          candidateId: DELIVER_CANDIDATE_ID,
          reason: textArg(args, "reason", LEADER_REASON_MAX_CHARS) as string,
        }),
      ),
    );
  return tools;
}

/** Full Leader surface: bounded reads plus the actions the program currently authorizes. */
export function createLeaderTools(context: LeaderToolContext): RuntimeTool[] {
  return [...createLeaderReadTools(context), ...createLeaderActionTools(context)];
}

export function leaderActionNames(): string[] {
  return [
    "workflow_status",
    "workflow_board",
    "workflow_detail",
    "workflow_dispatch",
    "workflow_verify",
    "workflow_replan",
    "workflow_add_reviewer",
    "workflow_wait",
    "workflow_deliver",
  ];
}

/** Only for diagnostics: never let a Leader tool error escape as a raw provider body. */
export function leaderToolError(error: unknown): { code: string; message: string } {
  const safe = safeError(error);
  return { code: safe.code, message: safe.message };
}

export function workflowStateOf(store: Store, taskId: string): WorkflowState | undefined {
  return store.get<WorkflowState>(WORKFLOWS, taskId);
}
