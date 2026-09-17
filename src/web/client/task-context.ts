import type { TaskCreateInput } from "../../core/types.js";
import type { WebState } from "../contracts.js";

export interface TaskContextInput {
  kind: string;
  projectMode: string;
  existingProject: string;
  newProjectName: string;
  parentTaskId: string;
  requirements: string;
}

/** A stale or mixed snapshot must never offer another owner's discussion as a parent. */
export function discussionParents(state: WebState) {
  if (!state.activeOwnerId) return [];
  return (state.tasks ?? []).filter(
    (task) => task.kind === "discussion" && task.ownerId === state.activeOwnerId,
  );
}

/** Only the explicitly selected project mode contributes fields to the request. */
export function taskContextFields(
  input: TaskContextInput,
  state: WebState,
): Pick<TaskCreateInput, "project" | "newProject" | "parentTaskId" | "requirements"> {
  const requirements = input.requirements.trim();
  if (!requirements) throw new Error("请填写本次完整要求；关联讨论不能代替本次指令。");
  const result: Pick<TaskCreateInput, "project" | "newProject" | "parentTaskId" | "requirements"> =
    {
      requirements,
    };
  const projects = state.catalog?.projects ?? state.projects ?? [];
  if (input.projectMode === "new") {
    const name = input.newProjectName.trim();
    if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(name))
      throw new Error("新项目名称须为 1–80 个文字、数字、下划线或连字符。");
    if (projects.some((project) => project.name === name))
      throw new Error("同名项目已登记，请选择使用已有项目或填写新名称。");
    result.project = name;
    result.newProject = true;
  } else if (input.projectMode === "existing") {
    const name = input.existingProject || state.catalog?.defaultProject;
    if (!name || !projects.some((project) => project.name === name))
      throw new Error("请选择已登记项目，或明确选择新建项目。");
    result.project = name;
  } else if (input.projectMode === "none") {
    if (input.kind !== "discussion") throw new Error("仅讨论任务可不选择项目。");
  } else throw new Error("请选择项目方式。");
  if (input.parentTaskId) {
    if (!discussionParents(state).some((task) => task.id === input.parentTaskId))
      throw new Error("关联讨论不属于当前身份或已不可选，请刷新后重新选择。");
    result.parentTaskId = input.parentTaskId;
  }
  return result;
}
