import type { StoredMessage } from "../../core/types.js";
import type { WebState } from "../contracts.js";
import { type Action, dispatch, state as fetchState } from "./api.js";
import { displayThenAcknowledge } from "./delivery.js";
import { button, closeModal, el, select } from "./dom.js";
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
let pendingForce = false;
let identityVersion = 0;
let switchingIdentity = false;
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

function clearIdentityView() {
  identityVersion++;
  activeSession = "";
  activeTask = "";
  archived = false;
  historyBySession.clear();
  acknowledgements.clear();
  current = {
    ...current,
    activeSessionId: undefined,
    sessions: [],
    tasks: [],
    participants: [],
    messages: [],
  };
  node("#feedback").replaceChildren();
  closeModal();
}

async function switchIdentity(ownerId: string) {
  if (switchingIdentity || ownerId === current.activeOwnerId) return;
  switchingIdentity = true;
  clearIdentityView();
  render();
  try {
    await dispatch("identity.select", { ownerId });
  } catch (error) {
    feedback(error instanceof Error ? error.message : "身份切换未完成。", true);
  } finally {
    switchingIdentity = false;
    await refresh(true);
  }
}

function renderIdentity() {
  const area = node("#identity");
  area.replaceChildren();
  if (!current.identities?.length) return;
  const chooser = select(
    "本机管理身份",
    current.identities.map(({ id, sessionCount }) => [
      id,
      `${id.length > 22 ? `${id.slice(0, 11)}…${id.slice(-7)}` : id} · ${sessionCount} 个会话`,
    ]),
    current.activeOwnerId,
  );
  chooser.input.disabled = switchingIdentity;
  chooser.input.title = current.activeOwnerId ?? "";
  chooser.input.addEventListener("change", () => void switchIdentity(chooser.input.value));
  chooser.wrapper.append(
    el("small", "", "查看此身份的飞书与本机会话、任务；切换不会移动已有记录。"),
  );
  area.append(chooser.wrapper);
}

async function acknowledge(
  messageId: string,
  sessionId: string,
  display = () => {},
  quiet = false,
  ownerId = current.activeOwnerId,
  version = identityVersion,
): Promise<void> {
  if (version !== identityVersion || switchingIdentity) return;
  acknowledgements.add(messageId);
  await displayThenAcknowledge(
    display,
    async () => {
      await dispatch("chat.ack", { messageId, sessionId, expectedOwnerId: ownerId });
      if (version !== identityVersion) return;
      if (!quiet) feedback("回复已显示，送达确认已保存。");
      await refresh(true);
    },
    () => {
      if (version !== identityVersion) return;
      const message = "回复尚未确认显示。请查看回复后重试确认，不要重发原消息。";
      const area = node("#feedback");
      if (area.querySelector("[data-delivery-message-id]"))
        area.append(el("div", "notice error", message));
      else feedback(message, true);
      node("#feedback").append(
        button(
          "重试送达确认",
          () => acknowledge(messageId, sessionId, undefined, quiet, ownerId, version),
          "small",
        ),
      );
    },
    () =>
      [...document.querySelectorAll<HTMLElement>("[data-delivery-message-id]")].some(
        (bubble) =>
          bubble.dataset.deliveryMessageId === messageId &&
          bubble.dataset.deliverySessionId === sessionId &&
          bubble.isConnected &&
          bubble.getClientRects().length > 0,
      ),
  );
}

const action: Action = async (name, input) => {
  if (switchingIdentity) return undefined;
  const version = identityVersion;
  const ownerId = current.activeOwnerId;
  try {
    const result = await dispatch(name, { ...input, expectedOwnerId: ownerId });
    if (version !== identityVersion) return undefined;
    if (name === "session.history" && Array.isArray(result)) {
      if (typeof input.id === "string") historyBySession.set(input.id, result as StoredMessage[]);
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
      // A session rotation may have archived the reply's session before
      // the HTTP response arrives. Read that transition before choosing a view.
      const latest = await fetchState();
      if (version !== identityVersion) return undefined;
      if (latest.activeOwnerId !== ownerId) {
        await refresh(true);
        return undefined;
      }
      current = latest;
      if (current.sessions?.find((session) => session.id === result.sessionId)?.archived) {
        const replyId = result.id;
        const originSessionId = result.sessionId;
        const replyText = result.text;
        activeSession = current.activeSessionId ?? "";
        archived = false;
        currentTab = "sessions";
        await acknowledge(
          replyId,
          originSessionId,
          () => {
            render();
            const receipt = el("article", "message assistant");
            receipt.dataset.deliveryMessageId = replyId;
            receipt.dataset.deliverySessionId = originSessionId;
            receipt.append(
              el("span", "message-label", "已归档会话的回复"),
              document.createTextNode(replyText),
            );
            node("#feedback").replaceChildren(
              receipt,
              button(
                "查看归档会话",
                async () => {
                  activeSession = originSessionId;
                  archived = true;
                  await action("session.history", { id: originSessionId });
                },
                "small",
              ),
            );
          },
          true,
        );
        return result;
      }
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
    if (version !== identityVersion) return undefined;
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
  renderIdentity();
  renderAuthorization();
  if (switchingIdentity) {
    node("#content").replaceChildren(el("div", "empty", "正在切换本机管理身份…"));
    return;
  }
  const viewState = {
    ...current,
    activeSessionId: activeSession || current.activeSessionId,
    messages: archived ? historyBySession.get(activeSession) : current.messages,
  };
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
            activeSession = archived
              ? (current.sessions?.find((session) => session.archived)?.id ?? "")
              : (current.activeSessionId ?? "");
            render();
            if (archived && activeSession) void action("session.history", { id: activeSession });
            else void refresh(true);
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
  if (switchingIdentity) return;
  if (refreshing) {
    pending = true;
    pendingForce ||= force;
    return;
  }
  refreshing = true;
  const version = identityVersion;
  try {
    const next = await fetchState();
    if (version !== identityVersion || switchingIdentity) return;
    const identityChanged = current.activeOwnerId !== next.activeOwnerId;
    if (identityChanged) clearIdentityView();
    current = next;
    node("#connection").textContent = "● 本机已连接";
    const editing = document.activeElement?.matches("input,textarea,select") ?? false;
    if (force || identityChanged || !editing) render();
  } catch (error) {
    node("#connection").textContent = "连接中断 · 等待恢复";
    if (force) feedback(error instanceof Error ? error.message : "读取状态失败", true);
  } finally {
    refreshing = false;
    if (pending) {
      pending = false;
      const forceNext = pendingForce;
      pendingForce = false;
      void refresh(forceNext);
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
