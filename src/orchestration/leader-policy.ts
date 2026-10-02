import { fail, OperationError } from "../core/errors.js";
import { now, stableId } from "../core/ids.js";
import type { ActorContext, Participant, Task } from "../core/types.js";
import { verificationConfigRevision as verificationRevision } from "../projects/verification-config.js";
import type { ConversationEngine } from "../runtime/types.js";
import type { Store } from "../storage/store.js";
import type { WorkflowCandidate } from "./candidates.js";
import type { OrchestrationEvent } from "./contracts.js";
import {
  type DecisionLog,
  decisionSnapshotRef,
  LEADER_SELECTION_POLICY_VERSION,
  saveDecisionLog,
} from "./decision-log.js";
import { skippedJev } from "./jev.js";
import { buildLeaderSchedulingPrompt, LEADER_SCHEDULING_RULES } from "./leader-prompt.js";
import { runTaskLeader } from "./leader-session.js";
import { leaderSessionId } from "./leader-session-types.js";
import {
  createLeaderTools,
  type LeaderActionRequest,
  type LeaderToolContext,
} from "./leader-tools.js";
import { selectWorkflowCandidate, type WorkflowSelection } from "./policy.js";
import { reportContract } from "./report.js";
import type { WorkflowPorts } from "./runner.js";
import { recentConversation, recoveryContext } from "./selection-context.js";
import type { WorkflowState } from "./workflow.js";

export type { LeaderActionKind, LeaderActionRequest } from "./leader-tools.js";

/** Durable record of the single scheduling action a Leader activation committed. */
export const WORKFLOW_LEADER_ACTIONS = "workflow_leader_actions";

export interface LeaderActionRecord {
  version: 1;
  id: string;
  taskId: string;
  ownerId: string;
  sessionId: string;
  eventId: string;
  revision: string;
  planVersion: number;
  artifactRevision: string;
  state: "requested" | "committed" | "failed";
  request: LeaderActionRequest;
  candidate: WorkflowCandidate;
  /** Bounded Leader prose kept for audit only; never authority to execute. */
  resultText?: string;
  error?: { code: string; message: string; outcome: string };
  createdAt: string;
  updatedAt: string;
}

export function leaderActionId(eventId: string, revision: string): string {
  return `wla_${stableId(eventId, revision)}`;
}

/** Committed or in-flight action for exactly this event+revision; never another revision. */
export function loadLeaderAction(
  store: Store,
  eventId: string,
  revision: string,
): LeaderActionRecord | undefined {
  const record = store.get<LeaderActionRecord>(
    WORKFLOW_LEADER_ACTIONS,
    leaderActionId(eventId, revision),
  );
  return record && record.revision === revision ? record : undefined;
}

export interface LeaderSchedulingInput {
  store: Store;
  engine: ConversationEngine;
  actor: ActorContext;
  task: Task;
  state: WorkflowState;
  eventId: string;
  revision: string;
  planVersion: number;
  templateVersion: number | string;
  artifactRevision: string;
  candidates: WorkflowCandidate[];
  participants: Participant[];
  commands: string[];
  reportMissing: string[];
  configRevision?: string;
  boardDirectory?: string;
  /** Full user requirement text and later revisions, already bounded by the caller. */
  userMessages: string[];
  recentConversation?: unknown;
  recoveryMaterials?: unknown;
  priorDecisions?: Array<{ candidateId?: string; reason: string }>;
  signal?: AbortSignal;
  assertCurrent?(): void;
  /** Current user-revision hash; a change invalidates the in-flight activation. */
  currentRevision(): string;
  /**
   * Synchronous durable hand-off: the runner records the chosen candidate on the
   * orchestration event in the same store transaction as this action record,
   * before the Leader tool returns.
   */
  persistAction(action: LeaderActionRequest, candidate: WorkflowCandidate): void;
  piModel?: string;
  onLog?(log: DecisionLog): void | Promise<void>;
}

export interface LeaderSelectionOutcome {
  candidateId?: string;
  candidate?: WorkflowCandidate;
  action?: LeaderActionRequest;
  source?: "leader";
  reason: string;
  log: DecisionLog;
  deferred?: true;
}

