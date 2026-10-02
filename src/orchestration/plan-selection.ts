import { fail } from "../core/errors.js";
import { newId } from "../core/ids.js";
import type { Task } from "../core/types.js";
import { assessPlanningAssistance } from "./assistance.js";
import { compileConsensus } from "./consensus.js";
import {
  authorizeContractChange,
  compileWorkflowContract,
  latestContractInput,
} from "./contract-change.js";
import type { OrchestrationEvent } from "./contracts.js";
import { addDocumentDelivery, authorizeDocumentDelivery } from "./document-delivery.js";
import { createLeaderTemplateChoice, createPlanningLeaderBridge } from "./leader-planning.js";
import { planWorkflow } from "./planner.js";
import { planningSources } from "./planning-sources.js";
import type { WorkflowPorts } from "./runner.js";
import { templatePlan } from "./templates.js";
import type { WorkflowPlan, WorkflowState } from "./workflow.js";

/**
 * Plans that already passed every independent verifier for this event/revision.
 * Reusing one is not an authorization shortcut: it is the same fully authorized
 * plan, and this record is written only after the verifiers below succeed.
 */
export const AUTHORIZED_PLANS = "workflow_authorized_plans";

export function authorizedPlanKey(eventId: string, revision: string, planVersion: number): string {
  return `${eventId}\u0000${revision}\u0000${planVersion}`;
}

