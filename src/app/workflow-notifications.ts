import type { Participant, Task } from "../core/types.js";
import { WORKFLOWS, type WorkflowState } from "../orchestration/workflow.js";
import type { Store } from "../storage/store.js";

export const quietWorkflow = (task: Task): boolean =>
  task.orchestration?.mode === "workflow" && task.promptVersion === 3;

/** v3 only sends lifecycle facts that need attention, with no background pi turn. */
export function workflowNotice(
  task: Task,
  kind: string,
  participants: Participant[],
  store: Store,
): { notify: boolean; text: string } {
  const silent = { notify: false, text: "" };
  if (kind === "welcome")
    return {
      notify: true,
      text: `任务「${task.title}」已登记。参与者的过程交流保存在任务记录中，最终产物会发到这里；可随时询问进度。`,
    };
  if (kind !== "progress") return silent;
  const state = store.get<WorkflowState>(WORKFLOWS, task.id);
  if (state?.stall.awaitingUser)
    return {
      notify: true,
      text: `「${task.title}」需要你裁决：${
        state.issues
          .filter((issue) => issue.status === "open" && issue.blocking)
          .map((issue) => issue.description)
          .join("；")
          .slice(0, 1200) || "讨论中的未决问题持续没有变化。"
      }`,
    };
  if (task.status === "attention" && task.error)
    return {
      notify: true,
      text: `「${task.title}」需要处理：${task.error.slice(0, 1200)}`,
    };
  if (participants.some((participant) => participant.error))
    return {
      notify: true,
      text: `「${task.title}」需要处理：${participants
        .filter((participant) => participant.error)
        .map((participant) => `${participant.name}：${participant.error}`)
        .join("；")
        .slice(0, 1200)}`,
    };
  // Native blocked menus are handled by automatic approval or its own actionable card.
  return silent;
}
