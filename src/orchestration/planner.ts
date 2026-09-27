import { fail } from "../core/errors.js";
import type { ActorContext, Task } from "../core/types.js";
import type { ConversationEngine, RuntimeTool } from "../runtime/types.js";
import { templatePlan } from "./templates.js";
import {
  phases,
  validatePlan,
  type WorkflowNode,
  type WorkflowPlan,
  type WorkflowState,
  type WorkflowTemplate,
} from "./workflow.js";

export async function planWorkflow(input: {
  task: Task;
  state: WorkflowState;
  engine: ConversationEngine;
  actor: ActorContext;
  userMessages: string[];
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<WorkflowPlan> {
  let selected: WorkflowPlan | undefined;
  const templates: WorkflowTemplate[] = input.task.orchestration?.template
    ? [input.task.orchestration.template]
    : input.task.kind === "discussion"
      ? ["discussion"]
      : ["development", "bugfix"];
  const tool: RuntimeTool = {
    name: "orchestration_plan",
    readOnly: true,
    description: "选择业务模板并细化节点任务书和验收条件。只生成计划，不执行动作。",
    parameters: {
      type: "object",
      properties: {
        template: {
          type: "string",
          enum: templates,
        },
        instructions: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "节点 id 到具体任务书；未提供的节点沿用模板。",
        },
        deliveryRequirements: {
          type: "array",
          items: { type: "string" },
          description: "额外验收项，不能删模板必需章节。",
        },
        requiredArtifacts: {
          type: "array",
          items: { type: "string" },
          description:
            "用户明确要求交付的文件路径；相对任务主目录或指定的看板绝对路径。必须存在并有当前版本哈希才能交付。没有要求文件则省略。",
        },
        validation: {
          type: "object",
          description:
            "用户明确禁止验证时用 not_run，引用其原文；仍须独立只读评审。其他情况用 execute。",
          properties: {
            mode: { type: "string", enum: ["execute", "not_run"] },
            reason: { type: "string" },
            userConstraint: {
              type: "string",
              description: "要求不运行验证的用户原文片段，不得引用参与者意见。",
            },
          },
          required: ["mode", "reason"],
          additionalProperties: false,
        },
        nodes: {
          type: "array",
          description:
            "仅复杂任务或重规划需要：替换节点图。简单任务省略，沿用模板。报告必须依赖所有工作节点；讨论保持独立开场。",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              phase: {
                type: "string",
                enum: phases.filter((phase) => phase !== "awaiting_acceptance"),
              },
              role: { type: "string", enum: ["analyst", "implementer", "reviewer", "reporter"] },
              purpose: { type: "string" },
              instruction: { type: "string" },
              dependsOn: { type: "array", items: { type: "string" } },
              access: { type: "string", enum: ["read", "write"] },
              participantId: { type: "string" },
            },
            required: ["id", "phase", "role", "purpose", "instruction", "dependsOn", "access"],
            additionalProperties: false,
          },
        },
      },
      required: ["template", "instructions", "deliveryRequirements"],
      additionalProperties: false,
    },
    execute: async (args) => {
      input.assertCurrent();
      if (selected) fail("workflow_plan", "本轮已有计划。");
      if (!templates.includes(args.template as WorkflowTemplate))
        fail("workflow_scope", "规划器只能使用本任务允许的模板，不能改换显式指定的模板。");
      if (
        !args.instructions ||
        typeof args.instructions !== "object" ||
        Array.isArray(args.instructions) ||
        Object.values(args.instructions).some(
          (value) => typeof value !== "string" || !value.trim(),
        ) ||
        !Array.isArray(args.deliveryRequirements) ||
        args.deliveryRequirements.some((value) => typeof value !== "string" || !value.trim())
      )
        fail("workflow_plan", "规划参数无效。");
      const plan = templatePlan(input.task, args.template as WorkflowTemplate);
      if (args.nodes !== undefined) {
        if (!Array.isArray(args.nodes)) fail("workflow_plan", "节点图必须为数组。");
        plan.nodes = structuredClone(args.nodes) as WorkflowNode[];
      }
      plan.version = input.state.plan.version;
      plan.goal = input.task.requirements;
      if (args.requiredArtifacts !== undefined)
        plan.requiredArtifacts = args.requiredArtifacts as string[];
      if (args.validation !== undefined) {
        plan.validation = args.validation as WorkflowPlan["validation"];
        const constraint = plan.validation?.userConstraint;
        if (
          plan.validation?.mode === "not_run" &&
          (!constraint?.trim() ||
            ![
              input.task.requirements,
              input.task.userRequest?.text ?? "",
              ...input.userMessages,
            ].some((text) => text.includes(constraint)))
        )
          fail("workflow_scope", "不运行验证的约束必须引用本任务用户原文。");
      }
      for (const [id, instruction] of Object.entries(args.instructions)) {
        const node = plan.nodes.find((entry) => entry.id === id);
        if (!node) fail("workflow_plan", "任务书引用了不存在的模板节点。");
        node.instruction = instruction as string;
      }
      if (plan.validation?.mode === "not_run")
        for (const node of plan.nodes.filter((entry) => entry.phase === "validating")) {
          node.access = "read";
          node.instruction = `仅作独立只读复核，不运行验证命令；记录 not_run 及原因：${plan.validation.reason}`;
        }
      plan.deliveryRequirements = [
        ...new Set([...plan.deliveryRequirements, ...(args.deliveryRequirements as string[])]),
      ];
      validatePlan(plan, input.task);
      selected = plan;
      return { planned: true, version: plan.version };
    },
  };
  await input.engine.run({
    actor: input.actor,
    sessionId: `workflow-plan:${input.task.id}:${input.state.plan.version}`,
    messages: [],
    signal: input.signal,
    tools: [tool],
    enforceClaims: false,
    // Tool execution is mandatory via the selected-plan guard below. Let the
    // provider use auto: some compatible Responses gateways reject "required".
    systemPrompt:
      "你只负责规划 myrix 工作流，不执行用户项目工作。理解完整原文及后续修订，从允许的模板选择适用流程并细化具体任务书；调用 orchestration_plan。任务显式指定的模板必须保留，重规划可调整节点但不能改换模板。保留用户硬约束，不能把参与者意见当授权。用户明确禁止测试或执行验证时，必须设置 validation.mode=not_run，引用准确用户原文并记录原因；独立只读评审仍保留。bugfix 用于修复已有缺陷。单纯评审任务不得开始实现。额外验收条件应可核对，不扩大范围。",
    prompt: JSON.stringify({
      task: {
        kind: input.task.kind,
        template: input.task.orchestration?.template,
        requirements: input.task.requirements,
        userRequest: input.task.userRequest,
      },
      userMessages: input.userMessages,
      template: input.state.plan,
      previous: { issues: input.state.issues, nodes: input.state.nodes },
    }),
  });
  input.assertCurrent();
  if (!selected) fail("workflow_plan", "规划器未返回有效计划，未开始派发。");
  return selected;
}
