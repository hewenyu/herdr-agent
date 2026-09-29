import type { StoredMessage } from "../../core/types.js";
import type { WebReportReceipt, WebState } from "../contracts.js";
import { acknowledgeReport } from "./api.js";

function receipt(state: WebState, message: StoredMessage): WebReportReceipt | undefined {
  const session = state.sessions?.find((entry) => entry.id === message.sessionId);
  if (
    !state.activeOwnerId ||
    session?.ownerId !== state.activeOwnerId ||
    !session.taskId ||
    message.taskId !== session.taskId ||
    message.generation !== session.generation ||
    message.role === "user" ||
    message.delivery !== "prepared" ||
    !["workflow_report", "workflow_report_summary"].includes(message.source)
  )
    return;
  return {
    ownerId: state.activeOwnerId,
    sessionId: session.id,
    taskId: session.taskId,
    messageId: message.id,
  };
}

/** Observe only mounted report messages; offscreen, hidden-tab and activity records are not ACKs. */
export function observeRenderedReports(
  root: HTMLElement,
  state: WebState,
  updated: () => void,
  send: (receipt: WebReportReceipt) => Promise<void> = acknowledgeReport,
): { disconnect(): void; retry(): void } {
  const targets = new Map<Element, WebReportReceipt>();
  const visible = new Set<Element>();
  const pending = new Set<Element>();
  let stopped = false;
  const retry = () => {
    if (stopped || document.visibilityState !== "visible") return;
    for (const element of visible) {
      const input = targets.get(element);
      if (!input || !element.isConnected || pending.has(element)) continue;
      pending.add(element);
      void send(input)
        .then(() => {
          targets.delete(element);
          observer.unobserve(element);
          updated();
        })
        .catch(() => {
          // Idempotent receipt POSTs may retry on the next ordinary refresh or visibility event.
        })
        .finally(() => pending.delete(element));
    }
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (
        entry.isIntersecting &&
        entry.intersectionRect.width > 0 &&
        entry.intersectionRect.height > 0
      )
        visible.add(entry.target);
      else visible.delete(entry.target);
    }
    retry();
  });
  for (const element of root.querySelectorAll<HTMLElement>(".history .message[data-message-id]")) {
    const message = state.messages?.find((entry) => entry.id === element.dataset.messageId);
    const input = message && receipt(state, message);
    if (!input) continue;
    targets.set(element, input);
    observer.observe(element);
  }
  document.addEventListener("visibilitychange", retry);
  return {
    retry,
    disconnect() {
      stopped = true;
      observer.disconnect();
      document.removeEventListener("visibilitychange", retry);
    },
  };
}
