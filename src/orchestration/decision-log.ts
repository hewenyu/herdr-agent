import { canonical, stableId } from "../core/ids.js";
import type { Store } from "../storage/store.js";
import {
  ASSISTANCE_CANDIDATES,
  type AssistanceEvidence,
  REQUEST_PI_CANDIDATE,
} from "./assistance.js";
import type { ChoiceCandidate, JevResult } from "./jev.js";

export const PI_SELECTION_POLICY_VERSION = "workflow-selection-v4";
export const SELECTION_POLICY_VERSION = "workflow-selection-v1";
export const REQUESTED_ASSISTANCE_POLICY_VERSION = "workflow-selection-v2";
export const RECOVERY_ASSISTANCE_POLICY_VERSION = "workflow-selection-v3";
/** Durable task Leader scheduling. Frozen v1..v4 logs remain replayable unchanged. */
export const LEADER_SELECTION_POLICY_VERSION = "workflow-leader-selection-v1";

export interface DecisionLog {
  version: 1;
  policyVersion:
    | typeof PI_SELECTION_POLICY_VERSION
    | typeof SELECTION_POLICY_VERSION
    | typeof REQUESTED_ASSISTANCE_POLICY_VERSION
    | typeof RECOVERY_ASSISTANCE_POLICY_VERSION
    | typeof LEADER_SELECTION_POLICY_VERSION;
  eventId: string;
  revision: string;
  planVersion: string | number;
  templateVersion: string | number;
  snapshotRef: string;
  snapshot: unknown;
  candidates: ChoiceCandidate[];
  /** Includes selector controls; only candidates above can authorize a business choice. */
  selectorCandidates?: ChoiceCandidate[];
  assistance?: AssistanceEvidence;
  rule: { status: "selected" | "not-applicable"; reason: string; candidateId?: string };
  jev: JevResult;
  pi: {
    status: "skipped" | "pending" | "success" | "failed" | "invalid" | "error" | "cancelled";
    adapterVersion?: "workflow-pi-choice-v1";
    durationMs?: number;
    reason: string;
    candidateId?: string;
    rationale?: string;
    sessionId?: string;
    fallbackReason?: string;
    model?: string;
  };
  state: "pending" | "selected" | "deferred" | "failed" | "cancelled";
  final?: { source: "rule" | "jev" | "pi" | "leader"; candidateId: string; reason: string };
  dispatches: Array<{ operationId: string; state: string; receiptId?: string }>;
  createdAt: string;
  updatedAt: string;
}

export function decisionSnapshotRef(snapshot: unknown): string {
  return stableId(
    "workflow-snapshot-v1",
    canonical(JSON.parse(JSON.stringify(snapshot) ?? "null")),
  );
}

/** Saves policy evidence only; dispatch authority remains in the orchestration event. */
export function saveDecisionLog(store: Store, log: DecisionLog): void {
  const previous = store.get<DecisionLog>("workflow_decisions", log.eventId);
  if (
    previous &&
    (previous.revision !== log.revision ||
      previous.snapshotRef !== log.snapshotRef ||
      canonical(previous.candidates) !== canonical(log.candidates) ||
      canonical(previous.selectorCandidates) !== canonical(log.selectorCandidates) ||
      previous.policyVersion !== log.policyVersion ||
      (previous.state !== "pending" &&
        canonical({ ...previous, dispatches: [], updatedAt: "" }) !==
          canonical({ ...log, dispatches: [], updatedAt: "" })))
  )
    throw new Error("Workflow decision evidence is immutable after selection");
  store.set("workflow_decisions", log.eventId, log);
}

export function linkDecisionDispatches(
  store: Store,
  eventId: string,
  dispatches: DecisionLog["dispatches"],
): void {
  const log = store.get<DecisionLog>("workflow_decisions", eventId);
  if (!log) return;
  saveDecisionLog(store, { ...log, dispatches, updatedAt: new Date().toISOString() });
}

