import { fail } from "../core/errors.js";
import type { ActorContext, Participant, Task } from "../core/types.js";
import type { ConversationEngine } from "../runtime/types.js";
import type { Store } from "../storage/store.js";
import type { WorkflowCandidate } from "./candidates.js";
import {
  type DecisionLog,
  decisionSnapshotRef,
  PI_SELECTION_POLICY_VERSION,
} from "./decision-log.js";
import { type ChoiceCandidate, type JevOptions, skippedJev } from "./jev.js";
import { type LeaderActionRequest, runLeaderScheduling } from "./leader-policy.js";
import { chooseWithPi, skippedPi } from "./pi-choice.js";
import type { WorkflowState } from "./workflow.js";

export interface WorkflowSelectionInput {
  eventId: string;
  revision: string;
  planVersion: string | number;
  templateVersion: string | number;
  snapshot: unknown;
  candidates: readonly ChoiceCandidate[];
  rule?: { candidateId: string; reason: string };
  /** Legacy caller compatibility only; workflow never invokes Jev. */
  jev?: JevOptions;
  engine: ConversationEngine;
  actor: ActorContext;
  piModel?: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onLog?: (log: DecisionLog) => void | Promise<void>;
  fetch?: typeof fetch;
  assistancePolicy?: "jev-requested";
}

export interface WorkflowSelection {
  candidateId?: string;
  source?: "rule" | "jev" | "pi" | "leader";
  reason: string;
  log: DecisionLog;
  deferred?: true;
}

/**
 * Durable Leader scheduling for one workflow event. The Leader reads bounded
 * task state with its own tools and commits at most one action; the machine
 * safety skeleton (valid candidate, revision, DAG, admission, review, receipt)
 * stays authoritative and the runner executes the committed action.
 */
/**
 * The durable Leader owns new (promptVersion 3) workflow scheduling. Tasks
 * created under the frozen v2 workflow protocol keep their original restricted
 * chooser so their persisted audit stays replayable and unchanged.
 */
export type WorkflowSchedulingMode = "leader" | "legacy";

export interface LeaderSelectionInput {
  store: Store;
  engine: ConversationEngine;
  actor: ActorContext;
  task: Task;
  state: WorkflowState;
  eventId: string;
  revision: string;
  planVersion: string | number;
  templateVersion: string | number;
  artifactRevision: string;
  candidates: readonly WorkflowCandidate[];
  participants: readonly Participant[];
  commands: readonly string[];
  reportMissing: readonly string[];
  configRevision?: string;
  boardDirectory?: string;
  userMessages: readonly string[];
  recentConversation?: unknown;
  recoveryMaterials?: unknown;
  priorDecisions?: Array<{ candidateId?: string; reason: string }>;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  currentRevision(): string;
  persistAction(action: LeaderActionRequest, candidate: WorkflowCandidate): void;
  piModel?: string;
  onLog?: (log: DecisionLog) => void | Promise<void>;
}

export async function selectWorkflowLeader(
  input: LeaderSelectionInput,
): Promise<WorkflowSelection> {
  const logId = input.eventId;
  const candidates = structuredClone([...input.candidates]);
  const ids = candidates.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length || candidates.some((candidate) => !candidate.id.trim()))
    fail("workflow_candidates", "工作流候选编号无效或重复。");
  const outcome = await runLeaderScheduling(
    {
      store: input.store,
      engine: input.engine,
      actor: input.actor,
      task: input.task,
      state: input.state,
      eventId: input.eventId,
      revision: input.revision,
      planVersion: Number(input.planVersion),
      templateVersion: input.templateVersion,
      artifactRevision: input.artifactRevision,
      candidates,
      participants: [...input.participants],
      commands: [...input.commands],
      reportMissing: [...input.reportMissing],
      configRevision: input.configRevision,
      boardDirectory: input.boardDirectory,
      userMessages: [...input.userMessages],
      recentConversation: input.recentConversation,
      recoveryMaterials: input.recoveryMaterials,
      priorDecisions: input.priorDecisions,
      signal: input.signal,
      assertCurrent: input.assertCurrent,
      currentRevision: input.currentRevision,
      persistAction: input.persistAction,
      piModel: input.piModel,
      onLog: input.onLog,
    },
    logId,
  );
  if (outcome.deferred)
    return { reason: outcome.reason, log: outcome.log, deferred: true as const };
  return {
    candidateId: outcome.candidateId,
    source: "leader",
    reason: outcome.reason,
    log: outcome.log,
  };
}

