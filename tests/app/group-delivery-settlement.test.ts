import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import { canDeleteTaskGroup, settledUncertainInbox } from "../../src/app/group-delivery.js";
import { Outbox } from "../../src/app/outbox.js";
import { OperationError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/types.js";
import { key } from "../../src/runtime/session-records.js";
import {
  INBOX_INTERRUPTED_NOTICE_TEXT,
  proveInertExhaustedTurn,
} from "../../src/runtime/turn-settlement.js";
import { Store } from "../../src/storage/store.js";
import { logger, message, Platform, setup } from "./helpers.js";

const OWNER = "owner";
const TASK_ID = "task-settlement";
const CHAT = "group-settlement";
const MESSAGE_ID = "turn-message";
const SESSION_ID = "s_settlement";
const GENERATION = 0;
const INBOX_ID = `message:${MESSAGE_ID}`;
const RECEIPT_ID = key(OWNER, SESSION_ID, MESSAGE_ID);
const NOTICE_ID = `${INBOX_ID}:interrupted`;
const SCOPE = { ownerId: OWNER, taskId: TASK_ID, chatId: CHAT };

/** Sanitized production-like checkpoint: read-only task queries, then a model failure. */
const READ_ONLY_CHECKPOINT = [
  { role: "user", content: "只读检查任务状态", timestamp: 1 },
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "task_get", arguments: {} }],
    timestamp: 2,
  },
  {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "task_get",
    content: [{ type: "text", text: '{"status":"review","groupDeleted":false}' }],
    isError: false,
    timestamp: 3,
  },
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "c2", name: "task_progress", arguments: {} }],
    timestamp: 4,
  },
  {
    role: "toolResult",
    toolCallId: "c2",
    toolName: "task_progress",
    content: [{ type: "text", text: '{"progress":"waiting"}' }],
    isError: false,
    timestamp: 5,
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "error",
    timestamp: 6,
  },
];

interface Fixture {
  store: Store;
  outbox: Outbox;
  task: Task;
  record: () => Record<string, unknown>;
}

/** A production-like exhausted, interrupted, effect-free turn with a delivered notice. */
async function fixture(adjust: (store: Store) => void = () => {}): Promise<Fixture> {
  const store = new Store(":memory:");
  const platform = new Platform();
  const outbox = new Outbox(store, () => platform);
  // Real Outbox writes the versioned envelope and fingerprint the proof validates.
  await outbox.send(CHAT, INBOX_INTERRUPTED_NOTICE_TEXT, NOTICE_ID, MESSAGE_ID);
  const at = new Date().toISOString();
  store.set("sessions", SESSION_ID, {
    id: SESSION_ID,
    ownerId: OWNER,
    name: "任务会话",
    taskId: TASK_ID,
    generation: GENERATION,
    archived: false,
    summary: "",
    createdAt: at,
    updatedAt: at,
  });
  store.set("inbox", INBOX_ID, {
    id: INBOX_ID,
    type: "message",
    payload: {
      source: "feishu",
      eventId: "event-settlement",
      messageId: MESSAGE_ID,
      ownerId: OWNER,
      chatId: CHAT,
      chatType: "group",
      text: "查看一下进度",
      mentionedBot: true,
    },
    actor: {
      source: "feishu",
      chatType: "group",
      ownerId: OWNER,
      chatId: CHAT,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
    },
    generation: GENERATION,
    lane: `${OWNER}:${CHAT}`,
    state: "uncertain",
    attempts: 3,
    createdAt: at,
    sequence: 1,
    error: { code: "model_failed", message: "model request failed", outcome: "unknown" },
    failureNotice: "delivered",
    failureNoticeAttempts: 1,
  });
  store.set("turn_receipts", RECEIPT_ID, {
    generation: GENERATION,
    status: "failed",
    replyId: `reply_${RECEIPT_ID}`,
    recoveryVersion: 1,
    attempts: 3,
  });
  store.set("pi_checkpoints", RECEIPT_ID, {
    sessionId: SESSION_ID,
    generation: GENERATION,
    messages: READ_ONLY_CHECKPOINT,
    updatedAt: at,
  });
  adjust(store);
  return {
    store,
    outbox,
    task: { id: TASK_ID, ownerId: OWNER, chatId: CHAT, groupDeleted: false } as Task,
    record: () => store.get<Record<string, unknown>>("inbox", INBOX_ID) as Record<string, unknown>,
  };
}

