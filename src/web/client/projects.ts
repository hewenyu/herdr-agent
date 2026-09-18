import type { Project } from "../../core/types.js";
import type { WebState } from "../contracts.js";
import type { Action } from "./api.js";
import {
  actions,
  ask,
  button,
  check,
  closeModal,
  el,
  empty,
  field,
  heading,
  modal,
  select,
} from "./dom.js";

function editProject(action: Action, project?: Project) {
  const body = modal(project ? "编辑项目" : "添加项目");
  const name = field("项目名称", project?.name);
  name.input.required = true;
  if (project) name.input.readOnly = true;
  const directories = field(
    "项目目录",
    project?.directories.join("\n"),
    "textarea",
    "每行一个绝对路径，第一项为主目录。目录顺序会用于执行环境。",
  );
  const agent = select(
    "默认参与者",
    [
      ["claude", "Claude"],
      ["codex", "Codex"],
    ],
    project?.agent ?? "codex",
  );
  body.append(
    name.wrapper,
    directories.wrapper,
    agent.wrapper,
    actions(
      button("取消", closeModal),
      button(
        "保存项目",
        async () => {
          if (!name.input.value.trim() || !directories.input.value.trim()) {
            name.input.reportValidity();
            return;
          }
          if (
            await action("project.save", {
              name: name.input.value.trim(),
              directories: directories.input.value
                .split("\n")
                .map((path) => path.trim())
                .filter(Boolean),
              agent: agent.input.value,
            })
          )
            closeModal();
        },
        "primary",
      ),
    ),
  );
}

export function renderProjects(state: WebState, action: Action): HTMLElement {
  const root = el("div", "stack");
  const projects = state.catalog?.projects ?? state.projects ?? [];
  root.append(
    heading(
      "项目与执行环境",
      "配置可调度的项目目录。编码会话始终由 herdr 托管。",
      button("＋ 添加项目", () => editProject(action), "primary"),
    ),
  );
  const grid = el("div", "grid");
  for (const project of projects) {
    const card = el("article", "card");
    const top = el("div", "card-top");
    top.append(
      el("span", "card-title", project.name),
      el(
        "span",
        "badge",
        project.name === state.catalog?.defaultProject ? "默认项目" : project.agent,
      ),
    );
    card.append(
      top,
      el("p", "directory", project.directories.join("\n")),
      actions(
        button("编辑", () => editProject(action, project), "small"),
        button(
          "设为默认",
          async () => {
            await action("project.default", { name: project.name });
          },
          "small",
        ),
        button(
          "删除配置",
          () =>
            ask(
              "删除项目配置",
              `仅移除“${project.name}”的配置，不删除代码目录。已有任务是否允许删除由当前状态检查。`,
              async () => Boolean(await action("project.delete", { name: project.name })),
            ),
          "small danger",
        ),
      ),
    );
    grid.append(card);
  }
  root.append(
    projects.length
      ? grid
      : empty("还没有项目", "添加本机仓库路径，即可创建开发、讨论或评审任务。"),
  );
  const settings = el("section", "panel");
  settings.append(
    heading("原生权限模式", "Bypass 会跳过编码 agent 自身的权限确认，仅在你明确需要时启用。"),
  );
  const bypass = check("为新任务启用 Bypass", state.catalog?.bypass ?? false);
  settings.append(
    bypass.wrapper,
    button("保存模式", async () => {
      const save = async () =>
        Boolean(await action("catalog.bypass", { bypass: bypass.input.checked }));
      if (bypass.input.checked)
        ask("启用 Bypass", "新建任务将使用原生跳过审批参数。现有执行会话的模式不因此改变。", save);
      else await save();
    }),
  );
  root.append(settings);
  return root;
}

export function renderSettings(state: WebState, action: Action): HTMLElement {
  const root = el("section", "panel");
  root.append(
    heading("模型连接", "用于 pi 调度的模型配置。密钥只在本机保存，页面不会读取已保存的明文。"),
  );
  const model = select(
    "接口协议",
    [
      ["openai-responses", "OpenAI Responses"],
      ["anthropic-messages", "Anthropic Messages"],
    ],
    state.model?.provider ?? state.config?.ai?.api,
  );
  const baseUrl = field(
    "Base URL",
    state.model?.baseUrl ?? state.config?.ai?.baseUrl ?? "",
    "text",
    "留空使用对应提供商的默认地址。",
  );
  const modelId = field("模型 ID", state.model?.model ?? state.config?.ai?.model ?? "");
  const enabled = check("启用 pi 调度助手", state.model?.enabled ?? true);
  const apiKey = field("API Key", "", "password", "留空保留已保存的密钥。不要将密钥填入聊天内容。");
  if (apiKey.input instanceof HTMLInputElement) apiKey.input.autocomplete = "new-password";
  if (
    state.model?.keyConfigured ||
    state.config?.ai?.apiKeyConfigured ||
    state.config?.ai?.apiKeyMasked
  )
    apiKey.input.placeholder = "已保存密钥（留空保留）";
  root.append(
    enabled.wrapper,
    model.wrapper,
    baseUrl.wrapper,
    modelId.wrapper,
    apiKey.wrapper,
    button(
      "保存模型连接",
      async () => {
        const input: Record<string, unknown> = {
          provider: model.input.value,
          enabled: enabled.input.checked,
          baseUrl: baseUrl.input.value.trim(),
          model: modelId.input.value.trim(),
        };
        if (apiKey.input.value) input.apiKey = apiKey.input.value;
        if (await action("config.ai", input)) apiKey.input.value = "";
      },
      "primary",
    ),
  );
  const info = el("div", "divider");
  root.append(
    info,
    el(
      "p",
      "subtle",
      `当前服务：${state.runtime?.message ?? state.runtime?.status ?? "本机连接正常"}`,
    ),
  );
  return root;
}
