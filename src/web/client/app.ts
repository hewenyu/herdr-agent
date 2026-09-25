import type { WebState } from "../contracts.js";
import { dispatch, state as fetchState } from "./api.js";
import { configurationAction } from "./config-action.js";
import { button, el, select, time } from "./dom.js";
import { renderProjects, renderSettings } from "./projects.js";
import { type RecordTab, renderSessions, type SessionFilter } from "./sessions.js";

type Page = "sessions" | "projects" | "settings";

let current: WebState = {};
let selectedOwner = "";
let selectedSession = "";
let filter: SessionFilter = "all";
let tab: RecordTab = "messages";
let page: Page = "sessions";
let requestVersion = 0;
let refreshing = false;
let refreshPending = false;
let rendered = false;
let identityOptions = "";

function node<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`页面缺少 ${selector}`);
  return found;
}

const identity = select("查看身份", []);
const status = select(
  "会话范围",
  [
    ["all", "全部会话"],
    ["active", "活动会话"],
    ["archived", "归档会话"],
  ],
  filter,
);
const refreshButton = button("刷新记录", () => void refresh());
node("#filters").replaceChildren(identity.wrapper, status.wrapper, refreshButton);
identity.input.addEventListener("change", () => void switchIdentity(identity.input.value));
status.input.addEventListener("change", () => {
  filter = status.input.value as SessionFilter;
  render();
});

async function switchIdentity(ownerId: string): Promise<void> {
  if (!ownerId || ownerId === selectedOwner) return;
  try {
    await dispatch("identity.select", { ownerId });
    selectedOwner = ownerId;
    selectedSession = "";
    requestVersion++;
    await refresh();
  } catch (error) {
    node("#feedback").replaceChildren(
      el("p", "notice", error instanceof Error ? error.message : "身份切换未完成。"),
    );
    await refresh();
  }
}

function syncIdentity(): void {
  const identities = current.identities ?? [];
  const signature = JSON.stringify(identities);
  if (identityOptions !== signature) {
    identity.input.replaceChildren(
      ...identities.map(({ id, sessionCount }) => {
        const option = el("option", "", `${id} · ${sessionCount} 个会话`);
        option.value = id;
        return option;
      }),
    );
    identityOptions = signature;
  }
  identity.input.value = selectedOwner || current.activeOwnerId || identities[0]?.id || "";
  identity.input.disabled = !identities.length;
}

function renderNavigation(): void {
  const navigation = node("#navigation");
  navigation.replaceChildren();
  for (const [key, label] of [
    ["sessions", "会话记录"],
    ["projects", "项目配置"],
    ["settings", "模型设置"],
  ] as const) {
    navigation.append(
      button(
        label,
        () => {
          page = key;
          render();
        },
        page === key ? "selected" : "",
      ),
    );
  }
  node("#page-title").textContent =
    page === "sessions" ? "会话记录" : page === "projects" ? "项目配置" : "模型设置";
  node("#filters").style.display = page === "sessions" ? "" : "none";
}

function feedback(message: string, error = false): void {
  node("#feedback").replaceChildren(el("div", `notice ${error ? "error" : "good"}`, message));
}

const configAction = configurationAction(dispatch, refresh, feedback);

function render(): void {
  const oldHistory = document.querySelector<HTMLElement>(".history");
  const previousSession = oldHistory?.dataset.sessionId;
  const scroll = oldHistory?.scrollTop ?? 0;
  const openRecords = new Set(
    [...document.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
      (entry) => entry.dataset.recordId,
    ),
  );
  syncIdentity();
  renderNavigation();
  rendered = true;
  if (page === "projects") {
    node("#content").replaceChildren(renderProjects(current, configAction));
    return;
  }
  if (page === "settings") {
    node("#content").replaceChildren(renderSettings(current, configAction));
    return;
  }
  const visible = (current.sessions ?? []).filter(
    (session) => filter === "all" || session.archived === (filter === "archived"),
  );
  if (!visible.some((session) => session.id === selectedSession))
    selectedSession = visible[0]?.id ?? "";
  node("#content").replaceChildren(
    renderSessions(
      current,
      selectedSession,
      filter,
      tab,
      (id) => {
        selectedSession = id;
        render();
      },
      (value) => {
        tab = value;
        render();
      },
    ),
  );
  for (const entry of document.querySelectorAll<HTMLDetailsElement>("details"))
    if (openRecords.has(entry.dataset.recordId)) entry.open = true;
  const history = document.querySelector<HTMLElement>(".history");
  if (history && previousSession === selectedSession) history.scrollTop = scroll;
}

async function refresh(): Promise<void> {
  if (refreshing) {
    refreshPending = true;
    return;
  }
  refreshing = true;
  refreshButton.disabled = true;
  const version = requestVersion;
  const owner = selectedOwner;
  try {
    const next = await fetchState(owner || undefined);
    if (version !== requestVersion) return;
    const nextOwner = owner || next.activeOwnerId || next.identities?.[0]?.id || "";
    const changed =
      !rendered || nextOwner !== selectedOwner || JSON.stringify(next) !== JSON.stringify(current);
    current = next;
    selectedOwner = nextOwner;
    node("#connection").textContent = `已更新 ${time(new Date().toISOString())}`;
    node("#feedback").replaceChildren();
    if (changed) render();
  } catch (error) {
    if (version === requestVersion) {
      node("#connection").textContent = "连接暂不可用";
      node("#feedback").replaceChildren(
        el("p", "notice", error instanceof Error ? error.message : "读取记录失败，请刷新。"),
      );
    }
  } finally {
    refreshing = false;
    refreshButton.disabled = false;
    if (refreshPending) {
      refreshPending = false;
      void refresh();
    }
  }
}

void refresh();
const events = new EventSource("/api/events");
events.addEventListener("change", () => void refresh());
events.addEventListener("ready", () => void refresh());
events.onerror = () => {
  node("#connection").textContent = "重新连接中";
};
const poll = setInterval(() => void refresh(), 15_000);
window.addEventListener("pagehide", () => {
  clearInterval(poll);
  events.close();
});