/** Rule → one restricted pi choice; never dispatches a participant itself. */
export async function selectWorkflowCandidate(
  input: WorkflowSelectionInput,
): Promise<WorkflowSelection> {
  const createdAt = new Date().toISOString();
  const candidates = structuredClone([...input.candidates]);
  const snapshot: unknown = JSON.parse(JSON.stringify(input.snapshot) ?? "null");
  const ids = candidates.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length || candidates.some((candidate) => !candidate.id.trim()))
    fail("workflow_candidates", "工作流候选编号无效或重复。");
  const rule =
    input.rule ??
    (candidates.length === 1
      ? { candidateId: candidates[0]?.id ?? "", reason: "sole_legal_candidate" }
      : undefined);
  const log: DecisionLog = {
    version: 1,
    policyVersion: PI_SELECTION_POLICY_VERSION,
    eventId: input.eventId,
    revision: input.revision,
    planVersion: input.planVersion,
    templateVersion: input.templateVersion,
    snapshotRef: decisionSnapshotRef(snapshot),
    snapshot,
    candidates,
    rule: rule
      ? { status: "selected", ...rule }
      : { status: "not-applicable", reason: "needs_choice" },
    jev: skippedJev(undefined, "workflow_pi_primary"),
    pi: skippedPi(rule ? "rule_selected" : "not_called"),
    state: "pending",
    dispatches: [],
    createdAt,
    updatedAt: createdAt,
  };
  const save = async () => {
    log.updatedAt = new Date().toISOString();
    await input.onLog?.(structuredClone(log));
  };
  const current = () => {
    if (input.signal?.aborted) fail("cancelled", "工作流选择已取消。");
    input.assertCurrent?.();
  };
  const finish = async (
    reason: string,
    final?: DecisionLog["final"],
  ): Promise<WorkflowSelection> => {
    if (final) {
      current();
      log.final = final;
      log.state = "selected";
    }
    await save();
    return {
      ...final,
      reason,
      log,
      ...(log.state === "deferred" ? { deferred: true as const } : {}),
    };
  };
  current();
  if (rule && !ids.includes(rule.candidateId)) fail("workflow_rule", "规则选择不属于合法候选。");
  await save();
  if (rule) return finish(rule.reason, { source: "rule", ...rule });
  if (!candidates.length) {
    log.pi = skippedPi("no_legal_candidates");
    log.state = "deferred";
    return finish("no_legal_candidates");
  }
  log.pi = {
    status: "pending",
    reason: "pi_primary_selection",
    sessionId: `workflow-selection:${input.eventId}`,
    ...(input.piModel ? { model: input.piModel } : {}),
  };
  await save();
  log.pi = await chooseWithPi({
    engine: input.engine,
    actor: input.actor,
    sessionId: `workflow-selection:${input.eventId}`,
    state: snapshot,
    candidates,
    instructions:
      "从同一组合法候选中选择下一步。缺少必须由用户或外部提供的证据时选择现有等待或用户候选；内部回执错误应定向修复，不得扩大权限。",
    signal: input.signal,
    assertCurrent: current,
  });
  if (log.pi.status === "cancelled") {
    log.state = "cancelled";
    return finish("cancelled");
  }
  current();
  if (log.pi.status === "success" && log.pi.candidateId && ids.includes(log.pi.candidateId))
    return finish("pi_accepted", {
      source: "pi",
      candidateId: log.pi.candidateId,
      reason: "pi_accepted",
    });
  // A failed choice never authorizes dispatch; the existing user-decision boundary handles deferral.
  log.state = "deferred";
  return finish(`pi_${log.pi.status}:${log.pi.reason}`);
}
