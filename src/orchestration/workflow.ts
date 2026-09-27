import { fail } from "../core/errors.js";
import type { Task } from "../core/types.js";

export type WorkflowTemplate = "discussion" | "development" | "bugfix";
export type Phase =
  | "clarifying"
  | "discussing"
  | "planning"
  | "implementing"
  | "validating"
  | "reviewing"
  | "reporting"
  | "awaiting_acceptance";
export type WorkflowRole = "analyst" | "implementer" | "reviewer" | "reporter";

export interface WorkflowNode {
  id: string;
  phase: Phase;
  role: WorkflowRole;
  purpose: string;
  instruction: string;
  dependsOn: string[];
  access: "read" | "write";
  participantId?: string;
}

export interface WorkflowPlan {
  id: string;
  version: number;
  templateVersion: 1;
  template: WorkflowTemplate;
  goal: string;
  nodes: WorkflowNode[];
  deliveryRequirements: string[];
  requiredArtifacts?: string[];
  validation?: { mode: "execute" | "not_run"; reason: string; userConstraint?: string };
}

export interface WorkflowIssue {
  id: string;
  description: string;
  status: "open" | "resolved" | "deferred";
  blocking: boolean;
  evidenceRefs: string[];
  raisedBy: string;
  responses: Array<{ outputId: string; summary: string }>;
}

export interface WorkflowEvidence {
  id: string;
  source: "self_report" | "agent_review" | "configured_command" | "not_run";
  description: string;
  artifactRevision: string;
  outputId?: string;
  participantId?: string;
  command?: string;
  result: "passed" | "failed" | "not_run";
  verificationId?: string;
  configRevision?: string;
}

export interface NodeProgress {
  status: "pending" | "dispatched" | "completed" | "blocked";
  attempt: number;
  operationId?: string;
  participantId?: string;
  inputRevision?: string;
  artifactRevision?: string;
  outputId?: string;
  summary?: string;
  error?: string;
}

export interface WorkflowState {
  taskId: string;
  plan: WorkflowPlan;
  phase: Phase;
  /** Existing user hash before adding the plan and phase. */
  userRevision: string;
  nodes: Record<string, NodeProgress>;
  issues: WorkflowIssue[];
  evidence: WorkflowEvidence[];
  artifacts: Array<{
    path: string;
    reference?: string;
    hash: string;
    outputId: string;
    artifactRevision: string;
  }>;
  consumedOutputs: string[];
  batches: string[];
  stall: { open: string[]; unchanged: number; awaitingUser: boolean };
  planning?: "needed" | "ready";
  planningReason?: string;
  report?: { id: string; path: string; hash: string; outputId: string; artifactRevision: string };
  error?: string;
}

export const WORKFLOWS = "task_workflows";
export const phases: Phase[] = [
  "clarifying",
  "discussing",
  "planning",
  "implementing",
  "validating",
  "reviewing",
  "reporting",
  "awaiting_acceptance",
];

