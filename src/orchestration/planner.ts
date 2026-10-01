import { fail, OperationError, safeError } from "../core/errors.js";
import type { ActorContext, Task } from "../core/types.js";
import type { ConversationEngine, RuntimeTool } from "../runtime/types.js";
import { compileWorkflowContract } from "./contract-change.js";
import { validateDocumentDelivery } from "./document-delivery.js";
import { type PlanningAudit, PlanningDiagnostics } from "./planning-diagnostics.js";
import { type PlanningSource, planningSources, sourceText } from "./planning-sources.js";
import { planningFailureLocation } from "./planning-validation.js";
import { templatePlan } from "./templates.js";
import {
  phases,
  validatePlan,
  type WorkflowNode,
  type WorkflowPlan,
  type WorkflowState,
  type WorkflowTemplate,
} from "./workflow.js";

export interface PlanningLeaderBridgeInput {
  systemPrompt: string;
  prompt: string;
  tools: RuntimeTool[];
  signal: AbortSignal;
  /** The plan this activation accepted, if any; the caller persists it. */
  acceptedPlan?(): WorkflowPlan | undefined;
  assertCurrent(): void;
}

/**
 * When present, plan creation runs inside the task's durable Leader session
 * instead of a one-shot planning call. The same validation, source checks and
 * authorization verifiers stay in force either way.
 */
export type PlanningLeaderBridge = ((
  input: PlanningLeaderBridgeInput,
) => Promise<{ text: string }>) & {
  /** Durable plan this step already accepted, if any. */
  acceptedPlan?(): WorkflowPlan | undefined;
};

/** The bridge exposes the plan the model accepted so the caller can persist it. */
export interface PlanningLeaderOutcome {
  text: string;
  acceptedPlan?: WorkflowPlan;
}

/**
 * Inline size at which planning switches to paged on-demand reads. It is a
 * presentation threshold, never a refusal cap: mandatory user原文 still reaches
 * the engine whole.
 */
export const PLANNING_PROMPT_INLINE_BYTES = 12288;

