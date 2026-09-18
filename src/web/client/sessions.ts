import type { Session } from "../../core/types.js";
import type { WebState } from "../contracts.js";
import type { Action } from "./api.js";
import { actions, ask, button, closeModal, el, empty, field, heading, modal, time } from "./dom.js";

const drafts = new Map<string, string>();

export function sessionEditor(action: Action, session?: Session): void {
  const body = modal(session ? "重命名会话" : "新建 pi 调度会话");
  const name = field("会话名称", session?.name ?? "新会话");
  body.append(
    name.wrapper,
    el("p", "subtle", "pi 管理任务与参与者。项目需求和技术方案由 Claude / Codex 参与讨论。"),
  );
  body.append(
    actions(
      button("取消", closeModal),
      button(
        "保存",
        async () => {
          if (!name.input.value.trim()) return;
          const result = await action(session ? "session.rename" : "session.create", {
            ...(session ? { id: session.id } : {}),
            name: name.input.value.trim(),
          });
          if (result) closeModal();
        },
        "primary",
      ),
    ),
  );
}

export function renderSessions(
  state: WebState,
  action: Action,
  selectLocal: (id: string) => void,
  archived: boolean,
  showArchived: () => void,
): HTMLElement {
  const root = el("div", "stack");
  root.append(
    heading(
      "调度会话",
      "将任务交给合适的参与者，让讨论与执行都有明确的上下文。",
      button(archived ? "活动会话" : "查看归档", showArchived),
      button("＋ 新建会话", () => sessionEditor(action), "primary"),
    ),
  );
  const sessions = (state.sessions ?? []).filter((session) => session.archived === archived);
  if (!sessions.length) {
    root.append(
      empty(
        archived ? "没有归档会话" : "从一个新会话开始",
        "例如：让 Claude 和 Codex 一起讨论登录方案，然后交给 Codex 实现。",
      ),
    );
    return root;
  }
  const selected = sessions.find((session) => session.id === state.activeSessionId) ?? sessions[0];
  if (!selected) return root;
  const split = el("div", "split");
  const list = el("div", "list");
  for (const session of sessions) {
    const item = el("button", `list-item ${session.id === selected.id ? "active" : ""}`);
    item.type = "button";
    item.append(el("strong", "", session.name), el("small", "", time(session.updatedAt)));
    item.addEventListener("click", async () => {
      selectLocal(session.id);
      if (!session.archived) await action("session.select", { id: session.id });
      else await action("session.history", { id: session.id });
    });
    list.append(item);
  }
  const panel = el("section", "panel");
  panel.append(
    heading(
      selected.name,
      selected.taskId ? "关联任务的调度上下文" : "独立调度上下文",
      button("重命名", () => sessionEditor(action, selected), "small"),
    ),
  );
  const messages = (state.messages ?? []).filter((message) => message.sessionId === selected.id);
  const history = el("div", "message-list");
  if (selected.archived && state.messages === undefined)
    history.append(empty("正在读取会话历史", "归档历史加载后会显示在这里。"));
  else if (!messages.length)
    history.append(empty("会话已准备好", "输入调度要求，或到任务页创建一个讨论任务。"));
  for (const message of messages) {
    const bubble = el("article", `message ${message.role}`);
    if (["assistant", "participant"].includes(message.role) && message.delivery !== "delivered") {
      bubble.dataset.deliveryMessageId = message.id;
      bubble.dataset.deliverySessionId = selected.id;
    }
    const participant = state.participants?.find((item) => item.id === message.participantId);
    const who =
      message.role === "user"
        ? "你"
        : message.role === "participant"
          ? (participant?.name ?? "参与者")
          : message.role === "assistant"
            ? "pi · 调度"
            : "系统";
    bubble.append(
      el("span", "message-label", `${who} · ${time(message.createdAt)}`),
      document.createTextNode(message.text),
    );
    if (message.delivery !== "delivered")
      bubble.append(
        el(
          "p",
          "subtle",
          message.delivery === "uncertain"
            ? "送达未知，请核对后再决定是否补发。"
            : `回执：${message.delivery}`,
        ),
      );
    history.append(bubble);
  }
  panel.append(history);
  if (selected.archived) {
    panel.append(
      button(
        "恢复会话",
        async () => {
          await action("session.restore", { id: selected.id });
        },
        "primary",
      ),
    );
  } else {
    const composer = el("form", "composer");
    const input = field(
      "给 pi 的调度要求",
      drafts.get(selected.id) ?? "",
      "textarea",
      "Enter 换行；点击发送或 Ctrl / ⌘ + Enter 提交。",
    );
    input.input.placeholder = "例如：创建一个讨论任务，让 Claude 设计方案，Codex 评审。";
    input.input.addEventListener("input", () => drafts.set(selected.id, input.input.value));
    const send = async () => {
      const text = input.input.value.trim();
      if (!text) return;
      drafts.delete(selected.id);
      input.input.disabled = true;
      try {
        if (await action("chat.send", { sessionId: selected.id, text })) input.input.value = "";
        else drafts.set(selected.id, text);
      } finally {
        input.input.disabled = false;
      }
    };
    const submit = button("发送要求 →", send, "primary");
    input.input.addEventListener("keydown", (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (!input.input.disabled) void send();
      }
    });
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
    });
    composer.append(input.wrapper, actions(submit));
    panel.append(composer);
    panel.append(
      el("div", "divider"),
      actions(
        button(
          "清空调度上下文",
          () =>
            ask(
              "清空当前 pi 上下文",
              "本操作开启新的调度上下文。已有任务、参与者和 herdr 托管的编码 session 不会清除。",
              async () => Boolean(await action("session.clear", { id: selected.id })),
            ),
          "small",
        ),
        button(
          "归档会话",
          () =>
            ask("归档当前会话", "会话从活动列表移入归档；任务与执行现场独立保留。", async () =>
              Boolean(await action("session.archive", { id: selected.id })),
            ),
          "small",
        ),
      ),
    );
  }
  split.append(list, panel);
  root.append(split);
  return root;
}
