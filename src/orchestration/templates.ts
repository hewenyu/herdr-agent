import type { Task } from "../core/types.js";
import type { WorkflowNode, WorkflowPlan, WorkflowTemplate } from "./workflow.js";

export function templatePlan(task: Task, template?: WorkflowTemplate): WorkflowPlan {
  const selected = task.kind === "discussion" ? "discussion" : (template ?? "development");
  const node = (
    id: string,
    phase: WorkflowNode["phase"],
    role: WorkflowNode["role"],
    purpose: string,
    dependsOn: string[],
    access: WorkflowNode["access"] = "read",
    participantId?: string,
  ): WorkflowNode => ({
    id,
    phase,
    role,
    purpose,
    instruction: purpose,
    dependsOn,
    access,
    ...(participantId ? { participantId } : {}),
  });
  let nodes: WorkflowNode[];
  if (selected === "discussion") {
    const opening = task.participantIds.map((participantId, index) =>
      node(
        `opening-${index + 1}`,
        "discussing",
        "analyst",
        task.promptVersion === 3
          ? index === 0
            ? "提出具体初稿，将详细依据保存为材料；简短说明重点，请下一位参与者评审。"
            : "读取前一位参与者的实际材料，逐项回应，说明同意、修改及未决分歧；详细意见保存为材料，简短交接。"
          : "独立分析用户问题，提出依据、方案及未决问题；不预设其他参与者结论。",
        task.promptVersion === 3 && index > 0 ? [`opening-${index}`] : [],
        "read",
        participantId,
      ),
    );
    nodes = [
      ...opening,
      node(
        "cross-review",
        "reviewing",
        "reviewer",
        "逐项核对独立分析，回应分歧并核实关键证据，明确保留的争议。",
        opening.map((entry) => entry.id),
      ),
      node(
        "report",
        "reporting",
        "reporter",
        "根据已核对的材料整合最终讨论报告，准确列出保留分歧和用户需裁决的事项。",
        ["cross-review"],
      ),
    ];
  } else {
    const readonly = task.kind !== "development";
    nodes = [
      node(
        "analysis",
        "planning",
        "analyst",
        selected === "bugfix"
          ? "取得复现或失败证据，定位根因，制定最小合理修复及回归计划。"
          : "核对完整需求与仓库事实，明确验收条件和相称实施方案。",
        [],
      ),
      ...(!readonly
        ? [
            node(
              "implement",
              "implementing",
              "implementer",
              selected === "bugfix"
                ? "按证据做最小合理修复，保留用户已有改动并记录影响范围。"
                : "按已核对的方案实现要求，保留用户已有改动并记录使用方式。",
              ["analysis"],
              "write",
            ),
          ]
        : []),
      node(
        "validate",
        "validating",
        "reviewer",
        selected === "bugfix"
          ? "独立核查根因和修复，重跑针对性回归，记录实际命令、结果和剩余风险；若根因不明、影响扩大或存在方案分歧，提出阻塞并请求重规划加入讨论。"
          : "独立重跑与改动相称的验证，记录实际命令、结果及未运行原因，不把自述当已验证。",
        [readonly ? "analysis" : "implement"],
        readonly ? "read" : "write",
      ),
      ...(selected !== "bugfix"
        ? [
            node(
              "review",
              "reviewing",
              "reviewer",
              "独立评审实现与验收项，报告可复现问题、依据和剩余风险；无新增修改授权时不修改项目。",
              ["validate"],
            ),
          ]
        : []),
      node(
        "report",
        "reporting",
        "reporter",
        "整合可审阅交付报告，逐项列明实现、验证来源、结果和未完成事项。",
        [selected === "bugfix" ? "validate" : "review"],
      ),
    ];
  }
  const deliveryRequirements =
    selected === "discussion"
      ? ["推荐方案与理由", "已解决问题", "保留分歧与未决事项", "后续任务与验收条件"]
      : selected === "bugfix"
        ? ["复现条件与失败证据", "根因", "修复范围", "回归验证", "剩余影响与未验证场景"]
        : ["目标与范围", "验收项覆盖", "实现与代码引用", "验证结果", "剩余问题与使用说明"];
  return {
    id: `${task.id}:workflow`,
    version: 1,
    templateVersion: 1,
    template: selected,
    goal: task.requirements,
    nodes,
    deliveryRequirements,
  };
}
