import type { WebState } from "../contracts.js";
import type { Action } from "./api.js";
import { actions, button, check, closeModal, el, field, modal, select } from "./dom.js";
import { discussionParents, taskContextFields } from "./task-context.js";

export function participantFields(container: HTMLElement, initialKind = "codex") {
  const row = el("div", "participant-row");
  const kind = select(
    "",
    [
      ["codex", "Codex"],
      ["claude", "Claude"],
    ],
    initialKind,
  ).input;
  kind.setAttribute("aria-label", "参与者类型");
  const name = el("input");
  name.placeholder = "参与者名称（可选）";
  name.setAttribute("aria-label", "参与者名称");
  const role = el("input");
  role.placeholder = "职责，如方案评审";
  role.setAttribute("aria-label", "参与者职责");
  row.append(
    kind,
    name,
    role,
    button("移除", () => row.remove(), "small danger"),
  );
  container.append(row);
  return () =>
    row.isConnected
      ? {
          kind: kind.value,
          name: name.value.trim() || undefined,
          role: role.value.trim() || undefined,
        }
      : undefined;
}

export function createTaskForm(state: WebState, action: Action): void {
  const body = modal("创建任务");
  const title = field("任务标题");
  title.input.required = true;
  const requirements = field(
    "本次完整要求",
    "",
    "textarea",
    "完整要求将传给参与者。关联讨论只提供背景，不会自动授权开发或代替本次要求。",
  );
  requirements.input.required = true;
  const kind = select("任务类型", [
    ["discussion", "讨论"],
    ["development", "开发"],
    ["review", "评审"],
    ["test", "测试"],
  ]);
  const projects = state.catalog?.projects ?? state.projects ?? [];
  const projectMode = select(
    "项目方式",
    [
      ["existing", "使用已有项目"],
      ["new", "新建项目"],
      ["none", "无项目讨论"],
    ],
    projects.length ? "existing" : "none",
  );
  const project = select("已有项目", [
    [
      "",
      state.catalog?.defaultProject ? `默认：${state.catalog.defaultProject}` : "请选择已有项目",
    ],
    ...projects.map((item): [string, string] => [item.name, item.name]),
  ]);
  const newProject = field(
    "新项目名称",
    "",
    "text",
    "将新建项目目录并初始化 Git；已有同名目录不会被覆盖。",
  );
  const projectDetails = el("div", "stack");
  const updateProjectFields = () => {
    const none = [...projectMode.input.options].find((option) => option.value === "none");
    if (none) none.disabled = kind.input.value !== "discussion";
    if (kind.input.value !== "discussion" && projectMode.input.value === "none")
      projectMode.input.value = "existing";
    projectDetails.replaceChildren(
      projectMode.input.value === "new"
        ? newProject.wrapper
        : projectMode.input.value === "existing"
          ? project.wrapper
          : el("p", "subtle", "讨论使用独立目录，不登记新项目。"),
    );
  };
  projectMode.input.addEventListener("change", updateProjectFields);
  kind.input.addEventListener("change", updateProjectFields);
  updateProjectFields();
  const parent = select("关联先前讨论（可选）", [
    ["", "不关联"],
    ...discussionParents(state).map((task): [string, string] => [
      task.id,
      `${task.title} · ${task.id}`,
    ]),
  ]);
  parent.wrapper.append(
    el("small", "", "沿用所选讨论的背景与已有结论。请在下方明确本次任务和所有约束。"),
  );
  const sessions = (state.sessions ?? []).filter((item) => !item.archived && !item.taskId);
  const session = select(
    "调度会话",
    sessions.length
      ? sessions.map((item): [string, string] => [item.id, item.name])
      : [["", "请先新建独立调度会话"]],
    sessions.find((item) => item.id === state.activeSessionId)?.id ?? sessions[0]?.id,
  );
  const directories = select("代码目录模式", [
    ["shared", "共享项目目录"],
    ["worktree", "独立 Git worktree"],
  ]);
  const keepGroup = check("任务完成后保留讨论群", true);
  const group = check("创建飞书任务群", true);
  const remote = check("同步创建飞书任务", true);
  const mode = select(
    "讨论方式",
    [
      ["manual", "手动指定发言"],
      ["round_robin", "按参与者轮流发言"],
    ],
    "round_robin",
  );
  const maxRounds = field("最多轮数", "4", "number");
  const maxMinutes = field("最多分钟", "30", "number");
  for (const [item, max] of [
    [maxRounds, "50"],
    [maxMinutes, "240"],
  ] as const)
    if (item.input instanceof HTMLInputElement) {
      item.input.min = "1";
      item.input.max = max;
    }
  const row = el("div", "form-row");
  row.append(kind.wrapper, projectMode.wrapper);
  const secondary = el("div", "form-row");
  secondary.append(session.wrapper, directories.wrapper);
  const participants = el("div", "stack");
  const getters = [
    participantFields(participants, "claude"),
    participantFields(participants, "codex"),
  ];
  const limits = el("div", "form-row");
  limits.append(maxRounds.wrapper, maxMinutes.wrapper);
  body.append(
    title.wrapper,
    row,
    projectDetails,
    secondary,
    parent.wrapper,
    requirements.wrapper,
    el("h3", "", "参与者与职责"),
    participants,
    button(
      "＋ 添加参与者",
      () => {
        getters.push(participantFields(participants));
      },
      "small",
    ),
    el("div", "divider"),
    mode.wrapper,
    limits,
    keepGroup.wrapper,
    group.wrapper,
    remote.wrapper,
  );
  const validation = el("div");
  body.append(validation);
  body.append(
    actions(
      button("取消", closeModal),
      button(
        "创建并调度",
        async () => {
          validation.replaceChildren();
          if (!title.input.value.trim() || !requirements.input.value.trim()) {
            title.input.reportValidity();
            requirements.input.reportValidity();
            return;
          }
          if (!maxRounds.input.reportValidity() || !maxMinutes.input.reportValidity()) return;
          if (!session.input.value) {
            validation.append(el("p", "notice error", "请先在会话页创建或恢复一个独立调度会话。"));
            return;
          }
          const members = getters.map((get) => get()).filter(Boolean);
          if (!members.length) {
            validation.append(el("p", "notice error", "请至少添加一位参与者。"));
            return;
          }
          let context: ReturnType<typeof taskContextFields>;
          try {
            context = taskContextFields(
              {
                kind: kind.input.value,
                projectMode: projectMode.input.value,
                existingProject: project.input.value,
                newProjectName: newProject.input.value,
                parentTaskId: parent.input.value,
                requirements: requirements.input.value,
              },
              state,
            );
          } catch (error) {
            validation.append(
              el(
                "p",
                "notice error",
                error instanceof Error ? error.message : "任务项目与关联讨论无效。",
              ),
            );
            return;
          }
          if (
            await action("task.create", {
              sessionId: session.input.value,
              kind: kind.input.value,
              title: title.input.value.trim(),
              ...context,
              participants: members,
              directoryMode: directories.input.value,
              keepGroup: keepGroup.input.checked,
              createGroup: group.input.checked,
              createRemoteTask: remote.input.checked,
              discussion: {
                mode: mode.input.value,
                maxRounds: Number(maxRounds.input.value),
                maxMinutes: Number(maxMinutes.input.value),
              },
            })
          )
            closeModal();
        },
        "primary",
      ),
    ),
  );
}
