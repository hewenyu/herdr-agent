import { canonical, stableId } from "../core/ids.js";
import type { Store } from "../storage/store.js";
import type { ChoiceCandidate, JevResult } from "./jev.js";

export const SELECTION_POLICY_VERSION = "workflow-selection-v1";

export interface DecisionLog {
  version: 1;
  policyVersion: typeof SELECTION_POLICY_VERSION;
  eventId: string;
  revision: string;
  planVersion: string | number;
  templateVersion: string | number;
  snapshotRef: string;
  snapshot: unknown;
  candidates: ChoiceCandidate[];
  rule: { status: "selected" | "not-applicable"; reason: string; candidateId?: string };
  jev: JevResult;
  pi: {
    status: "skipped" | "pending" | "success" | "failed" | "cancelled";
    reason: string;
    candidateId?: string;
    rationale?: string;
    sessionId?: string;
    fallbackReason?: string;
    model?: string;
  };
  state: "pending" | "selected" | "failed" | "cancelled";
  final?: { source: "rule" | "jev" | "pi"; candidateId: string; reason: string };
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
  dispatches: DecisionLog["dispatches"];
} {
  const errors: string[] = [];
  if (log.version !== 1 || log.policyVersion !== SELECTION_POLICY_VERSION)
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
  if (log.jev.probabilities) {
    const keys = Object.keys(log.jev.probabilities);
    if (keys.length !== ids.length || keys.some((id) => !ids.includes(id)))
      errors.push("distribution_candidates_mismatch");
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
    dispatches: log.dispatches,
  });
}
