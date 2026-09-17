import type { WebState } from "../contracts.js";
import type { Action } from "./api.js";
import { actions, button, check, closeModal, el, field, modal, select } from "./dom.js";

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
    "完整要求",
    "",
    "textarea",
    "需求内容将传给参与者；pi 只负责组织本工具的任务流程。",
  );
  requirements.input.required = true;
  const kind = select("任务类型", [
    ["discussion", "讨论"],
    ["development", "开发"],
    ["review", "评审"],
    ["test", "测试"],
  ]);
  const projects = state.catalog?.projects ?? state.projects ?? [];
  const project = select("项目", [
    ["", "使用默认项目 / 无项目讨论"],
    ...projects.map((item): [string, string] => [item.name, item.name]),
  ]);
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
  row.append(kind.wrapper, project.wrapper);
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
    secondary,
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
  body.append(
    actions(
      button("取消", closeModal),
      button(
        "创建并调度",
        async () => {
          if (!title.input.value.trim() || !requirements.input.value.trim()) {
            title.input.reportValidity();
            requirements.input.reportValidity();
            return;
          }
          if (!maxRounds.input.reportValidity() || !maxMinutes.input.reportValidity()) return;
          if (!session.input.value) {
            body.append(el("p", "notice error", "请先在会话页创建或恢复一个独立调度会话。"));
            return;
          }
          const members = getters.map((get) => get()).filter(Boolean);
          if (!members.length) {
            body.append(el("p", "notice error", "请至少添加一位参与者。"));
            return;
          }
          if (
            await action("task.create", {
              sessionId: session.input.value,
              kind: kind.input.value,
              title: title.input.value.trim(),
              requirements: requirements.input.value.trim(),
              ...(project.input.value ? { project: project.input.value } : {}),
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
