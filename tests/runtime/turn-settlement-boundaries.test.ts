import assert from "node:assert/strict";
import test from "node:test";
import { canonical, stableId } from "../../src/core/ids.js";
import { key } from "../../src/runtime/session-records.js";
import {
  INBOX_INTERRUPTED_NOTICE_TEXT,
  proveInertExhaustedTurn,
} from "../../src/runtime/turn-settlement.js";
import { Store } from "../../src/storage/store.js";

for (const boundary of [
  {
    name: "missing checkpoint session identity",
    namespace: "pi_checkpoints",
    patch: { sessionId: undefined },
  },
  {
    name: "missing receipt reply identity",
    namespace: "turn_receipts",
    patch: { replyId: undefined },
  },
  {
    name: "foreign receipt reply identity",
    namespace: "turn_receipts",
    patch: { replyId: "reply_other-turn" },
  },
])
  test(`settlement refuses ${boundary.name}`, () => {
    const store = new Store(":memory:");
    try {
      const scope = { ownerId: "owner", taskId: "task", chatId: "chat" };
      const actor = { ...scope, sessionId: "session", messageId: "message" };
      const receiptId = key(actor.ownerId, actor.sessionId, actor.messageId);
      const record = {
        id: "message:message",
        type: "message",
        payload: { chatId: scope.chatId, messageId: actor.messageId },
        actor,
        generation: 0,
        state: "uncertain",
        attempts: 3,
        error: { code: "model_failed", outcome: "unknown" },
        failureNotice: "delivered",
      };
      store.set("sessions", actor.sessionId, {
        id: actor.sessionId,
        ownerId: scope.ownerId,
        taskId: scope.taskId,
        generation: 0,
        archived: false,
      });
      store.set("turn_receipts", receiptId, {
        generation: 0,
        status: "failed",
        recoveryVersion: 1,
        attempts: 3,
        replyId: `reply_${receiptId}`,
      });
      store.set("pi_checkpoints", receiptId, {
        sessionId: actor.sessionId,
        generation: 0,
        messages: [],
      });
      const notice = {
        id: `${record.id}:interrupted`,
        chatId: scope.chatId,
        text: INBOX_INTERRUPTED_NOTICE_TEXT,
        parts: [INBOX_INTERRUPTED_NOTICE_TEXT],
        replyTo: actor.messageId,
      };
      store.set("outbox", notice.id, {
        ...notice,
        state: "delivered",
        ids: ["confirmed-message-id"],
        envelope: { version: 1, replyTo: notice.replyTo, fingerprint: stableId(canonical(notice)) },
      });
      assert.equal(
        proveInertExhaustedTurn(store, record, scope).proven,
        true,
        "complete proof control",
      );
      const original = store.get<Record<string, unknown>>(boundary.namespace, receiptId);
      store.set(boundary.namespace, receiptId, { ...original, ...boundary.patch });
      const malformed = store.get(boundary.namespace, receiptId);
      assert.equal(proveInertExhaustedTurn(store, record, scope).proven, false);
      assert.deepEqual(
        store.get(boundary.namespace, receiptId),
        malformed,
        "proof never rewrites evidence",
      );
    } finally {
      store.close();
    }
  });
