import { now, stableId } from "../core/ids.js";
import type {
  AgentReadiness,
  AgentSnapshot,
  ExecutionRef,
  Participant,
  ReadinessState,
  Task,
} from "../core/types.js";
import { directoryTrustKeys, trustKeys } from "../herdr/screen.js";
import type { Store } from "../storage/store.js";
import { executorHeld } from "./pause.js";
import type { TaskRecords } from "./records.js";

/**
 * A fresh readback of one managed execution. `absent` is a definite
 * `agent_not_found`/`pane_not_found`; `unreadable` covers timeouts and any
 * other read failure, which is explicitly NOT authority to respawn.
 */
export type ExecutionObservation =
  | { kind: "snapshot"; agent: AgentSnapshot }
  | { kind: "absent"; code: string }
  | { kind: "unreadable"; code: string };

export interface ReadinessOptions {
  /** Visible native screen for the same readback, when already available. */
  screenText?: string;
  /** Verified worktree root, used only to recognize the exact Codex notice. */
  worktreeRoot?: string;
  /** True when this execution generation has an unresolved startup trust effect. */
  startupTrustUnresolved?: boolean;
}

/** Durable identity of the current managed execution generation. */
export function executionGeneration(participant: Participant): string {
  return participant.executionRecovery ?? "initial";
}

/**
 * Legacy projection for records written before readiness was durable. It states
 * only what the historical fields already prove and never upgrades a blocked or
 * unstarted execution to `ready`.
 */
export function derivedReadiness(participant: Participant): ReadinessState {
  return {
    phase: legacyPhase(participant),
    reason: "历史记录推导；未保存当时的就绪观察。",
    generation: executionGeneration(participant),
    paneId: participant.execution?.paneId,
    workspaceId: participant.execution?.workspaceId,
    at: participant.updatedAt,
  };
}

function legacyPhase(participant: Participant): AgentReadiness {
  if (participant.status === "removed") return "removed";
  if (!participant.execution) return "unallocated";
  if (!participant.started) return "provisioning";
  if (participant.status === "blocked") return "awaiting_manual";
  if (participant.status === "working") return "busy";
  if (participant.status === "idle" || participant.status === "done") return "ready";
  if (participant.status === "gone") return "missing";
  return "uncertain";
}

export interface ReadinessInput {
  status: string;
  started: boolean;
  execution?: ExecutionRef;
  executionRecovery?: string;
  readiness?: ReadinessState;
  updatedAt?: string;
}

export function readinessOf(participant: ReadinessInput): ReadinessState {
  // A definite terminal status recorded on the current participant record beats
  // any older durable snapshot: a removed or missing executor is not ready, and
  // a stale "ready" observation must never be reported as the current phase.
  if (
    participant.status === "removed" ||
    (participant.status === "gone" && participant.readiness?.phase !== "stopped")
  )
    return derivedReadiness({
      status: participant.status as Participant["status"],
      started: participant.started,
      execution: participant.execution,
      executionRecovery: participant.executionRecovery,
      updatedAt: participant.updatedAt ?? "",
    } as Participant);
  const stored = participant.readiness;
  if (
    stored &&
    (stored.generation !== (participant.executionRecovery ?? "initial") ||
      stored.paneId !== participant.execution?.paneId ||
      stored.workspaceId !== participant.execution?.workspaceId)
  )
    return {
      ...derivedReadiness(participant as Participant),
      phase: "uncertain",
      reason: "旧就绪观察不属于当前执行代，等待现场核验。",
    };
  return (
    participant.readiness ??
    derivedReadiness({
      status: participant.status as Participant["status"],
      started: participant.started,
      execution: participant.execution,
      executionRecovery: participant.executionRecovery,
      updatedAt: participant.updatedAt ?? "",
    } as Participant)
  );
}

/**
 * Pure classifier used by every route that observes a native snapshot. Callers
 * that already have a visible screen pass it; when they do not, a blocked menu
 * is classified as `awaiting_manual` (never as trust), which is the
 * conservative reading. The `stateSeq` is carried so observers can tell a new
 * menu from the one a decision already addressed.
 */