function edit(store: Store, namespace: string, id: string, patch: Record<string, unknown>): void {
  const current = store.get<Record<string, unknown>>(namespace, id);
  assert.ok(current, `missing fixture record ${namespace}/${id}`);
  store.set(namespace, id, { ...current, ...patch });
}

function seedJournal(store: Store, status: string, turnId = RECEIPT_ID): void {
  store.set("pi_operations", `op-${status}`, { status, turnId, tool: "task_action", args: {} });
}

function namespaces(store: Store) {
  return ["sessions", "turn_receipts", "pi_checkpoints", "pi_operations", "inbox", "outbox"].map(
    (namespace) => [namespace, store.entries(namespace)],
  );
}

test("the proof text stays byte-identical to the notice the application really sends", async () => {
  const h = setup();
  h.engine.handler = async () => {
    throw new OperationError("model_failed", "offline", "unknown");
  };
  try {
    await h.app.handlers().message(message("drift", "你好"));
    for (let attempt = 0; attempt < 4; attempt++) {
      for (const [id, record] of h.store.entries<Record<string, unknown>>("inbox"))
        if (record.state === "queued") h.store.set("inbox", id, { ...record, nextAttemptAt: 0 });
      await h.app.inbox.drain();
    }
    assert.equal(h.platform.texts.length, 1);
    assert.equal(h.platform.texts[0]?.text, INBOX_INTERRUPTED_NOTICE_TEXT);
    assert.equal(
      h.store.get<Record<string, unknown>>("inbox", "message:drift")?.failureNotice,
      "delivered",
    );
  } finally {
    await h.close();
  }
});

test("an exhausted read-only failed turn settles group deletion without rewriting any record", async () => {
  const f = await fixture();
  try {
    const before = JSON.stringify(namespaces(f.store));
    assert.equal(proveInertExhaustedTurn(f.store, f.record(), SCOPE).proven, true);
    assert.equal(canDeleteTaskGroup(f.store, f.task), true);
    // Read-only proof: the original uncertain audit, journal and notice are untouched.
    assert.equal(JSON.stringify(namespaces(f.store)), before);
    assert.equal(f.store.list("pi_operations").length, 0);
    assert.deepEqual(
      settledUncertainInbox(f.store, f.task).map((record) => record.id),
      [INBOX_ID],
    );
    // Idempotent: the same durable facts still prove the same settlement.
    assert.equal(canDeleteTaskGroup(f.store, f.task), true);
    assert.equal(JSON.stringify(namespaces(f.store)), before);
  } finally {
    f.store.close();
  }
});