export async function planWorkflow(input: {
  task: Task;
  state: WorkflowState;
  engine: ConversationEngine;
  actor: ActorContext;
  userMessages: string[];
  sources?: PlanningSource[];
  contractSource?: PlanningSource;
  /** Initial ordinary discussions only fill the compiled template, never replace its graph. */
  simpleDiscussion?: boolean;
  audit?: PlanningAudit;
  signal: AbortSignal;
  leader?: PlanningLeaderBridge;
  assertCurrent(): void;
}): Promise<WorkflowPlan> {
  let selected: WorkflowPlan | undefined;
  const sources = planningSources(input.task, input.userMessages, input.sources);
  const constraintSources = sources.filter((source) => !source.legacy);
  const diagnostics = new PlanningDiagnostics(input.audit);
  const stopped = new AbortController();
  const signal = AbortSignal.any([input.signal, stopped.signal]);
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
        documentDelivery: {
          type: "object",
          description:
            "仅新版讨论任务：用户明确要求沉淀/保存文档时，引用其完整肯定要求并列出文档路径。只读分析或用户禁止写入时不得填写；不把写文档升级为业务开发，也不重复索取已给出的授权。未指定名称可用 docs/DESIGN.md。",
          properties: {
            paths: { type: "array", items: { type: "string" } },
            requireConsensus: {
              type: "boolean",
              description:
                "仅用户明确要求双方或全体指定参与者认可同版最终文档时为 true；程序生成逐一确认节点，普通评审不自动要求全体认可。",
            },
            sourceMessageId: {
              type: "string",
              enum: sources.map((source) => source.id),
              description: "引用所列真实用户消息的 ID；程序保留完整原文，无需复制。",
            },
          },
          required: ["paths", "sourceMessageId"],
          additionalProperties: false,
        },
        contractChange: {
          type: "object",
          description:
            "仅重规划：最新用户明确取消已接受的共同认可或项目文档要求时列出撤销项。省略即继承；取消文档时若绑定共同认可，须明确同时撤销该门槛。程序另用受限 pi 核验，不接受模型自行降级。",
          properties: {
            sourceMessageId: {
              type: "string",
              enum: input.contractSource
                ? [input.contractSource.id]
                : sources.map((source) => source.id),
              description:
                "只能引用 contractChangeSource 所列最新真实任务输入，不能引用创建原文或查询。",
            },
            removeConsensus: { type: "boolean", enum: [true] },
            removeDocumentDelivery: { type: "boolean", enum: [true] },
          },
          required: ["sourceMessageId"],
          additionalProperties: false,
        },
        validation: {
          type: "object",
          description:
            "用户明确禁止验证时用 not_run，引用其原文；仍须独立只读评审。其他情况用 execute。",
          properties: {
            mode: { type: "string", enum: ["execute", "not_run"] },
            reason: { type: "string" },
            sourceMessageId: {
              type: "string",
              ...(constraintSources.length
                ? { enum: constraintSources.map((source) => source.id) }
                : {}),
              description: "not_run 必须引用明确禁止验证的真实用户消息 ID；任务概括不是授权。",
            },
          },
          required: ["mode", "reason"],
          additionalProperties: false,
        },
        nodes: {
          type: "array",
          description:
            "仅复杂任务或重规划需要：替换节点图。简单任务省略，沿用模板。报告必须依赖所有工作节点；新版讨论按顺序互相回应。confirm-* 认可节点由程序重新编译，不复制或手工填写。",
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
              documentPaths: { type: "array", items: { type: "string" } },
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
      if (diagnostics.stopped) throw diagnostics.stopped;
      const startedAt = Date.now();
      let field = "template";
      let nodeId: string | undefined;
      try {
        input.assertCurrent();
        if (selected) fail("workflow_plan", "本轮已有计划。");
        if (!templates.includes(args.template as WorkflowTemplate))
          fail("workflow_scope", "规划器只能使用本任务允许的模板，不能改换显式指定的模板。");
        field = "instructions/deliveryRequirements";
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
          field = "nodes";
          if (input.simpleDiscussion)
            fail(
              "workflow_plan",
              "普通讨论首轮使用固定节点，只填写文档路径、任务书和验收项；不能替换节点图。",
            );
          if (!Array.isArray(args.nodes)) fail("workflow_plan", "节点图必须为数组。");
          plan.nodes = structuredClone(args.nodes) as WorkflowNode[];
        }
        plan.version = input.state.plan.version;
        plan.goal = input.task.requirements;
        if (args.requiredArtifacts !== undefined)
          plan.requiredArtifacts = args.requiredArtifacts as string[];
        let requireConsensus: unknown;
        let consensusSourceId: unknown;
        if (args.documentDelivery !== undefined) {
          field = "documentDelivery";
          const delivery = args.documentDelivery as {
            paths: string[];
            requireConsensus?: boolean;
            sourceMessageId?: string;
            userRequest?: string;
          };
          requireConsensus = delivery.requireConsensus;
          consensusSourceId = delivery.sourceMessageId;
          // Old tool transcripts remain replayable; new schemas only expose source IDs.
          plan.documentDelivery = {
            paths: delivery.paths,
            userRequest:
              delivery.sourceMessageId !== undefined
                ? sourceText(sources, delivery.sourceMessageId)
                : (delivery.userRequest ?? ""),
          };
          validateDocumentDelivery(plan, input.task, input.userMessages);
        }
        if (args.validation !== undefined && input.task.kind !== "discussion") {
          field = "validation.sourceMessageId";
          const validation = args.validation as NonNullable<WorkflowPlan["validation"]> & {
            sourceMessageId?: string;
          };
          plan.validation = { mode: validation.mode, reason: validation.reason };
          if (validation.mode === "not_run") {
            const legacy =
              input.task.promptVersion !== 3 &&
              !input.task.userRequest &&
              !constraintSources.length;
            const permittedSources = legacy
              ? [{ id: "legacy-requirements", text: input.task.requirements }]
              : constraintSources;
            const constraint =
              validation.sourceMessageId !== undefined
                ? sourceText(constraintSources, validation.sourceMessageId)
                : permittedSources.find((source) =>
                    legacy
                      ? !!validation.userConstraint?.trim() &&
                        source.text.includes(validation.userConstraint)
                      : source.text.trim() === validation.userConstraint?.trim(),
                  )?.text;
            if (
              !constraint?.trim() ||
              !permittedSources.some((source) => source.text === constraint)
            )
              fail(
                "workflow_scope",
                "不运行验证的约束必须引用本任务用户原文并保留整条原文，任务概括不能授予约束。",
              );
            plan.validation.userConstraint = constraint;
          }
        }
        field = "contractChange";
        compileWorkflowContract({
          plan,
          previous: input.state.plan,
          participantIds: input.task.participantIds,
          sources,
          change: args.contractChange,
          requireConsensus,
          consensusSourceId,
        });
        for (const [id, instruction] of Object.entries(args.instructions)) {
          field = "instructions";
          nodeId = id;
          const node = plan.nodes.find((entry) => entry.id === id);
          if (!node) fail("workflow_plan", "任务书引用了不存在的模板节点。");
          node.instruction = instruction as string;
        }
        nodeId = undefined;
        if (plan.validation?.mode === "not_run")
          for (const node of plan.nodes.filter((entry) => entry.phase === "validating")) {
            node.access = "read";
            node.instruction = `仅作独立只读复核，不运行验证命令；记录 not_run 及原因：${plan.validation.reason}`;
          }
        plan.deliveryRequirements = [
          ...new Set([...plan.deliveryRequirements, ...(args.deliveryRequirements as string[])]),
        ];
        field = "plan.nodes";
        try {
          validatePlan(plan, input.task, input.userMessages);
        } catch (error) {
          ({ field, nodeId } = planningFailureLocation(plan, input.task, error));
          throw error;
        }
        selected = plan;
        diagnostics.record(args, startedAt);
        return { planned: true, version: plan.version };
      } catch (error) {
        const noProgress = diagnostics.record(args, startedAt, error, field, nodeId);
        if (noProgress) stopped.abort(noProgress);
        if (noProgress) throw noProgress;
        const safe = safeError(error);
        if (safe.code.startsWith("workflow_"))
          throw new OperationError(
            safe.code,
            `${safe.message} 字段：${field}${nodeId ? `；节点：${nodeId}` : ""}。`,
            safe.outcome,
          );
        throw error;
      }
    },
  };
  const properties = tool.parameters.properties as Record<string, unknown>;
  if (input.simpleDiscussion) delete properties.nodes;
  if (input.task.kind === "discussion") delete properties.validation;
  const systemPrompt =
    "你只负责规划 myrix 工作流，不执行用户项目工作。理解完整原文及后续修订，从允许的模板选择适用流程并细化具体任务书；调用 orchestration_plan。任务显式指定的模板必须保留，重规划可调整节点但不能改换模板。保留用户硬约束，不能把参与者意见当授权。" +
    "已有文档交付与共同认可默认继承；只有 contractChangeSource 中最新真实用户输入明确撤销时，用 contractChange 列出撤销项及来源编号，取消文档要用 removeDocumentDelivery，不能靠省略字段取消。程序会另行核验撤销授权。" +
    "讨论模板没有验证步骤，不设置 validation。执行任务仅在真实用户原文明令禁止验证时设置 validation.mode=not_run，通过 sourceMessageId 引用；任务 requirements 概括不授予新约束，独立只读评审仍保留。" +
    "普通讨论首轮不替换节点图；文档写入会由程序生成 document 节点，可通过 instructions.document 补充任务书。bugfix 用于修复已有缺陷。单纯评审任务不得开始实现。额外验收条件应可核对，不扩大范围。";
  const prompt = JSON.stringify({
    task: {
      kind: input.task.kind,
      template: input.task.orchestration?.template,
      requirements: input.task.requirements,
      userRequest: input.task.userRequest,
    },
    userMessages: input.userMessages,
    sources,
    contractChangeSource: input.contractSource,
    template: input.state.plan,
    previous: { issues: input.state.issues, nodes: input.state.nodes },
  });
  try {
    if (input.leader) {
      // A plan this planning step already accepted is recovered from durable
      // state: the model is never asked to re-plan an accepted action.
      const accepted = input.leader.acceptedPlan?.();
      if (accepted) return accepted;
      // Delegated planning runs in the task's durable Leader session. The
      // activation envelope is bounded, but mandatory user原文 is never cut:
      // the payload is delivered whole through the runtime's own context
      // management, exactly like any other Leader activation.
      const bounded = JSON.stringify({
        activation: "create_plan",
        planVersion: input.state.plan.version,
        systemPrompt,
        payloadBytes: Buffer.byteLength(prompt, "utf8"),
        payload: JSON.parse(prompt) as unknown,
      });
      await input.leader({
        systemPrompt:
          "你正在同一任务的持久 Leader 会话中创建计划；只生成计划，不执行任何调度动作。",
        prompt: bounded,
        tools: [tool],
        signal,
        acceptedPlan: () => selected,
        assertCurrent: input.assertCurrent,
      });
      // Return the canonical durable plan: the plan committed and any later
      // recovery of it must be byte-identical, never two subtly different shapes.
      const durable = input.leader.acceptedPlan?.();
      if (durable !== undefined) selected = durable;
    } else
      await input.engine.run({
        actor: input.actor,
        sessionId: `workflow-plan:${input.task.id}:${input.state.plan.version}`,
        messages: [],
        signal,
        tools: [tool],
        enforceClaims: false,
        // Tool execution is mandatory via the selected-plan guard below. Let the
        // provider use auto: some compatible Responses gateways reject "required".
        systemPrompt,
        prompt,
      });
  } catch (error) {
    throw diagnostics.stopped ?? error;
  }
  if (diagnostics.stopped) throw diagnostics.stopped;
  input.assertCurrent();
  if (!selected) fail("workflow_plan", "规划器未返回有效计划，未开始派发。");
  return selected;
}