export function classifyAgent(
  participant: Pick<Participant, "kind" | "started" | "status" | "execution">,
  agent: AgentSnapshot,
  options: { screenText?: string; worktreeRoot?: string } = {},
): ReadinessState {
  const ref = participant.execution;
  const state = (value: AgentReadiness, reason: string): ReadinessState => ({
    phase: value,
    reason,
    generation: "initial",
    paneId: ref?.paneId,
    workspaceId: ref?.workspaceId,
    terminalId: agent.terminalId,
    sessionId: agent.sessionId,
    stateSeq: agent.stateSeq,
    at: now(),
  });
  if (agent.status === "working") return state("busy", "执行器正在工作。");
  if (agent.status === "blocked") {
    const trust =
      options.screenText !== undefined &&
      (directoryTrustKeys(participant.kind, options.screenText, agent.cwd, options.worktreeRoot) ||
        (participant.kind === "codex" && trustKeys(options.screenText)));
    return trust
      ? state("awaiting_trust", "等待原生启动目录信任确认。")
      : state("awaiting_manual", "原生菜单等待用户或已授权确认，不是就绪。");
  }
  if (agent.status === "gone") return state("missing", "原生执行现场已不存在。");
  if (agent.status === "unknown") return state("uncertain", "原生状态未知，不能视为就绪。");
  if (agent.launchPending || !agent.interactiveReady)
    return state("starting", "原生执行器尚未进入可接收输入状态。");
  if (agent.status === "idle" || agent.status === "done")
    return state("ready", "原生执行器已就绪，可接收输入。");
  return state("uncertain", "原生状态无法归类，不能视为就绪。");
}

function phase(
  store: Store,
  _task: Task,
  participant: Participant,
  observation: ExecutionObservation,
  options: ReadinessOptions,
): ReadinessState {
  const generation = executionGeneration(participant);
  const ref = participant.execution;
  const base = {
    generation,
    paneId: ref?.paneId,
    workspaceId: ref?.workspaceId,
    terminalId: observation.kind === "snapshot" ? observation.agent.terminalId : undefined,
    sessionId: observation.kind === "snapshot" ? observation.agent.sessionId : undefined,
    at: now(),
  };
  const state = (value: AgentReadiness, reason: string, stateSeq?: string): ReadinessState => ({
    ...base,
    ...(stateSeq ? { stateSeq } : {}),
    phase: value,
    reason,
  });
  if (participant.status === "removed") return state("removed", "参与者已被用户移除。");
  if (!ref) return state("unallocated", "尚未分配执行现场。");
  if (executorHeld(store, participant.id)) return state("stopped", "执行器已被用户明确停止。");
  if (observation.kind === "absent")
    return state("missing", `原生执行目标不存在（${observation.code}）。`);
  if (observation.kind === "unreadable")
    return state("uncertain", `执行现场读取未确认（${observation.code}），不能据此重建。`);
  const agent = observation.agent;
  if (
    agent.paneId !== ref.paneId ||
    agent.workspaceId !== ref.workspaceId ||
    agent.kind !== ref.kind
  )
    return state("uncertain", "观察到的执行身份与记录不一致，已停止调度。");
  if (options.startupTrustUnresolved || startupTrustStatus(store, participant).frozen)
    return state("awaiting_trust", "启动目录信任结果尚未确认，不能视为就绪。", agent.stateSeq);
  if (!participant.started)
    return state("starting", "已分配执行现场，尚未确认启动。", agent.stateSeq);
  const trust =
    options.screenText !== undefined &&
    (directoryTrustKeys(participant.kind, options.screenText, ref.cwd, options.worktreeRoot) ||
      (participant.kind === "codex" && trustKeys(options.screenText)));
  if (agent.status === "blocked")
    return state(
      trust ? "awaiting_trust" : "awaiting_manual",
      trust ? "等待原生启动目录信任确认。" : "原生菜单等待用户或已授权确认，不是就绪。",
      agent.stateSeq,
    );
  if (agent.status === "working") return state("busy", "执行器正在工作。", agent.stateSeq);
  if (agent.status === "gone") return state("missing", "原生执行现场已不存在。", agent.stateSeq);
  if (agent.status === "unknown")
    return state("uncertain", "原生状态未知，不能视为就绪。", agent.stateSeq);
  if (agent.launchPending || !agent.interactiveReady)
    return state("starting", "原生执行器尚未进入可接收输入状态。", agent.stateSeq);
  if (agent.status === "idle" || agent.status === "done")
    return state("ready", "原生执行器已就绪，可接收输入。", agent.stateSeq);
  return state("uncertain", "原生状态无法归类，不能视为就绪。", agent.stateSeq);
}