function buildDecisionLog(
  input: LeaderSchedulingInput,
  snapshot: unknown,
  committed: { action: LeaderActionRequest; candidate: WorkflowCandidate } | undefined,
  reason: string,
  logId: string,
): DecisionLog {
  const createdAt = new Date().toISOString();
  return {
    version: 1,
    policyVersion: LEADER_SELECTION_POLICY_VERSION,
    eventId: logId,
    revision: input.revision,
    planVersion: input.planVersion,
    templateVersion: input.templateVersion,
    snapshotRef: decisionSnapshotRef(snapshot),
    snapshot,
    candidates: structuredClone(input.candidates),
    rule: { status: "not-applicable", reason: "leader_primary" },
    jev: skippedJev(undefined, "workflow_leader_primary"),
    pi: {
      status: committed ? "success" : "skipped",
      reason: committed ? "leader_committed" : "leader_deferred",
      ...(committed ? { candidateId: committed.candidate.id } : {}),
      sessionId: leaderSessionId(input.task.id),
      ...(input.piModel ? { model: input.piModel } : {}),
    },
    state: committed ? "selected" : "deferred",
    ...(committed
      ? {
          final: {
            source: "leader" as const,
            candidateId: committed.candidate.id,
            reason,
          },
        }
      : {}),
    dispatches: [],
    createdAt,
    updatedAt: createdAt,
  };
}

/** Bounded audit snapshot: identities and counts, never a second full transcript. */
export function leaderAuditSnapshot(input: LeaderSchedulingInput): unknown {
  const state = input.state;
  return {
    goal: input.task.requirements.slice(0, 2000),
    phase: state.phase,
    planVersion: input.planVersion,
    artifactRevision: input.artifactRevision,
    configRevision: input.configRevision,
    nodes: Object.fromEntries(
      Object.entries(state.nodes).map(([id, progress]) => [
        id,
        {
          status: progress.status,
          attempt: progress.attempt,
          participantId: progress.participantId,
        },
      ]),
    ),
    openIssues: state.issues
      .filter((issue) => issue.status === "open")
      .map((issue) => ({ id: issue.id, blocking: issue.blocking })),
    evidence: state.evidence.slice(-40).map((entry) => ({
      id: entry.id,
      source: entry.source,
      result: entry.result,
    })),
    reportMissing: input.reportMissing,
    participants: input.participants.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      status: entry.status,
    })),
    candidates: input.candidates.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      description: candidate.description.slice(0, 400),
    })),
  };
}

async function commitAction(
  input: LeaderSchedulingInput,
  recordId: string,
  action: LeaderActionRequest,
  candidate: WorkflowCandidate,
): Promise<void> {
  input.assertCurrent?.();
  if (input.currentRevision() !== input.revision)
    fail("orchestration_superseded", "用户要求已变化，本轮调度动作已作废。");
  const at = now();
  const record: LeaderActionRecord = {
    version: 1,
    id: recordId,
    taskId: input.task.id,
    ownerId: input.task.ownerId,
    sessionId: leaderSessionId(input.task.id),
    eventId: input.eventId,
    revision: input.revision,
    planVersion: input.planVersion,
    artifactRevision: input.artifactRevision,
    state: "requested",
    request: action,
    candidate: structuredClone(candidate),
    createdAt: at,
    updatedAt: at,
  };
  input.store.transaction(() => {
    input.store.set(WORKFLOW_LEADER_ACTIONS, recordId, record);
    // Persisting the event's candidate in the same transaction is what makes a
    // restart resume the same action instead of asking the model again.
    input.persistAction(action, candidate);
  });
}

function finishRecord(
  input: LeaderSchedulingInput,
  recordId: string,
  fields: Partial<LeaderActionRecord>,
): void {
  const record = input.store.get<LeaderActionRecord>(WORKFLOW_LEADER_ACTIONS, recordId);
  if (!record) return;
  input.store.set(WORKFLOW_LEADER_ACTIONS, recordId, { ...record, ...fields, updatedAt: now() });
}

/**
 * One durable Leader activation for one orchestration event. The Leader reads
 * bounded status itself and commits at most one action through the machine
 * safety skeleton; recovery returns the same recorded action without a model call.
 */
