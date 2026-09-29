import type { OrchestrationEvent } from "../app/task-orchestrator.js";
import { fail } from "../core/errors.js";
import { newId } from "../core/ids.js";
import type { Task } from "../core/types.js";
import { assessPlanningAssistance } from "./assistance.js";
import { authorizeDocumentDelivery } from "./document-delivery.js";
import { planWorkflow } from "./planner.js";
import type { WorkflowPorts } from "./runner.js";
import { templatePlan } from "./templates.js";
import type { WorkflowPlan, WorkflowState } from "./workflow.js";

export async function choosePlan(
  ports: WorkflowPorts,
  task: Task,
  state: WorkflowState,
  event: OrchestrationEvent,
): Promise<WorkflowPlan> {
  // Deferrals refund retry attempts; each later evidence-based evaluation still
  // needs its own audit identity so an earlier wait is never overwritten.
  const logId = `${event.id}:planning:${newId("attempt")}`;
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
  let useTemplate = false;
  if (task.promptVersion === 3) {
    const assessment = await assessPlanningAssistance({
      jev: ports.config?.jev,
      snapshot: {
        userRequest: task.userRequest?.text ?? task.requirements,
        requirements: task.requirements,
        userMessages: ports.userMessages(task).map((entry) => entry.text),
        template,
        previousPlan: state.plan,
        reason: state.planningReason,
        issues: state.issues,
      },
      signal: ports.signal,
      fetch: ports.fetch,
      assertCurrent: () => {
        ports.assertCurrent(event);
      },
      onLog: (log) => {
        ports.store.set("workflow_planning_decisions", logId, log);
      },
    });
    if (assessment.decision === "cancelled") fail("cancelled", "规划判断已取消。");
    if (assessment.decision === "deferred")
      fail("workflow_assistance_deferred", "Jev 需要更多依据判断计划，也未请求 pi 协助。");
    useTemplate = assessment.decision === "use_template";
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
        userMessages: ports.userMessages(task).map((entry) => entry.text),
        signal: ports.signal,
        assertCurrent: () => {
          ports.assertCurrent(event);
        },
      });
  await authorizeDocumentDelivery({
    task,
    plan,
    userMessages: ports.userMessages(task).map((entry) => entry.text),
    jev: ports.config?.jev,
    signal: ports.signal,
    fetch: ports.fetch,
    assertCurrent: () => {
      ports.assertCurrent(event);
    },
    onDecision: (decision) => {
      ports.store.set("workflow_document_decisions", logId, decision);
    },
  });

  return plan;
}