/** The only phases from which a fresh business input may be written. */
export function inputReady(state: ReadinessState): boolean {
  return state.phase === "ready";
}

function sameState(left: ReadinessState | undefined, right: ReadinessState): boolean {
  return (
    left !== undefined &&
    left.phase === right.phase &&
    left.generation === right.generation &&
    left.paneId === right.paneId &&
    left.workspaceId === right.workspaceId &&
    left.terminalId === right.terminalId &&
    left.sessionId === right.sessionId &&
    left.reason === right.reason &&
    left.stateSeq === right.stateSeq
  );
}

/**
 * Recompute and durably record readiness. Returns the new observation; callers
 * must not treat the return as permission to send business input without also
 * checking the current business pause.
 */
export function reconcileReadiness(
  store: Store,
  records: Pick<TaskRecords, "saveParticipant">,
  task: Task,
  participant: Participant,
  observation: ExecutionObservation,
  options: ReadinessOptions = {},
): ReadinessState {
  const next = phase(store, task, participant, observation, options);
  if (task.participantIds.includes(participant.id) && !sameState(participant.readiness, next)) {
    participant.readiness = next;
    records.saveParticipant(participant);
  } else {
    participant.readiness = next;
  }
  return next;
}

/** Stable diagnostic text for a participant that is not yet input-ready. */
export function readinessDiagnostic(state: ReadinessState): string {
  if (state.phase === "awaiting_trust")
    return "执行器已重建，等待启动目录信任确认；旧输入不会自动重发。";
  if (state.phase === "awaiting_manual")
    return "执行器已重建，原生菜单等待处理；旧输入不会自动重发。";
  if (state.phase === "starting") return "执行器已重建，仍在启动；旧输入不会自动重发。";
  if (state.phase === "missing") return "执行现场已丢失；正在重建执行器，旧输入不会自动重发。";
  if (state.phase === "uncertain") return "执行现场尚未确认；不会自动重发旧输入。";
  return "执行器已自动重建；旧输入和未知回执保留，请核对历史后发送新的安排。";
}

const recoveryDiagnostics = new Set([
  "执行现场已丢失；正在重建执行器，旧输入不会自动重发。",
  "执行器已自动重建；旧输入和未知回执保留，请核对历史后发送新的安排。",
  "执行器已重建，等待启动目录信任确认；旧输入不会自动重发。",
  "执行器已重建，原生菜单等待处理；旧输入不会自动重发。",
  "执行器已重建，仍在启动；旧输入不会自动重发。",
  "执行现场尚未确认；不会自动重发旧输入。",
]);

/** Whether a task error is one of this module's own repair diagnostics. */
export function isRecoveryDiagnostic(text: string | undefined): boolean {
  return text !== undefined && recoveryDiagnostics.has(text);
}

/**
 * Whether a startup trust effect for the CURRENT generation is unresolved. A
 * definite new generation ignores receipts recorded before its replacement
 * boundary; the same generation can never auto-replay, including legacy
 * receipts and service restarts.
 */
export function generationBoundary(store: Store, participant: Participant): string | undefined {
  if (!participant.executionRecovery) return undefined;
  const recovery = store.get<{ at?: string; previous?: Participant }>(
    "execution_recoveries",
    participant.executionRecovery,
  );
  return (
    recovery?.at ??
    store.get<{ updatedAt?: string }>("operations", `${participant.executionRecovery}:workspace`)
      ?.updatedAt ??
    recovery?.previous?.updatedAt
  );
}

export function operationBelongsToGeneration(
  store: Store,
  participant: Participant,
  operationId: string,
): boolean {
  const effect = store.get<{ generation?: string }>("directory_trust_effects", operationId);
  if (effect?.generation !== undefined)
    return effect.generation === executionGeneration(participant);
  // Legacy receipt without an explicit generation: relevant only when it cannot
  // be proven to predate the current replacement boundary.
  const boundary = generationBoundary(store, participant);
  if (boundary === undefined) return true;
  const receipt = store.get<{ updatedAt?: string }>("operations", operationId);
  const at = receipt?.updatedAt;
  return at === undefined || at >= boundary;
}