export async function runLeaderScheduling(
  input: LeaderSchedulingInput,
  logId: string,
): Promise<LeaderSelectionOutcome> {
  const recordId = leaderActionId(input.eventId, input.revision);
  const snapshot = leaderAuditSnapshot(input);
  const existing = input.store.get<LeaderActionRecord>(WORKFLOW_LEADER_ACTIONS, recordId);
  if (existing && existing.revision === input.revision && existing.state !== "failed") {
    // The action was already committed for this event+revision. Recovery
    // returns the recorded decision and never calls the engine again.
    const candidate =
      input.candidates.find((entry) => entry.id === existing.candidate.id) ?? existing.candidate;
    const log = buildDecisionLog(
      input,
      snapshot,
      { action: existing.request, candidate },
      existing.request.reason,
      logId,
    );
    return {
      candidateId: candidate.id,
      candidate,
      action: existing.request,
      source: "leader",
      reason: existing.request.reason,
      log,
    };
  }
  let committed: { action: LeaderActionRequest; candidate: WorkflowCandidate } | undefined;
  let prose = "";
  const context: LeaderToolContext = {
    store: input.store,
    task: input.task,
    state: input.state,
    eventId: input.eventId,
    userRevision: input.revision,
    artifactRevision: input.artifactRevision,
    planVersion: input.planVersion,
    candidates: input.candidates,
    participants: input.participants,
    commands: input.commands,
    reportMissing: input.reportMissing,
    configRevision: input.configRevision,
    boardDirectory: input.boardDirectory,
    revision: () => input.currentRevision(),
    assertCurrent: () => {
      input.assertCurrent?.();
    },
    commit: async (action) => {
      if (committed) {
        if (committed.action.candidateId === action.candidateId) return;
        fail("workflow_leader_conflict", "本轮已经提交了一个调度动作，不能在同一激活内再改选。");
      }
      const record = input.store.get<LeaderActionRecord>(WORKFLOW_LEADER_ACTIONS, recordId);
      if (record && record.state !== "failed") {
        if (record.request.candidateId === action.candidateId) {
          const candidate =
            input.candidates.find((entry) => entry.id === record.candidate.id) ?? record.candidate;
          committed = { action: record.request, candidate };
          return;
        }
        fail("workflow_leader_conflict", "该事件已有已提交的调度动作，不能覆盖。");
      }
      const candidate = input.candidates.find((entry) => entry.id === action.candidateId);
      if (!candidate) fail("workflow_selection", "调度动作不属于本轮合法候选。");
      await commitAction(input, recordId, action, candidate);
      committed = { action, candidate };
    },
  };
  const prompt = buildLeaderSchedulingPrompt({
    task: input.task,
    state: input.state,
    userMessages: input.userMessages,
    artifactRevision: input.artifactRevision,
    configRevision: input.configRevision,
    planVersion: input.planVersion,
    candidates: input.candidates,
    commands: input.commands,
    reportMissing: input.reportMissing,
    participants: input.participants,
    recentConversation: input.recentConversation,
    recoveryMaterials: input.recoveryMaterials,
    priorDecisions: input.priorDecisions,
  });
  // Mandatory user constraints must reach the model whole. If the complete
  // activation cannot fit the engine budget, stop with a typed context error
  // instead of paging a hard constraint out of the request.
  if (Number.isFinite(input.engine.contextTokens)) {
    const budget = Math.max(0, input.engine.contextTokens - 6000);
    if (Math.ceil(Buffer.byteLength(prompt.text, "utf8") / 3) > budget)
      throw new OperationError(
        "context_budget",
        "任务要求与修订超出当前模型容量；本轮未提交任何调度动作，请缩减要求或提高上下文容量后重试。",
        "not_executed",
      );
  }
  try {
    const result = await runTaskLeader({
      store: input.store,
      engine: input.engine,
      actor: {
        ...input.actor,
        ownerId: input.task.ownerId,
        taskId: input.task.id,
        sessionId: leaderSessionId(input.task.id),
      },
      eventId: input.eventId,
      revision: input.revision,
      systemPrompt: LEADER_SCHEDULING_RULES,
      prompt: prompt.text,
      tools: createLeaderTools(context),
      ...(input.signal ? { signal: input.signal } : {}),
      assertCurrent: () => {
        input.assertCurrent?.();
      },
    });
    prose = (result.text ?? "").slice(0, 4000);
  } catch (error) {
    // A committed action survives an engine failure: the runner resumes it from
    // the event, so the durable record keeps its committed state.
    if (committed) finishRecord(input, recordId, { state: "committed", resultText: prose });
    throw error;
  }
  if (!committed) {
    const record = input.store.get<LeaderActionRecord>(WORKFLOW_LEADER_ACTIONS, recordId);
    if (record && record.state !== "failed") {
      const candidate =
        input.candidates.find((entry) => entry.id === record.candidate.id) ?? record.candidate;
      committed = { action: record.request, candidate };
    }
  }
  const reason = committed?.action.reason || "leader_without_action";
  const log = buildDecisionLog(input, snapshot, committed, reason, logId);
  // Decision evidence is immutable once selected: a recovered activation keeps
  // the original record instead of rewriting it with a newer snapshot.
  const recorded = input.store.get<DecisionLog>("workflow_decisions", logId);
  if (!recorded || recorded.state !== "selected") await input.onLog?.(structuredClone(log));
  if (!committed) {
    finishRecord(input, recordId, { resultText: prose });
    return { deferred: true as const, reason, log };
  }
  finishRecord(input, recordId, { state: "committed", resultText: prose });
  return {
    candidateId: committed.candidate.id,
    candidate: committed.candidate,
    action: committed.action,
    source: "leader",
    reason,
    log,
  };
}

