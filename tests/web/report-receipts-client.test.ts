import assert from "node:assert/strict";
import test from "node:test";
import type { Session, StoredMessage } from "../../src/core/types.js";
import { observeRenderedReports } from "../../src/web/client/report-receipts.js";
import type { WebReportReceipt, WebState } from "../../src/web/contracts.js";

test("client acknowledges only visible mounted report messages and retries failed receipt POSTs safely", async () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  const listeners = new Set<() => void>();
  const page = {
    visibilityState: "visible",
    addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) => listeners.delete(listener),
  };
  let changed!: (entries: IntersectionObserverEntry[]) => void;
  const observed = new Set<Element>();
  class Observer {
    constructor(callback: typeof changed) {
      changed = callback;
    }
    observe(element: Element) {
      observed.add(element);
    }
    unobserve(element: Element) {
      observed.delete(element);
    }
    disconnect() {
      observed.clear();
    }
  }
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: Observer,
  });
  const element = (id: string) =>
    ({ dataset: { messageId: id }, isConnected: true }) as unknown as HTMLElement;
  const summary = element("summary");
  const body = element("body");
  const ordinary = element("ordinary");
  const foreign = element("foreign");
  const delivered = element("delivered");
  const old = element("old");
  const message = (id: string, patch: Partial<StoredMessage> = {}): StoredMessage => ({
    id,
    sessionId: "selected",
    taskId: "task",
    role: "assistant",
    source: "workflow_report_summary",
    text: "报告摘要",
    createdAt: "2026-09-28T00:00:00.000Z",
    delivery: "prepared",
    deliveryIds: [],
    generation: 0,
    ...patch,
  });
  const state: WebState = {
    activeOwnerId: "owner",
    sessions: [
      { id: "selected", ownerId: "owner", taskId: "task", generation: 0 } as Session,
      { id: "foreign-session", ownerId: "other", taskId: "foreign-task", generation: 0 } as Session,
    ],
    messages: [
      message("summary"),
      message("body", { source: "workflow_report" }),
      message("ordinary", { source: "lifecycle" }),
      message("foreign", { sessionId: "foreign-session", taskId: "foreign-task" }),
      message("delivered", { delivery: "delivered" }),
      message("old", { generation: -1 }),
      message("unmounted"),
    ],
  };
  const root = {
    querySelectorAll: () => [summary, body, ordinary, foreign, delivered, old],
  } as unknown as HTMLElement;
  const sent: WebReportReceipt[] = [];
  let updates = 0;
  let fail = true;
  const watcher = observeRenderedReports(
    root,
    state,
    () => updates++,
    async (receipt) => {
      sent.push(receipt);
      if (fail) throw new Error("temporary network failure");
    },
  );
  const show = (target: Element, visible = true) =>
    changed([
      {
        target,
        isIntersecting: visible,
        intersectionRect: { width: visible ? 100 : 0, height: 50 },
      } as IntersectionObserverEntry,
    ]);
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.deepEqual([...observed], [summary, body]);
    assert.equal(sent.length, 0, "state reads and DOM creation alone are not receipt confirmation");
    show(summary, false);
    await settle();
    assert.equal(sent.length, 0);
    page.visibilityState = "hidden";
    show(summary);
    await settle();
    assert.equal(sent.length, 0, "background tabs cannot acknowledge reports");
    page.visibilityState = "visible";
    for (const listener of listeners) listener();
    await settle();
    assert.deepEqual(sent, [
      { ownerId: "owner", sessionId: "selected", taskId: "task", messageId: "summary" },
    ]);
    assert.equal(updates, 0);
    fail = false;
    watcher.retry();
    await settle();
    assert.equal(sent.length, 2);
    assert.equal(updates, 1);
    watcher.retry();
    show(summary);
    await settle();
    assert.equal(sent.length, 2, "confirmed nodes do not send again");
    Object.defineProperty(body, "isConnected", { value: false });
    show(body);
    await settle();
    assert.equal(sent.length, 2, "a session switch detaches old report nodes");
    watcher.disconnect();
    assert.equal(listeners.size, 0);
    assert.equal(observed.size, 0);
    watcher.retry();
    assert.equal(sent.length, 2);
    const empty = observeRenderedReports(
      { querySelectorAll: () => [] } as unknown as HTMLElement,
      state,
      () => updates++,
      async () => {
        throw new Error("activity page must not ACK");
      },
    );
    assert.equal(observed.size, 0);
    empty.disconnect();
  } finally {
    watcher.disconnect();
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
    if (observerDescriptor)
      Object.defineProperty(globalThis, "IntersectionObserver", observerDescriptor);
    else Reflect.deleteProperty(globalThis, "IntersectionObserver");
  }
});