test("settlement proof survives a restart over the same durable database", async () => {
  const h = setup();
  let reopened: Store | undefined;
  try {
    h.engine.handler = async () => ({ text: '{"notify":false,"text":""}', messages: [] });
    const task = await h.app.tasks.create(
      { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "settle" },
      {
        orchestration: { mode: "manual" },
        kind: "discussion",
        title: "重启后清理",
        requirements: "只读回合不得永久阻塞",
        participants: [{ kind: "codex" }],
        keepGroup: false,
      },
    );
    await h.app.tasks.reconcile(task.id);
    const chatId = h.store.get<Task>("tasks", task.id)?.chatId;
    assert.ok(chatId);
    const session = h.app.sessions.forTask("owner", task.id);
    await h.app.outbox.send(
      chatId,
      INBOX_INTERRUPTED_NOTICE_TEXT,
      `message:${task.id}:interrupted`,
      task.id,
    );
    const at = new Date().toISOString();
    h.store.set("inbox", `message:${task.id}`, {
      id: `message:${task.id}`,
      type: "message",
      payload: message(task.id, "只读检查", chatId),
      actor: {
        source: "feishu",
        chatType: "group",
        ownerId: "owner",
        chatId,
        sessionId: session.id,
        taskId: task.id,
        messageId: task.id,
      },
      generation: session.generation,
      lane: `owner:${chatId}`,
      state: "uncertain",
      attempts: 3,
      createdAt: at,
      sequence: 1,
      error: { code: "model_failed", message: "model request failed", outcome: "unknown" },
      failureNotice: "delivered",
    });
    const receiptId = key("owner", session.id, task.id);
    h.store.set("turn_receipts", receiptId, {
      generation: session.generation,
      status: "failed",
      replyId: `reply_${receiptId}`,
      recoveryVersion: 1,
      attempts: 3,
    });
    h.store.set("pi_checkpoints", receiptId, {
      sessionId: session.id,
      generation: session.generation,
      messages: READ_ONLY_CHECKPOINT,
      updatedAt: at,
    });
    const durable = h.store.get<Task>("tasks", task.id) as Task;
    assert.equal(canDeleteTaskGroup(h.store, durable), true);
    await h.app.shutdown();
    reopened = new Store(join(h.directory, "state.sqlite"));
    const after = reopened.get<Task>("tasks", task.id) as Task;
    assert.equal(canDeleteTaskGroup(reopened, after), true);
    assert.equal(
      reopened.get<Record<string, unknown>>("inbox", `message:${task.id}`)?.state,
      "uncertain",
      "settlement never rewrites the original uncertain audit",
    );
    assert.equal(reopened.list("pi_operations").length, 0);
  } finally {
    reopened?.close();
    await h.close();
  }
});

test("the versioned journal, not the checkpoint, decides whether a write started", async () => {
  // A write tool call can appear in a checkpoint without ever starting: the
  // versioned wrapper journals `pending` BEFORE execute, so an empty journal
  // proves no write began. The checkpoint's tool names are not evidence.
  const f = await fixture((store) => {
    store.set("pi_checkpoints", RECEIPT_ID, {
      sessionId: SESSION_ID,
      generation: GENERATION,
      messages: [
        ...READ_ONLY_CHECKPOINT.slice(0, 2),
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c9", name: "task_action", arguments: { action: "destroy" } },
          ],
          timestamp: 7,
        },
      ],
    });
  });
  try {
    assert.equal(canDeleteTaskGroup(f.store, f.task), true);
  } finally {
    f.store.close();
  }
});

for (const status of ["pending", "complete", "not_executed"] as const) {
  test(`a ${status} journal row for this turn keeps the group barrier`, async () => {
    const f = await fixture((store) => seedJournal(store, status));
    try {
      assert.equal(canDeleteTaskGroup(f.store, f.task), false);
      assert.equal(proveInertExhaustedTurn(f.store, f.record(), SCOPE).reason, "journal");
    } finally {
      f.store.close();
    }
  });
}

test("journal rows of another turn never block this settlement", async () => {
  const f = await fixture((store) => seedJournal(store, "pending", "another-turn"));
  try {
    assert.equal(canDeleteTaskGroup(f.store, f.task), true);
  } finally {
    f.store.close();
  }
});

interface Negative {
  name: string;
  adjust: (store: Store) => void;
  reason?: string;
}