export function trustEffectId(participant: Participant, stateSeq: string, scope?: string): string {
  return [
    startupTrustPrefix(participant.id),
    stableId("directory-trust-effect-v1", executionGeneration(participant), stateSeq),
    ...(scope ? [scope] : []),
  ].join(":");
}

/** Prefix shared by every startup-trust receipt of one participant, all generations. */
export function startupTrustPrefix(participantId: string): string {
  return `${participantId}:directory-trust`;
}

interface TrustEffect {
  participantId: string;
  generation: string;
  at: string;
}

/**
 * Whether a recorded startup-trust receipt belongs to the CURRENT execution
 * generation. A definitely new managed execution ignores receipts recorded
 * before its replacement boundary; the same generation keeps every receipt.
 */
function trustReceiptInGeneration(
  store: Store,
  participant: Participant,
  id: string,
  updatedAt?: string,
): boolean {
  const effect = store.get<TrustEffect>("directory_trust_effects", id);
  if (effect?.generation !== undefined)
    return effect.generation === executionGeneration(participant);
  const boundary = generationBoundary(store, participant);
  if (boundary === undefined) return true;
  return updatedAt === undefined || updatedAt >= boundary;
}

export interface StartupTrustStatus {
  /** A native write for this generation was attempted and its effect is unknown. */
  frozen: boolean;
  /** A native write for this generation already succeeded. */
  confirmed: boolean;
}

/**
 * Durable startup-trust coordination shared by the restricted directory-trust
 * route and the generic approval route. A same-generation pending/uncertain
 * write can never be auto-replayed or bypassed; a definitely new generation
 * starts clean while every old receipt stays for audit.
 */
export function startupTrustStatus(
  store: Store,
  participant: Participant,
  activeApprovalId?: string,
): StartupTrustStatus {
  const generation = executionGeneration(participant);
  let frozen = false;
  let confirmed = false;
  const record = (state: string | undefined) => {
    if (state === "done") confirmed = true;
    else if (state === "pending" || state === "uncertain") frozen = true;
  };
  // Effects recorded with an explicit generation are authoritative for that
  // generation, regardless of the receipt-id format.
  for (const [operationId, effect] of store.entries<TrustEffect>("directory_trust_effects")) {
    if (effect.participantId !== participant.id) continue;
    if (effect.generation !== generation) continue;
    record(store.get<{ state?: string }>("operations", operationId)?.state);
  }
  // Legacy receipts use the participant prefix and have no generation record.
  const prefix = startupTrustPrefix(participant.id);
  for (const [id, receipt] of store.entries<{
    state: string;
    updatedAt?: string;
    resolution?: { choice?: string };
  }>("operations")) {
    if (id !== prefix && !id.startsWith(`${prefix}:`)) continue;
    if (!trustReceiptInGeneration(store, participant, id, receipt.updatedAt)) continue;
    record(receipt.state);
  }
  // Pre-upgrade Jev could write the startup gate through generic approvals.
  // Its uncertain effect must fence the dedicated route too, not just vice versa.
  for (const decision of store.list<{
    id?: string;
    participantId: string;
    generation?: string;
    execution?: ExecutionRef;
    state: string;
  }>("automatic_approval_decisions")) {
    if (
      (!activeApprovalId || decision.id !== activeApprovalId) &&
      decision.participantId === participant.id &&
      (decision.generation === undefined || decision.generation === generation) &&
      decision.execution?.paneId === participant.execution?.paneId &&
      decision.execution?.workspaceId === participant.execution?.workspaceId &&
      ["executing", "uncertain"].includes(decision.state)
    )
      frozen = true;
  }
  return { frozen, confirmed };
}

/** Pin pre-upgrade receipts to the retiring execution, without rewriting any receipt. */
export function bindLegacyTrustEffects(store: Store, participant: Participant): void {
  const prefix = startupTrustPrefix(participant.id);
  for (const [id] of store.entries("operations")) {
    if ((id === prefix || id.startsWith(`${prefix}:`)) && !store.get("directory_trust_effects", id))
      recordTrustEffect(store, participant, id);
  }
}

/** Record the generation a startup-trust effect belongs to, before the write. */
export function recordTrustEffect(
  store: Store,
  participant: Participant,
  operationId: string,
): void {
  store.set<TrustEffect>("directory_trust_effects", operationId, {
    participantId: participant.id,
    generation: executionGeneration(participant),
    at: now(),
  });
}