/** Persist a final decision log once; the Leader path keeps its own audit trail. */
export function persistLeaderDecisionLog(store: Store, log: DecisionLog): void {
  saveDecisionLog(store, log);
}

/** Bounded identities of earlier scheduling actions; never a second transcript. */
export function leaderPriorDecisions(
  events: readonly OrchestrationEvent[],
): Array<{ candidateId?: string; reason: string }> {
  return events
    .filter((entry) => entry.decision)
    .slice(-8)
    .map((entry) => ({
      candidateId: entry.decision?.candidateId,
      reason: (entry.decision?.reason ?? "").slice(0, 600),
    }));
}

/** The exact snapshot shape the frozen v2 chooser always recorded. */
function legacySnapshot(input: {
  store: Store;
  task: Task;
  state: WorkflowState;
  artifactRevision: string;
  commands: string[];
  configRevision?: string;
  reportMissing: string[];
  userMessages: string[];
}): unknown {
  return {
    goal: input.state.plan.goal,
    artifactRevision: input.artifactRevision,
    userConstraints: input.userMessages,
    phase: input.state.phase,
    issues: input.state.issues,
    nodes: input.state.nodes,
    evidence: input.state.evidence,
    reportMissing: input.reportMissing,
  };
}

/**
 * Assemble the one durable Leader activation for a ready workflow event. The
 * runner only supplies task facts; identity, legacy protocol selection and the
 * bounded read materials are derived here.
 */
export async function runWorkflowLeaderStepFor(input: {
  ports: WorkflowPorts;
  actor: ActorContext;
  task: Task;
  state: WorkflowState;
  event: OrchestrationEvent;
  candidates: WorkflowCandidate[];
  participants: Participant[];
  artifactRevision: string;
  repair?: { candidateId: string; reason: string };
}): Promise<LeaderSelectionOutcome | WorkflowSelection> {
  const { ports, task, state, event } = input;
  const commands =
    ports.store.get<WorkflowState>("task_workflows", task.id)?.plan.validation?.mode === "not_run"
      ? []
      : task.kind !== "discussion" && task.project && ports.projects
        ? (ports.projects.get(task.project).verify ?? [])
        : [];
  const configRevision =
    task.project && ports.projects
      ? verificationRevision(ports.projects.get(task.project))
      : undefined;
  const recent = recentConversation(ports, task, state);
  const recovery = recoveryContext(ports, task, state);
  return runWorkflowLeaderStep({
    store: ports.store,
    engine: ports.engine,
    actor: input.actor,
    task,
    state,
    event,
    candidates: input.candidates,
    participants: input.participants,
    commands,
    reportMissing: reportContract(state, input.artifactRevision, commands, configRevision),
    configRevision,
    artifactRevision: input.artifactRevision,
    userMessages: ports.userMessages(task).map((entry) => entry.text),
    recentConversation: recent,
    recoveryMaterials: recovery,
    priorDecisions: leaderPriorDecisions(ports.events(task.id)),
    signal: ports.signal,
    revision: () => ports.revision(task),
    assertCurrent: () => {
      ports.assertCurrent(event);
    },
    save: (current) => ports.save(current),
    // Hard deterministic safety repair (a known protocol fault with exactly
    // one legal repair) stays a rule decision and never waits on a model; all
    // ordinary v3 scheduling goes through the durable Leader.
    ...(task.promptVersion === 3 && !input.repair
      ? {}
      : {
          legacy: true,
          ...(input.repair ? { legacyRule: input.repair } : {}),
          legacyExtras: { recentConversation: recent, recoveryMaterials: recovery },
        }),
    model: ports.config?.ai.model,
  });
}