const negatives: Negative[] = [
  {
    name: "a legacy receipt without recoveryVersion",
    adjust: (store) => edit(store, "turn_receipts", RECEIPT_ID, { recoveryVersion: undefined }),
    reason: "receipt",
  },
  {
    name: "a finished receipt",
    adjust: (store) => edit(store, "turn_receipts", RECEIPT_ID, { status: "finished" }),
    reason: "receipt",
  },
  {
    name: "a running receipt",
    adjust: (store) => edit(store, "turn_receipts", RECEIPT_ID, { status: "running" }),
    reason: "receipt",
  },
  {
    name: "a receipt below the recovery attempt ceiling",
    adjust: (store) => edit(store, "turn_receipts", RECEIPT_ID, { attempts: 2 }),
    reason: "receipt_attempts",
  },
  {
    name: "a receipt for another generation",
    adjust: (store) => edit(store, "turn_receipts", RECEIPT_ID, { generation: 1 }),
    reason: "receipt_generation",
  },
  {
    name: "a missing turn receipt",
    adjust: (store) => store.delete("turn_receipts", RECEIPT_ID),
    reason: "receipt",
  },
  {
    name: "a missing checkpoint",
    adjust: (store) => store.delete("pi_checkpoints", RECEIPT_ID),
    reason: "checkpoint",
  },
  {
    name: "a checkpoint for another generation",
    adjust: (store) => edit(store, "pi_checkpoints", RECEIPT_ID, { generation: 5 }),
    reason: "checkpoint",
  },
  {
    name: "a checkpoint without messages",
    adjust: (store) => edit(store, "pi_checkpoints", RECEIPT_ID, { messages: undefined }),
    reason: "checkpoint",
  },
  {
    name: "a checkpoint bound to another session",
    adjust: (store) => edit(store, "pi_checkpoints", RECEIPT_ID, { sessionId: "other-session" }),
    reason: "checkpoint_session",
  },
  {
    name: "a missing durable session",
    adjust: (store) => store.delete("sessions", SESSION_ID),
    reason: "session",
  },
  {
    name: "an archived session",
    adjust: (store) => edit(store, "sessions", SESSION_ID, { archived: true }),
    reason: "session_generation",
  },
  {
    name: "a session of another generation",
    adjust: (store) => edit(store, "sessions", SESSION_ID, { generation: 2 }),
    reason: "session_generation",
  },
  {
    name: "a session owned by somebody else",
    adjust: (store) => edit(store, "sessions", SESSION_ID, { ownerId: "intruder" }),
    reason: "session",
  },
  {
    name: "a session bound to another task",
    adjust: (store) => edit(store, "sessions", SESSION_ID, { taskId: "other-task" }),
    reason: "session",
  },
  {
    name: "an inbox turn below the attempt ceiling",
    adjust: (store) => edit(store, "inbox", INBOX_ID, { attempts: 2 }),
    reason: "inbox_attempts",
  },
  {
    name: "a not_executed inbox failure",
    adjust: (store) =>
      edit(store, "inbox", INBOX_ID, {
        error: { code: "invalid_input", message: "bad", outcome: "not_executed" },
      }),
    reason: "error_outcome",
  },
  {
    name: "an unknown inbox failure with a non-transient code",
    adjust: (store) =>
      edit(store, "inbox", INBOX_ID, {
        error: { code: "invalid_scope", message: "bad scope", outcome: "unknown" },
      }),
    reason: "error_code",
  },
  {
    name: "a missing inbox error",
    adjust: (store) => edit(store, "inbox", INBOX_ID, { error: undefined }),
    reason: "error_outcome",
  },
  {
    name: "an inbox notice still pending",
    adjust: (store) => edit(store, "inbox", INBOX_ID, { failureNotice: "pending" }),
    reason: "notice_state",
  },
  {
    name: "an inbox notice only attempted",
    adjust: (store) => edit(store, "inbox", INBOX_ID, { failureNotice: "attempted" }),
    reason: "notice_state",
  },
  {
    name: "an actor bound to another owner",
    adjust: (store) =>
      edit(store, "inbox", INBOX_ID, {
        actor: { ...actorOf(store), ownerId: "intruder" },
      }),
    reason: "scope",
  },
  {
    name: "an actor bound to another task",
    adjust: (store) =>
      edit(store, "inbox", INBOX_ID, {
        actor: { ...actorOf(store), taskId: "other-task" },
      }),
    reason: "scope",
  },
  {
    name: "an actor bound to another chat",
    adjust: (store) =>
      edit(store, "inbox", INBOX_ID, {
        actor: { ...actorOf(store), chatId: "other-chat" },
      }),
    reason: "scope",
  },
  {
    name: "an actor bound to another message identity",
    adjust: (store) =>
      edit(store, "inbox", INBOX_ID, {
        actor: { ...actorOf(store), messageId: "other-message" },
      }),
    reason: "identity",
  },
  {
    name: "an inbox key that does not match its payload identity",
    adjust: (store) => {
      const record = store.get<Record<string, unknown>>("inbox", INBOX_ID);
      store.delete("inbox", INBOX_ID);
      store.set("inbox", "message:forged", { ...record, id: "message:forged" });
    },
    reason: "inbox_identity",
  },
  {
    name: "a missing interruption notice envelope",
    adjust: (store) => store.delete("outbox", NOTICE_ID),
    reason: "notice",
  },
  {
    name: "an uncertain interruption notice envelope",
    adjust: (store) => edit(store, "outbox", NOTICE_ID, { state: "uncertain" }),
    reason: "notice",
  },
  {
    name: "a prepared interruption notice envelope",
    adjust: (store) => edit(store, "outbox", NOTICE_ID, { state: "prepared" }),
    reason: "notice",
  },
  {
    name: "an interruption notice with different text",
    adjust: (store) => edit(store, "outbox", NOTICE_ID, { text: "其他通知" }),
    reason: "notice",
  },
  {
    name: "an interruption notice delivered to another chat",
    adjust: (store) => edit(store, "outbox", NOTICE_ID, { chatId: "other-chat" }),
    reason: "notice",
  },
  {
    name: "an interruption notice with an unconfirmed fragment",
    adjust: (store) => edit(store, "outbox", NOTICE_ID, { parts: ["x", "y"], ids: ["only-one"] }),
    reason: "notice",
  },
  {
    name: "a legacy interruption notice without an envelope",
    adjust: (store) => edit(store, "outbox", NOTICE_ID, { envelope: undefined }),
    reason: "notice",
  },
  {
    name: "an interruption notice fingerprint for another reply target",
    adjust: (store) =>
      edit(store, "outbox", NOTICE_ID, {
        envelope: {
          version: 1,
          replyTo: "other-message",
          fingerprint: (
            store.get<Record<string, unknown>>("outbox", NOTICE_ID)?.envelope as {
              fingerprint: string;
            }
          ).fingerprint,
        },
      }),
    reason: "notice",
  },
];