/** Plans describe work, never executable code or additional permissions. */
export function validatePlan(plan: WorkflowPlan, task: Task): void {
  if (
    !plan ||
    !plan.id ||
    !Number.isSafeInteger(plan.version) ||
    plan.version < 1 ||
    plan.templateVersion !== 1 ||
    !["discussion", "development", "bugfix"].includes(plan.template) ||
    typeof plan.goal !== "string" ||
    !plan.goal.trim() ||
    !Array.isArray(plan.nodes) ||
    !plan.nodes.length ||
    plan.nodes.length > 64 ||
    !Array.isArray(plan.deliveryRequirements) ||
    !plan.deliveryRequirements.length ||
    plan.deliveryRequirements.some((item) => typeof item !== "string" || !item.trim())
  )
    fail("workflow_plan", "工作流计划不完整。");
  if (
    plan.requiredArtifacts &&
    (!Array.isArray(plan.requiredArtifacts) ||
      plan.requiredArtifacts.some((path) => typeof path !== "string" || !path.trim()))
  )
    fail("workflow_plan", "必需产物必须是明确的任务内文件路径。");
  if (
    plan.validation &&
    (!["execute", "not_run"].includes(plan.validation.mode) ||
      typeof plan.validation.reason !== "string" ||
      !plan.validation.reason.trim() ||
      (plan.validation.mode === "not_run" && !plan.validation.userConstraint?.trim()))
  )
    fail("workflow_plan", "不运行验证必须记录用户约束和原因。");
  if ((task.kind === "discussion") !== (plan.template === "discussion"))
    fail("workflow_scope", "讨论计划不能自行切换到开发，执行任务不能套用讨论授权。");
  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (
      !node ||
      typeof node !== "object" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(node.id) ||
      ids.has(node.id) ||
      !phases.includes(node.phase) ||
      node.phase === "awaiting_acceptance" ||
      !["analyst", "implementer", "reviewer", "reporter"].includes(node.role) ||
      !["read", "write"].includes(node.access) ||
      !Array.isArray(node.dependsOn) ||
      typeof node.instruction !== "string" ||
      !node.instruction.trim() ||
      typeof node.purpose !== "string" ||
      !node.purpose.trim() ||
      (node.participantId !== undefined && !task.participantIds.includes(node.participantId))
    )
      fail("workflow_plan", "节点标识、角色、依赖或参与者无效。");
    if ((task.kind === "discussion" || task.kind === "review") && node.access !== "read")
      fail("workflow_scope", "此任务未授权修改项目。");
    if (
      (["validating", "reviewing"].includes(node.phase) && node.role !== "reviewer") ||
      (node.phase === "reporting" && node.role !== "reporter") ||
      (node.phase === "implementing" && node.role !== "implementer")
    )
      fail("workflow_plan", "执行、验证、评审与报告阶段必须使用对应角色。");
    ids.add(node.id);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (!ids.has(id) || visiting.has(id)) fail("workflow_plan", "节点依赖缺失或包含循环。");
    if (visited.has(id)) return;
    visiting.add(id);
    const node = plan.nodes.find((entry) => entry.id === id) as WorkflowNode;
    for (const dependency of node.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  const ancestors = (id: string): Set<string> => {
    const result = new Set<string>();
    const collect = (current: string) => {
      for (const dependency of plan.nodes.find((node) => node.id === current)?.dependsOn ?? []) {
        if (result.has(dependency)) continue;
        result.add(dependency);
        collect(dependency);
      }
    };
    collect(id);
    return result;
  };
  const implementations = plan.nodes.filter((node) => node.role === "implementer");
  const validations = plan.nodes.filter((node) => node.phase === "validating");
  for (const node of plan.nodes.filter((entry) => entry.role === "reviewer")) {
    const before = ancestors(node.id);
    if (
      implementations.some((entry) => !before.has(entry.id)) ||
      (node.phase === "reviewing" && validations.some((entry) => !before.has(entry.id)))
    )
      fail("workflow_plan", "验证须在实现之后，最终评审须依赖验证，不能提前证明后续工作。");
  }
  if (
    task.kind === "discussion" &&
    task.participantIds.some(
      (id) =>
        !plan.nodes.some(
          (node) => node.participantId === id && node.role === "analyst" && !node.dependsOn.length,
        ),
    )
  )
    fail("workflow_plan", "讨论计划须给各参与者保留独立开场节点。");
  const reports = plan.nodes.filter((node) => node.phase === "reporting");
  if (reports.length !== 1) fail("workflow_plan", "计划缺少报告交付出口。");
  const predecessors = new Set<string>();
  const collect = (id: string) => {
    for (const dependency of plan.nodes.find((node) => node.id === id)?.dependsOn ?? []) {
      if (!predecessors.has(dependency)) {
        predecessors.add(dependency);
        collect(dependency);
      }
    }
  };
  collect(reports[0]?.id ?? "");
  if (plan.nodes.some((node) => node !== reports[0] && !predecessors.has(node.id)))
    fail("workflow_plan", "报告必须依赖全部工作节点，不能先写报告再补工作。");
  if (
    task.kind === "development" &&
    (!plan.nodes.some((node) => node.role === "implementer") ||
      !plan.nodes.some((node) => node.phase === "validating") ||
      !plan.nodes.some((node) => node.role === "reviewer"))
  )
    fail("workflow_plan", "开发计划必须包含验证和独立评审。");
}
