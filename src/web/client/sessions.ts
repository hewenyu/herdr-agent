import type { StoredMessage } from "../../core/types.js";
import type { WebState } from "../contracts.js";
import { button, detail, el, empty, time } from "./dom.js";

export type RecordTab = "messages" | "activity";
export type SessionFilter = "all" | "active" | "archived";

const deliveryLabels: Record<StoredMessage["delivery"], string> = {
  prepared: "待发送",
  sending: "发送中",
  delivered: "已送达",
  uncertain: "送达未知",
  retryable: "本次未发送",
};

function messageView(message: StoredMessage, state: WebState): HTMLElement {
  const node = el("article", `message ${message.role}`);
  node.dataset.messageId = message.id;
  const participantName = message.participantId
    ? state.participantNames?.[message.participantId]
    : undefined;
  const author =
    message.role === "user"
      ? "用户"
      : message.role === "participant"
        ? (participantName ?? message.participantId ?? "参与者")
        : message.role === "assistant"
          ? "pi"
          : "系统";
  const header = el("div", "message-header");
  header.append(el("strong", "", author), el("span", "subtle", time(message.createdAt)));
  node.append(header, el("div", "message-text", message.text));
  node.append(
    detail(
      `${deliveryLabels[message.delivery] ?? message.delivery} · 查看消息记录`,
      {
        messageId: message.id,
        sessionId: message.sessionId,
        source: message.source,
        ...(message.participantId ? { participantId: message.participantId } : {}),
        generation: message.generation,
        delivery: message.delivery,
        deliveryIds: message.deliveryIds,
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      },
      `message:${message.id}`,
    ),
  );
  return node;
}

export function renderSessions(
  state: WebState,
  selectedId: string,
  filter: SessionFilter,
  tab: RecordTab,
  chooseSession: (id: string) => void,
  chooseTab: (tab: RecordTab) => void,
): HTMLElement {
  const sessions = (state.sessions ?? []).filter(
    (session) => filter === "all" || session.archived === (filter === "archived"),
  );
  if (!sessions.length)
    return empty("没有会话记录", "此身份或筛选条件下暂无记录。新会话与业务操作请在飞书中发起。");
  const selected = sessions.find((session) => session.id === selectedId) ?? sessions[0];
  if (!selected) return empty("没有会话记录", "请刷新后查看。");
  const root = el("div", "split");
  const list = el("nav", "session-list");
  list.setAttribute("aria-label", "浏览会话记录");
  for (const session of sessions) {
    const item = button("", () => chooseSession(session.id), "session-item");
    item.classList.toggle("selected", session.id === selected.id);
    item.setAttribute("aria-current", session.id === selected.id ? "true" : "false");
    const stateLabel = session.archived ? "已归档" : "活动记录";
    item.append(
      el("strong", "", session.name),
      el("span", "session-meta", `${session.taskId ? "任务会话" : "主入口会话"} · ${stateLabel}`),
      el("span", "session-meta", time(session.updatedAt)),
    );
    list.append(item);
  }
  const panel = el("section", "panel");
  const head = el("header", "panel-head");
  const title = el("div");
  title.append(el("h2", "", selected.name), el("p", "session-id", selected.id));
  head.append(title, el("span", "badge", selected.archived ? "已归档" : "活动记录"));
  panel.append(head);
  const metadata = {
    ownerId: selected.ownerId,
    taskId: selected.taskId,
    generation: selected.generation,
    createdAt: selected.createdAt,
    updatedAt: selected.updatedAt,
    ...(selected.summary ? { summary: selected.summary } : {}),
  };
  panel.append(detail("会话信息与历史摘要", metadata, `session:${selected.id}`));
  const messages = (state.messages ?? []).filter((message) => message.sessionId === selected.id);
  const records = (state.records ?? []).filter((record) => record.sessionId === selected.id);
  const tabs = el("div", "record-tabs");
  tabs.setAttribute("aria-label", "记录类型");
  for (const [key, label] of [
    ["messages", `消息 · ${messages.length}`],
    ["activity", `工具与回执 · ${records.length}`],
  ] as const) {
    const control = button(label, () => chooseTab(key), tab === key ? "selected" : "");
    control.setAttribute("aria-pressed", String(tab === key));
    tabs.append(control);
  }
  panel.append(tabs);
  const history = el("div", "history");
  history.dataset.sessionId = selected.id;
  history.setAttribute("aria-label", tab === "messages" ? "消息历史" : "工具与回执历史");
  if (tab === "messages") {
    if (!messages.length) history.append(empty("暂无消息", "已有消息记录将在这里显示。"));
    for (const message of messages) history.append(messageView(message, state));
  } else {
    if (!records.length)
      history.append(empty("暂无工具或回执记录", "这里展示已保存的调用与处理结果。"));
    for (const record of records) {
      const item = el("article", "activity");
      const header = el("div", "message-header");
      header.append(el("strong", "", record.kind), el("span", "subtle", time(record.createdAt)));
      item.append(header);
      if (record.state) item.append(el("p", "activity-state", record.state));
      item.append(detail("查看记录详情", record.data, `record:${record.id}`));
      history.append(item);
    }
  }
  panel.append(history);
  root.append(list, panel);
  return root;
}