for (const scenario of negatives) {
  test(`settlement stays blocked by ${scenario.name}`, async () => {
    const f = await fixture(scenario.adjust);
    try {
      assert.equal(canDeleteTaskGroup(f.store, f.task), false);
      const current = f.store.list<{ id: string }>("inbox").find((entry) => entry.id === INBOX_ID);
      if (current)
        assert.equal(proveInertExhaustedTurn(f.store, current, SCOPE).reason, scenario.reason);
    } finally {
      f.store.close();
    }
  });
}

function actorOf(store: Store): Record<string, unknown> {
  const record = store.get<{ actor: Record<string, unknown> }>("inbox", INBOX_ID);
  assert.ok(record);
  return record.actor;
}

test("an inbox turn that is not bound to this chat is never settled, for this or any task", async () => {
  const f = await fixture((store) => {
    const record = store.get<Record<string, unknown>>("inbox", INBOX_ID);
    store.set("inbox", INBOX_ID, {
      ...record,
      payload: { ...(record?.payload as object), chatId: "other-chat" },
    });
  });
  try {
    assert.equal(proveInertExhaustedTurn(f.store, f.record(), SCOPE).reason, "inbox_chat");
    // The turn no longer belongs to this group, so it is not a deletion barrier
    // for the group; its own chat's task (none here) would still see it.
    assert.equal(canDeleteTaskGroup(f.store, f.task), true);
    const foreign = { ...f.task, chatId: "other-chat" };
    assert.equal(canDeleteTaskGroup(f.store, foreign), false);
  } finally {
    f.store.close();
  }
});

test("queued, processing and unrelated uncertain inbox rows still block group deletion", async () => {
  const f = await fixture();
  try {
    for (const state of ["queued", "processing"] as const) {
      edit(f.store, "inbox", INBOX_ID, { state });
      assert.equal(canDeleteTaskGroup(f.store, f.task), false);
      edit(f.store, "inbox", INBOX_ID, { state: "uncertain" });
    }
    // A foreign uncertain row (here: an action without a task binding) is never
    // settled by this task's proof and keeps blocking its chat.
    f.store.set("inbox", "action:foreign", {
      id: "action:foreign",
      type: "action",
      payload: { chatId: CHAT },
      state: "uncertain",
      lane: `${OWNER}:${CHAT}`,
      createdAt: new Date().toISOString(),
      sequence: 2,
    });
    assert.equal(canDeleteTaskGroup(f.store, f.task), false);
    assert.equal(
      proveInertExhaustedTurn(
        f.store,
        f.store.get<Record<string, unknown>>("inbox", "action:foreign") as Record<string, unknown>,
        SCOPE,
      ).reason,
      "inbox_type",
    );
  } finally {
    f.store.close();
  }
});

