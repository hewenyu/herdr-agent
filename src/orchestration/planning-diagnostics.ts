import { OperationError, safeError } from "../core/errors.js";
import { canonical, stableId } from "../core/ids.js";
import type { Store } from "../storage/store.js";

export interface PlanningAudit {
  store: Pick<Store, "set">;
  id: string;
  taskId: string;
  planVersion: number;
}

export interface PlanningAttempt {
  taskId: string;
  planVersion: number;
  attempt: number;
  inputHash: string;
  structure: Record<string, unknown>;
  durationMs: number;
  outcome: "accepted" | "rejected" | "no_progress";
  error?: { code: string; field: string; nodeId?: string; message: string; ruleHash: string };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const identity = (value: unknown) =>
  typeof value === "string" && /^[\w-]{1,80}$/.test(value) ? value : undefined;
const token = (value: unknown, allowed: string[]) =>
  typeof value === "string" && allowed.includes(value) ? value : "invalid";
const refs = (value: unknown) =>
  Array.isArray(value) ? value.map((entry) => stableId(canonical(entry))) : undefined;

function redactMessage(message: string, value: unknown): string {
  if (typeof value === "string" && value.length >= 4)
    return message.replaceAll(value, `[input:${stableId(value)}]`);
  if (value && typeof value === "object")
    for (const entry of Object.values(value)) message = redactMessage(message, entry);
  return message;
}

/** Prose, paths, credentials and arbitrary extra properties never enter the audit. */
export function planningStructure(args: Record<string, unknown>): Record<string, unknown> {
  const document = object(args.documentDelivery);
  const validation = object(args.validation);
  return {
    template: token(args.template, ["discussion", "development", "bugfix"]),
    instructions: Object.entries(object(args.instructions)).map(([id, value]) => ({
      nodeId: identity(id),
      contentHash: stableId(canonical(value)),
    })),
    deliveryRequirements: refs(args.deliveryRequirements),
    requiredArtifacts: refs(args.requiredArtifacts),
    documentDelivery: args.documentDelivery
      ? {
          paths: refs(document.paths),
          sourceMessageId: identity(document.sourceMessageId),
          requireConsensus: document.requireConsensus === true,
        }
      : undefined,
    validation: args.validation
      ? {
          mode: token(validation.mode, ["execute", "not_run"]),
          sourceMessageId: identity(validation.sourceMessageId),
        }
      : undefined,
    nodes: Array.isArray(args.nodes)
      ? args.nodes.map((value) => {
          const node = object(value);
          return {
            id: identity(node.id),
            phase: token(node.phase, [
              "clarifying",
              "discussing",
              "planning",
              "implementing",
              "validating",
              "reviewing",
              "reporting",
            ]),
            role: token(node.role, ["analyst", "implementer", "reviewer", "reporter"]),
            access: token(node.access, ["read", "write"]),
            dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn.map(identity) : undefined,
            participantId: identity(node.participantId),
            documentPaths: refs(node.documentPaths),
          };
        })
      : undefined,
  };
}

/** A repeated identical rejected proposal is no progress, independent of business rounds. */
export class PlanningDiagnostics {
  private readonly rejected = new Set<string>();
  private attempt = 0;
  stopped?: OperationError;
  constructor(private readonly audit?: PlanningAudit) {}

  record(
    args: Record<string, unknown>,
    startedAt: number,
    error?: unknown,
    field = "plan",
    nodeId?: string,
  ): OperationError | undefined {
    const inputHash = stableId(canonical(args));
    const safe = error === undefined ? undefined : safeError(error);
    const ruleHash = safe ? stableId(safe.code, safe.message, field, nodeId ?? "") : undefined;
    const rejectedKey = `${inputHash}:${ruleHash}`;
    const repeated = !!safe && this.rejected.has(rejectedKey);
    if (safe) this.rejected.add(rejectedKey);
    const attempt: PlanningAttempt = {
      taskId: this.audit?.taskId ?? "",
      planVersion: this.audit?.planVersion ?? 0,
      attempt: ++this.attempt,
      inputHash,
      structure: planningStructure(args),
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome: repeated ? "no_progress" : safe ? "rejected" : "accepted",
      ...(safe
        ? {
            error: {
              code: safe.code,
              field,
              nodeId: identity(nodeId),
              message: redactMessage(safe.message, args),
              ruleHash: ruleHash as string,
            },
          }
        : {}),
    };
    this.audit?.store.set(
      "workflow_planning_attempts",
      `${this.audit.id}:${this.attempt}`,
      attempt,
    );
    if (repeated)
      this.stopped = new OperationError(
        "workflow_plan_no_progress",
        `规划器重复提交相同无效输入，仍未修正 ${field}${nodeId ? `（${nodeId}）` : ""}；已停止本次规划，保留诊断供修正。`,
      );
    return this.stopped;
  }
}
