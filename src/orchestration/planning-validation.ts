import { safeError } from "../core/errors.js";
import type { Task } from "../core/types.js";
import { phases, type WorkflowNode, type WorkflowPlan } from "./workflow.js";

/** Enrich existing validator failures without weakening or duplicating its authority. */
export function planningFailureLocation(
  plan: WorkflowPlan,
  task: Task,
  error: unknown,
): { field: string; nodeId?: string } {
  const message = safeError(error).message;
  const at = (node: WorkflowNode | undefined, field: string) => ({
    field: `nodes.${field}`,
    ...(typeof node?.id === "string" ? { nodeId: node.id } : {}),
  });
  if (message.includes("节点标识、角色、依赖或参与者")) {
    const ids = new Set<string>();
    for (const [index, node] of plan.nodes.entries()) {
      if (!node || typeof node !== "object") return { field: `nodes[${index}]` };
      if (typeof node.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(node.id) || ids.has(node.id))
        return at(node, "id");
      ids.add(node.id);
      if (!phases.includes(node.phase) || node.phase === "awaiting_acceptance")
        return at(node, "phase");
      if (!["analyst", "implementer", "reviewer", "reporter"].includes(node.role))
        return at(node, "role");
      if (!["read", "write"].includes(node.access)) return at(node, "access");
      if (!Array.isArray(node.dependsOn)) return at(node, "dependsOn");
      if (typeof node.purpose !== "string" || !node.purpose.trim()) return at(node, "purpose");
      if (typeof node.instruction !== "string" || !node.instruction.trim())
        return at(node, "instruction");
      if (node.participantId !== undefined && !task.participantIds.includes(node.participantId))
        return at(node, "participantId");
    }
  }
  if (message.includes("文档节点超出"))
    return at(
      plan.nodes.find(
        (node) =>
          node.documentPaths !== undefined &&
          (!Array.isArray(node.documentPaths) ||
            !node.documentPaths.length ||
            node.access !== "write" ||
            node.role !== "analyst" ||
            node.phase !== "discussing" ||
            node.documentPaths.some((path) => !plan.documentDelivery?.paths.includes(path))),
      ),
      "documentPaths/role/phase/access",
    );
  if (message.includes("此任务未授权修改"))
    return at(
      plan.nodes.find(
        (node) => node.access !== "read" && (task.kind === "review" || !node.documentPaths?.length),
      ),
      "access",
    );
  if (message.includes("执行、验证、评审与报告"))
    return at(
      plan.nodes.find(
        (node) =>
          (["validating", "reviewing"].includes(node.phase) && node.role !== "reviewer") ||
          (node.phase === "reporting" && node.role !== "reporter") ||
          (node.phase === "implementing" && node.role !== "implementer"),
      ),
      "phase/role",
    );
  if (message.includes("文档作者与固定评审者")) {
    const reviewers = new Set(
      plan.nodes.filter((node) => node.role === "reviewer").map((node) => node.participantId),
    );
    return at(
      plan.nodes.find(
        (node) =>
          node.documentPaths?.length &&
          (node.participantId
            ? reviewers.has(node.participantId)
            : task.participantIds.every((id) => reviewers.has(id))),
      ),
      "participantId",
    );
  }
  if (
    message.includes("节点依赖缺失") ||
    message.includes("验证须在实现之后") ||
    message.includes("报告必须依赖")
  ) {
    const ancestors = (node: WorkflowNode) => {
      const found = new Set<string>();
      const collect = (id: string) => {
        if (found.has(id)) return;
        found.add(id);
        for (const dependency of plan.nodes.find((entry) => entry.id === id)?.dependsOn ?? [])
          collect(dependency);
      };
      for (const id of node.dependsOn) collect(id);
      return found;
    };
    let node: WorkflowNode | undefined;
    if (message.includes("节点依赖缺失"))
      node = plan.nodes.find(
        (entry) =>
          entry.dependsOn.some((id) => !plan.nodes.some((candidate) => candidate.id === id)) ||
          ancestors(entry).has(entry.id),
      );
    else if (message.includes("报告必须依赖"))
      node = plan.nodes.find((entry) => entry.phase === "reporting");
    else
      node = plan.nodes.find(
        (entry) =>
          entry.role === "reviewer" &&
          plan.nodes.some(
            (prior) =>
              (prior.role === "implementer" ||
                prior.documentPaths?.length ||
                (entry.phase === "reviewing" && prior.phase === "validating")) &&
              !ancestors(entry).has(prior.id),
          ),
      );
    return at(node, "dependsOn");
  }
  if (message.includes("讨论计划须给")) return { field: "nodes.participantId" };
  if (message.includes("报告交付出口")) return { field: "nodes.reporting" };
  return { field: "plan.nodes" };
}