test("a settled turn still blocks while any outgoing chat message is undelivered", async () => {
  const f = await fixture();
  try {
    f.store.set("outbox", "pending-reply", { chatId: CHAT, state: "uncertain" });
    assert.equal(canDeleteTaskGroup(f.store, f.task), false);
    assert.equal(proveInertExhaustedTurn(f.store, f.record(), SCOPE).proven, true);
    edit(f.store, "outbox", "pending-reply", { state: "delivered" });
    assert.equal(canDeleteTaskGroup(f.store, f.task), true);
  } finally {
    f.store.close();
  }
});

test("task cleanup deletes the group after an exhausted read-only turn is settled", async () => {
  const h = setup();
  h.engine.handler = async () => ({ text: '{"notify":false,"text":""}', messages: [] });
  const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "settle" };
  try {
    const task = await h.app.tasks.create(actor, {
      orchestration: { mode: "manual" },
      kind: "discussion",
      title: "只读中断后清理",
      requirements: "通知已送达且无写操作时应解散群",
      participants: [{ kind: "codex" }],
      keepGroup: false,
    });
    await h.app.tasks.reconcile(task.id);
    const ready = h.app.tasks.get(actor, task.id);
    const chatId = ready.chatId;
    assert.ok(chatId);
    const session = h.app.sessions.forTask("owner", task.id);
    const turnId = "read-only-turn";
    const inboxId = `message:${turnId}`;
    await h.app.outbox.send(
      chatId,
      INBOX_INTERRUPTED_NOTICE_TEXT,
      `${inboxId}:interrupted`,
      turnId,
    );
    const at = new Date().toISOString();
    h.store.set("inbox", inboxId, {
      id: inboxId,
      type: "message",
      payload: message(turnId, "查看进度", chatId),
      actor: {
        source: "feishu",
        chatType: "group",
        ownerId: "owner",
        chatId,
        sessionId: session.id,
        taskId: task.id,
        messageId: turnId,
      },
      generation: session.generation,
      lane: `owner:${chatId}`,
      state: "uncertain",
      attempts: 3,
      createdAt: at,
      sequence: 1,
      error: { code: "model_failed", message: "model request failed", outcome: "unknown" },
      failureNotice: "delivered",
    });
    const receiptId = key("owner", session.id, turnId);
    h.store.set("turn_receipts", receiptId, {
      generation: session.generation,
      status: "failed",
      replyId: `reply_${receiptId}`,
      recoveryVersion: 1,
      attempts: 3,
    });
    h.store.set("pi_checkpoints", receiptId, {
      sessionId: session.id,
      generation: session.generation,
      messages: READ_ONLY_CHECKPOINT,
      updatedAt: at,
    });
    await h.app.tasks.action({ ...actor, messageId: "complete" }, task.id, "complete");
    await h.app.tasks.reconcile(task.id);
    await h.app.tasks.reconcile(task.id);
    const closed = h.app.tasks.get(actor, task.id);
    assert.equal(closed.status, "destroyed");
    assert.equal(closed.groupDeleted, true);
    assert.equal(h.platform.deletions, 1);
    assert.equal(
      h.store.get<Record<string, unknown>>("inbox", inboxId)?.state,
      "uncertain",
      "cleanup does not rewrite the uncertain turn",
    );
  } finally {
    await h.close();
  }
});

