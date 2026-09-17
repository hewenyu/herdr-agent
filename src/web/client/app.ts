import type { StoredMessage } from "../../core/types.js";
import type { WebState } from "../contracts.js";
import { type Action, dispatch, state as fetchState } from "./api.js";
import { displayThenAcknowledge } from "./delivery.js";
import { button, el } from "./dom.js";
import { renderProjects, renderSettings } from "./projects.js";
import { renderSessions } from "./sessions.js";
import { renderTasks } from "./tasks.js";

type Tab = "sessions" | "tasks" | "projects" | "settings";
const tabs: Array<[Tab, string]> = [
  ["sessions", "会话"],
  ["tasks", "任务"],
  ["projects", "项目"],
  ["settings", "设置"],
];
let currentTab: Tab = "sessions";
let current: WebState = {};
let activeSession = "";
let activeTask = "";
let archived = false;
let refreshing = false;
let pending = false;
const historyBySession = new Map<string, StoredMessage[]>();
const acknowledgements = new Set<string>();

function node<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`页面缺少 ${selector}`);
  return found;
}

function feedback(message: string, error = false) {
  const area = node("#feedback");
  area.replaceChildren(el("div", `notice ${error ? "error" : "good"}`, message));
}

async function acknowledge(
  messageId: string,
  sessionId: string,
  display = () => {},
  quiet = false,
): Promise<void> {
  acknowledgements.add(messageId);
  await displayThenAcknowledge(
    display,
    async () => {
      await dispatch("chat.ack", { messageId, sessionId });
      if (!quiet) feedback("回复已显示，送达确认已保存。");
      await refresh(true);
    },
    () => {
      feedback(
        `回复已显示，但送达确认尚未保存。消息 ID：${messageId}。请重试确认，不要重发原消息。`,
        true,
      );
      node("#feedback").append(
        button("重试送达确认", () => acknowledge(messageId, sessionId), "small"),
      );
    },
  );
}

const action: Action = async (name, input) => {
  try {
    const result = await dispatch(name, input);
    if (name === "session.history" && Array.isArray(result)) {
      current.messages = result as StoredMessage[];
      if (typeof input.id === "string") historyBySession.set(input.id, current.messages);
      render();
      return {};
    }
    if (["session.create", "session.select", "session.restore"].includes(name) && result.id) {
      activeSession = result.id;
      archived = false;
    }
    if (name === "session.archive") activeSession = "";
    if (result.sessionId) activeSession = result.sessionId;
    if (name === "chat.send" && result.id && result.sessionId && typeof result.text === "string") {
      // Rendering the returned payload precedes acknowledgement; HTTP success alone is not delivery.
      current.messages = [
        ...(current.messages ?? []).filter((message) => message.id !== result.id),
        {
          id: result.id,
          sessionId: result.sessionId,
          role: result.role ?? "assistant",
          text: result.text,
          createdAt: result.createdAt ?? new Date().toISOString(),
          source: result.source ?? "web",
          delivery: result.delivery ?? "sending",
          deliveryIds: result.deliveryIds ?? [],
          generation: result.generation ?? 0,
        },
      ];
      currentTab = "sessions";
      await acknowledge(result.id, result.sessionId, render);
      return result;
    }
    feedback(
      result.detail ??
        result.message ??
        (result.status === "unconfirmed"
          ? "操作结果尚未确认，请核对任务与执行现场，勿重复提交。"
          : "操作请求已处理，状态将自动刷新。"),
      result.status === "unconfirmed",
    );
    await refresh(true);
    return result;
  } catch (error) {
    feedback(error instanceof Error ? error.message : "操作未完成，请核对当前状态。", true);
    await refresh(false);
    return undefined;
  }
};

function renderAuthorization() {
  const area = node("#authorization");
  area.replaceChildren();
  const auth = current.authorization;
  if (!auth || ["ready", "authorized", "ok"].includes(auth.status)) return;
  const notice = el(
    "div",
    "notice",
    auth.message ??
      "请完成飞书 setup 和用户白名单设置后使用会话与任务；项目和模型连接仍可在本机配置。",
  );
  if (auth.url && /^https:\/\//.test(auth.url)) {
    const link = el("a", "button small", "打开授权页面 ↗");
    link.href = auth.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    notice.append(el("br"), link);
  }
  area.append(notice);
}

function render() {
  const nav = node("#navigation");
  nav.replaceChildren();
  for (const [key, label] of tabs)
    nav.append(
      button(
        label,
        () => {
          currentTab = key;
          render();
        },
        currentTab === key ? "active" : "",
      ),
    );
  node("#page-title").textContent = tabs.find(([key]) => key === currentTab)?.[1] ?? "工作台";
  renderAuthorization();
  const viewState = { ...current, activeSessionId: activeSession || current.activeSessionId };
  const content =
    currentTab === "sessions"
      ? renderSessions(
          viewState,
          action,
          (id) => {
            activeSession = id;
            render();
          },
          archived,
          () => {
            archived = !archived;
            render();
          },
        )
      : currentTab === "tasks"
        ? renderTasks(viewState, action, activeTask, (id) => {
            activeTask = id;
            render();
          })
        : currentTab === "projects"
          ? renderProjects(viewState, action)
          : renderSettings(viewState, action);
  node("#content").replaceChildren(content);
  // Only messages actually attached to the visible session view count as delivered.
  if (currentTab === "sessions") {
    for (const bubble of content.querySelectorAll<HTMLElement>("[data-delivery-message-id]")) {
      const messageId = bubble.dataset.deliveryMessageId;
      const sessionId = bubble.dataset.deliverySessionId;
      if (messageId && sessionId && !acknowledgements.has(messageId)) {
        void acknowledge(messageId, sessionId, undefined, true);
      }
    }
  }
}

async function refresh(force: boolean) {
  if (refreshing) {
    pending = true;
    return;
  }
  refreshing = true;
  try {
    current = await fetchState();
    if (archived && activeSession && historyBySession.has(activeSession)) {
      current.messages = historyBySession.get(activeSession);
    }
    node("#connection").textContent = "● 本机已连接";
    const editing = document.activeElement?.matches("input,textarea,select") ?? false;
    if (force || !editing) render();
  } catch (error) {
    node("#connection").textContent = "连接中断 · 等待恢复";
    if (force) feedback(error instanceof Error ? error.message : "读取状态失败", true);
  } finally {
    refreshing = false;
    if (pending) {
      pending = false;
      void refresh(false);
    }
  }
}

void refresh(true);
const events = new EventSource("/api/events");
events.addEventListener("change", () => {
  void refresh(false);
});
events.addEventListener("ready", () => {
  void refresh(false);
});
events.onerror = () => {
  node("#connection").textContent = "重新连接中";
};
const poll = setInterval(() => {
  void refresh(false);
}, 15_000);
window.addEventListener("pagehide", () => {
  clearInterval(poll);
  events.close();
});