/** Pure offline inspection. It neither calls models nor interprets logs as permission to execute. */
export function replayDecision(log: DecisionLog): {
  valid: boolean;
  errors: string[];
  state: DecisionLog["state"];
  selection?: DecisionLog["final"];
  candidate?: ChoiceCandidate;
  rule: DecisionLog["rule"];
  jev: DecisionLog["jev"];
  pi: DecisionLog["pi"];
  assistance?: DecisionLog["assistance"];
  dispatches: DecisionLog["dispatches"];
} {
  const errors: string[] = [];
  if (
    log.version !== 1 ||
    ![
      PI_SELECTION_POLICY_VERSION,
      SELECTION_POLICY_VERSION,
      REQUESTED_ASSISTANCE_POLICY_VERSION,
      RECOVERY_ASSISTANCE_POLICY_VERSION,
      LEADER_SELECTION_POLICY_VERSION,
    ].includes(log.policyVersion)
  )
    errors.push("unsupported_version");
  if (log.snapshotRef !== decisionSnapshotRef(log.snapshot)) errors.push("snapshot_mismatch");
  const ids = log.candidates.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) errors.push("duplicate_candidates");
  const candidate = log.candidates.find((entry) => entry.id === log.final?.candidateId);
  if (log.state === "selected" && (!log.final || !candidate))
    errors.push("invalid_final_candidate");
  if (log.state !== "selected" && log.final) errors.push("unexpected_final_candidate");
  if (log.final?.source === "rule" && log.rule.candidateId !== log.final.candidateId)
    errors.push("rule_mismatch");
  if (
    log.final?.source === "jev" &&
    (log.jev.status !== "success" || log.jev.candidateId !== log.final.candidateId)
  )
    errors.push("jev_mismatch");
  if (
    log.final?.source === "pi" &&
    (log.pi.status !== "success" || log.pi.candidateId !== log.final.candidateId)
  )
    errors.push("pi_mismatch");
  if (
    log.final?.source === "leader" &&
    (log.pi.status !== "success" || log.pi.candidateId !== log.final.candidateId)
  )
    errors.push("leader_mismatch");
  const requestedAssistance =
    log.policyVersion === REQUESTED_ASSISTANCE_POLICY_VERSION ||
    log.policyVersion === RECOVERY_ASSISTANCE_POLICY_VERSION;
  const selectorIds = requestedAssistance
    ? (log.selectorCandidates?.map((entry) => entry.id) ?? [])
    : ids;
  if (
    requestedAssistance &&
    (ids.includes(REQUEST_PI_CANDIDATE.id) ||
      canonical(log.selectorCandidates) !== canonical([...log.candidates, REQUEST_PI_CANDIDATE]))
  )
    errors.push("selector_candidates_mismatch");
  if (log.jev.probabilities) {
    const keys = Object.keys(log.jev.probabilities);
    if (keys.length !== selectorIds.length || keys.some((id) => !selectorIds.includes(id)))
      errors.push("distribution_candidates_mismatch");
  }
  if (requestedAssistance) {
    const assistance = log.assistance;
    if (!assistance) errors.push("missing_assistance_evidence");
    if (log.pi.status !== "skipped" && assistance?.status !== "requested")
      errors.push("pi_without_assistance_request");
    if (log.state === "deferred" && assistance?.status !== "deferred")
      errors.push("deferred_without_assistance_evidence");
    if (assistance?.jev) {
      if (log.jev.status !== "low-confidence") errors.push("unexpected_assistance_check");
      if (canonical(assistance.candidates) !== canonical(ASSISTANCE_CANDIDATES))
        errors.push("assistance_candidates_mismatch");
      if (assistance.jev.probabilities) {
        const keys = Object.keys(assistance.jev.probabilities);
        const allowed = ASSISTANCE_CANDIDATES.map((entry) => entry.id);
        if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key)))
          errors.push("assistance_distribution_mismatch");
      }
    }
    if (
      assistance?.status === "deferred" &&
      (log.jev.status !== "low-confidence" ||
        !assistance.jev ||
        !(
          assistance.jev.status === "low-confidence" ||
          (assistance.jev.status === "success" &&
            assistance.jev.candidateId === "wait_for_evidence")
        ))
    )
      errors.push("invalid_assistance_deferral");
    if (assistance?.status === "requested") {
      const valid =
        assistance.requestedBy === "jev-control"
          ? log.jev.status === "success" && log.jev.candidateId === REQUEST_PI_CANDIDATE.id
          : assistance.requestedBy === "jev-assistance"
            ? log.jev.status === "low-confidence" &&
              assistance.jev?.status === "success" &&
              assistance.jev.candidateId === "request_pi"
            : assistance.requestedBy === "recovery" &&
              (["error", "timeout", "invalid", "skipped"].includes(
                assistance.jev?.status ?? log.jev.status,
              ) ||
                (log.policyVersion === RECOVERY_ASSISTANCE_POLICY_VERSION &&
                  log.jev.status === "low-confidence" &&
                  assistance.jev?.status === "low-confidence" &&
                  assistance.reason === "jev_assistance_uncertain_recovery"));
      if (!valid) errors.push("invalid_assistance_request");
    }
  }
  return structuredClone({
    valid: errors.length === 0,
    errors,
    state: log.state,
    selection: log.final,
    candidate,
    rule: log.rule,
    jev: log.jev,
    pi: log.pi,
    assistance: log.assistance,
    dispatches: log.dispatches,
  });
}