test("task cleanup still waits when the same uncertain turn has a pending write", async () => {
  const h = setup();
  h.engine.handler = async () => ({ text: '{"notify":false,"text":""}', messages: [] });
  const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "settle" };
  try {
    const task = await h.app.tasks.create(actor, {
      orchestration: { mode: "manual" },
      kind: "discussion",
      title: "写操作未知时保留",
      requirements: "未知写操作不得通过只读证明",
      participants: [{ kind: "codex" }],
      keepGroup: false,
    });
    await h.app.tasks.reconcile(task.id);
    const ready = h.app.tasks.get(actor, task.id);
    const chatId = ready.chatId;
    assert.ok(chatId);
    const session = h.app.sessions.forTask("owner", task.id);
    const turnId = "write-turn";
    const inboxId = `message:${turnId}`;
    await h.app.outbox.send(
      chatId,
      INBOX_INTERRUPTED_NOTICE_TEXT,
      `${inboxId}:interrupted`,
      turnId,
    );
    const at = new Date().toISOString();
    h.store.set("inbox", inboxId, {
      id: inboxId,
      type: "message",
      payload: message(turnId, "执行修改", chatId),
      actor: {
        source: "feishu",
        chatType: "group",
        ownerId: "owner",
        chatId,
        sessionId: session.id,
        taskId: task.id,
        messageId: turnId,
      },
      generation: session.generation,
      lane: `owner:${chatId}`,
      state: "uncertain",
      attempts: 3,
      createdAt: at,
      sequence: 1,
      error: { code: "model_failed", message: "model request failed", outcome: "unknown" },
      failureNotice: "delivered",
    });
    const receiptId = key("owner", session.id, turnId);
    h.store.set("turn_receipts", receiptId, {
      generation: session.generation,
      status: "failed",
      replyId: `reply_${receiptId}`,
      recoveryVersion: 1,
      attempts: 3,
    });
    h.store.set("pi_checkpoints", receiptId, {
      sessionId: session.id,
      generation: session.generation,
      messages: READ_ONLY_CHECKPOINT,
      updatedAt: at,
    });
    h.store.set("pi_operations", "unknown-write", {
      status: "pending",
      turnId: receiptId,
      tool: "participant_send",
      args: {},
    });
    await h.app.tasks.action({ ...actor, messageId: "complete" }, task.id, "complete");
    await h.app.tasks.reconcile(task.id);
    await h.app.tasks.reconcile(task.id);
    const pending = h.app.tasks.get(actor, task.id);
    assert.equal(pending.groupDeleted, false);
    assert.equal(h.platform.deletions, 0);
    assert.equal(h.herdr.closes, 1, "resource cleanup still proceeds; only group deletion waits");
  } finally {
    await h.close();
  }
});

test("a restarted Application keeps settling without rerunning the failed turn", async () => {
  const h = setup();
  let restarted: Application | undefined;
  try {
    await h.app.handlers().message(message("interrupted", "只读请求"));
    const record = h.store.get<Record<string, unknown>>("inbox", "message:interrupted");
    assert.ok(record?.actor);
    h.store.set("inbox", "message:interrupted", {
      ...record,
      state: "uncertain",
      attempts: 3,
      failureNotice: "delivered",
      error: { code: "model_failed", message: "model unavailable", outcome: "unknown" },
    });
    const actor = record.actor as { sessionId: string };
    const receiptId = key("owner", actor.sessionId, "interrupted");
    h.store.set("turn_receipts", receiptId, {
      generation: record.generation as number,
      status: "failed",
      replyId: `reply_${receiptId}`,
      recoveryVersion: 1,
      attempts: 3,
    });
    h.store.set("pi_checkpoints", receiptId, {
      sessionId: actor.sessionId,
      generation: record.generation as number,
      messages: READ_ONLY_CHECKPOINT,
      updatedAt: new Date().toISOString(),
    });
    await h.app.shutdown();
    restarted = new Application({
      config: h.config,
      store: h.store,
      engine: h.engine,
      herdr: h.herdr,
      platform: h.platform,
      logger,
    });
    await restarted.inbox.drain();
    assert.equal(h.engine.calls.length, 0, "settlement never replays the failed turn");
    assert.equal(
      h.store.get<Record<string, unknown>>("inbox", "message:interrupted")?.state,
      "uncertain",
    );
  } finally {
    await restarted?.shutdown();
    await h.close();
  }
});