/**
 * Runner-facing step: one durable Leader activation for one orchestration
 * event. The committed action is written onto the event inside the same store
 * transaction, so a restart resumes it instead of asking the Leader again.
 */
export async function runWorkflowLeaderStep(input: {
  store: Store;
  engine: ConversationEngine;
  actor: ActorContext;
  task: Task;
  state: WorkflowState;
  event: OrchestrationEvent;
  candidates: WorkflowCandidate[];
  participants: Participant[];
  commands: string[];
  reportMissing: string[];
  configRevision?: string;
  artifactRevision: string;
  userMessages: string[];
  recentConversation?: unknown;
  recoveryMaterials?: unknown;
  priorDecisions?: Array<{ candidateId?: string; reason: string }>;
  signal?: AbortSignal;
  revision(): string;
  assertCurrent(): void;
  save(event: OrchestrationEvent): void;
  /** Legacy v2 workflow tasks keep their frozen restricted-chooser protocol. */
  legacy?: boolean;
  legacyRule?: { candidateId: string; reason: string };
  /** Legacy protocol also recorded the recent conversation/recovery projection. */
  legacyExtras?: { recentConversation?: unknown; recoveryMaterials?: unknown };
  model?: string;
}): Promise<LeaderSelectionOutcome | WorkflowSelection> {
  const { event, state } = input;
  if (input.legacy)
    // Only the persisted v2 protocol takes this path; it records the same
    // immutable DecisionLog shape it always did.
    return selectWorkflowCandidate({
      eventId: event.selectionLogId ?? event.id,
      revision: event.userRevision,
      planVersion: state.plan.version,
      templateVersion: state.plan.templateVersion,
      snapshot: {
        ...(legacySnapshot(input) as Record<string, unknown>),
        recentConversation: input.legacyExtras?.recentConversation,
        recoveryMaterials: input.legacyExtras?.recoveryMaterials,
      },
      candidates: input.candidates,
      ...(input.legacyRule ? { rule: input.legacyRule } : {}),
      piModel: input.model,
      engine: input.engine,
      actor: input.actor,
      signal: input.signal,
      assertCurrent: input.assertCurrent,
      onLog: (log) => persistLeaderDecisionLog(input.store, log),
    });
  const persist = (action: LeaderActionRequest, candidate: WorkflowCandidate) => {
    const existing = event.workflow;
    if (existing && existing.candidate.id !== candidate.id)
      fail("workflow_selection", "该事件已提交另一个调度动作，不能覆盖。");
    event.workflow = {
      candidate: { ...candidate, description: action.reason || candidate.description },
      planVersion: state.plan.version,
      artifactRevision: input.artifactRevision,
    };
    event.decision = {
      action:
        candidate.kind === "deliver" ? "deliver" : candidate.kind === "user" ? "wait" : "continue",
      reason: candidate.kind === "user" ? candidate.description : action.reason,
      candidateId: candidate.id,
      source: "leader",
      ...(candidate.kind === "deliver"
        ? { reportId: state.report?.id, outputId: state.report?.outputId }
        : {}),
    };
    input.save(event);
  };
  return runLeaderScheduling(
    {
      store: input.store,
      engine: input.engine,
      actor: input.actor,
      task: input.task,
      state,
      eventId: event.id,
      revision: event.userRevision,
      planVersion: state.plan.version,
      templateVersion: state.plan.templateVersion,
      artifactRevision: input.artifactRevision,
      candidates: input.candidates,
      participants: input.participants,
      commands: input.commands,
      reportMissing: input.reportMissing,
      configRevision: input.configRevision,
      boardDirectory: input.task.boardDirectory,
      userMessages: input.userMessages,
      recentConversation: input.recentConversation,
      recoveryMaterials: input.recoveryMaterials,
      priorDecisions: input.priorDecisions,
      signal: input.signal,
      assertCurrent: input.assertCurrent,
      currentRevision: input.revision,
      persistAction: persist,
      piModel: input.model,
      onLog: (log) => persistLeaderDecisionLog(input.store, log),
    },
    // Decision evidence keeps the same audit key the frozen chooser used, so
    // dispatch linking and immutability checks still find it.
    event.selectionLogId ?? event.id,
  );
}