export async function choosePlan(
  ports: WorkflowPorts,
  task: Task,
  state: WorkflowState,
  event: OrchestrationEvent,
): Promise<WorkflowPlan> {
  const authorizedKey = authorizedPlanKey(event.id, event.userRevision, state.plan.version);
  const authorized = ports.store.get<WorkflowPlan>(AUTHORIZED_PLANS, authorizedKey);
  // Deep equality with the accepted plan is the recovery contract: a restart
  // after commit must reproduce the exact authorized plan, not a new draft.
  if (authorized) return JSON.parse(JSON.stringify(authorized)) as WorkflowPlan;
  const choiceId = `${event.id}:planning:choice:${newId("attempt")}`;
  const planRecordKey = `${event.id}:plan:${state.plan.version}`;
  const PLANNING_PLANS = "workflow_planning_plans";
  // Deferrals refund retry attempts; each later evidence-based evaluation still
  // needs its own audit identity so an earlier wait is never overwritten.
  const logId = `${event.id}:planning:${newId("attempt")}`;
  const actor = {
    source: "system" as const,
    ownerId: task.ownerId,
    chatId: task.chatId ?? task.entryChatId,
    sessionId: `orchestration:${task.id}`,
    taskId: task.id,
    messageId: event.id,
  };
  task = {
    ...task,
    participantIds: ports
      .tasks()
      .records.participants(task)
      .filter((entry) => entry.status !== "removed")
      .map((entry) => entry.id),
  };
  const template = {
    ...templatePlan(task, task.orchestration?.template),
    version: state.plan.version,
  };
  const userMessages = ports.userMessages(task);
  const sources = planningSources(
    task,
    [],
    userMessages.map(({ id, text }) => ({ id, text })),
  );
  const contractSource = latestContractInput(ports.store, task, userMessages);
  // Selection sees the inherited obligations, so use_template cannot silently revoke them.
  compileWorkflowContract({
    plan: template,
    previous: state.plan,
    participantIds: task.participantIds,
    sources,
  });
  const simpleDiscussion =
    task.promptVersion === 3 && task.kind === "discussion" && state.plan.version === 1;
  // Auxiliary authorization: template-mode selection stays a choice over
  // program-computed candidates, executed inside the same durable Leader
  // envelope as every other model call for this task.
  const templateChoice = createLeaderTemplateChoice({
    store: ports.store,
    engine: ports.engine,
    actor,
    // One durable identity per planning attempt: the existing deferral logic
    // still decides when a new attempt is warranted.
    eventId: choiceId,
    revision: event.userRevision,
  });
  // New (promptVersion 3) tasks create plans inside their durable Leader
  // session under a bounded prompt; frozen v2 tasks keep their original
  // one-shot planning call. Plan validation and authorization verifiers are
  // identical on both paths.
  const leader =
    task.promptVersion === 3
      ? createPlanningLeaderBridge({
          store: ports.store,
          engine: ports.engine,
          task,
          state,
          eventId: `${event.id}:planning`,
          revision: event.userRevision,
          userMessages: userMessages.map((entry) => entry.text),
          // A plan accepted by an earlier activation of this planning step is
          // recovered from durable storage instead of being re-planned.
          completedPlan: () => ports.store.get(PLANNING_PLANS, planRecordKey),
          recordPlan: (plan) => {
            ports.store.set(PLANNING_PLANS, planRecordKey, plan);
          },
          assertCurrent: () => {
            ports.assertCurrent(event);
          },
        })
      : undefined;
  let useTemplate = false;
  let useDocumentTemplate = false;
  let useConsensusTemplate = false;
  if (task.promptVersion === 3) {
    const assessment = await assessPlanningAssistance({
      engine: ports.engine,
      actor,
      // Same task-Leader session namespace as the durable Leader so no model
      // call for this task is attributed to an outer or foreign session; the
      // surface stays the restricted auxiliary chooser.
      sessionId: `task-leader:${task.id}:planning-choice`,
      simpleDiscussion,
      snapshot: {
        userRequest: task.userRequest?.text ?? task.requirements,
        requirements: task.requirements,
        userMessages: userMessages.map((entry) => entry.text),
        sources,
        contractChangeSource: contractSource,
        contractChangePolicy:
          "已有文档和共同认可默认继承。最新真实输入明确撤销时必须 request_pi，由 pi 提交 contractChange 并另行核验；use_template 始终保留已有合同。",
        template,
        previousPlan: state.plan,
        reason: state.planningReason,
        issues: state.issues,
      },
      signal: ports.signal,
      assertCurrent: () => {
        ports.assertCurrent(event);
      },
      onLog: (log) => {
        ports.store.set("workflow_planning_decisions", logId, log);
      },
      leader: templateChoice,
    });
    if (assessment.decision === "cancelled") fail("cancelled", "规划判断已取消。");
    if (assessment.decision === "deferred")
      fail("workflow_assistance_deferred", "pi 未能确定合法计划，等待更多依据或用户裁决。");
    useConsensusTemplate = assessment.decision === "use_consensus_document_template";
    useDocumentTemplate = assessment.decision === "use_document_template" || useConsensusTemplate;
    useTemplate = assessment.decision === "use_template" || useDocumentTemplate;
  }
  if (useDocumentTemplate) {
    const source = sources.at(-1);
    if (!source) fail("workflow_scope", "默认文档模式缺少可核对的真实用户原文。");
    template.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: source.text };
    addDocumentDelivery(template);
    if (useConsensusTemplate && !template.consensus)
      compileConsensus(template, task.participantIds);
  }
  const plan = useTemplate
    ? template
    : await planWorkflow({
        task: {
          ...task,
          participantIds: ports
            .tasks()
            .records.participants(task)
            .filter((entry) => entry.status !== "removed")
            .map((entry) => entry.id),
        },
        state,
        engine: ports.engine,
        actor: {
          source: "system",
          ownerId: task.ownerId,
          chatId: task.chatId ?? task.entryChatId,
          sessionId: `orchestration:${task.id}`,
          taskId: task.id,
          messageId: event.id,
        },
        userMessages: userMessages.map((entry) => entry.text),
        sources,
        contractSource,
        simpleDiscussion,
        audit: { store: ports.store, id: logId, taskId: task.id, planVersion: state.plan.version },
        signal: ports.signal,
        ...(leader ? { leader } : {}),
        assertCurrent: () => {
          ports.assertCurrent(event);
        },
      });
  await authorizeContractChange({
    store: ports.store,
    id: logId,
    task,
    previous: state.plan,
    plan,
    userMessages,
    engine: ports.engine,
    actor,
    signal: ports.signal,
    assertCurrent: () => {
      ports.assertCurrent(event);
    },
  });
  await authorizeDocumentDelivery({
    task,
    plan,
    userMessages: ports.userMessages(task).map((entry) => entry.text),
    engine: ports.engine,
    actor,
    signal: ports.signal,
    assertCurrent: () => {
      ports.assertCurrent(event);
    },
    onDecision: (decision) => {
      ports.store.set("workflow_document_decisions", logId, decision);
    },
  });
  // Only a fully authorized plan is recorded for recovery.
  ports.store.set(AUTHORIZED_PLANS, authorizedKey, JSON.parse(JSON.stringify(plan)));
  return plan;
}
