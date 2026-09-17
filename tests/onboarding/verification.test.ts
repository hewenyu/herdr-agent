import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformHandlers, PlatformPort } from "../../src/core/ports.js";
import type { CardAction, IncomingMessage } from "../../src/core/types.js";
import { verifyPlatform } from "../../src/onboarding/verification.js";

const message: IncomingMessage = {
  source: "feishu",
  eventId: "e",
  messageId: "m",
  ownerId: "owner",
  chatId: "chat",
  chatType: "private",
  text: "verify",
  mentionedBot: false,
};
function fake() {
  let handlers: PlatformHandlers | undefined;
  let stopped = false;
  let card: Record<string, unknown> | undefined;
  const platform: PlatformPort = {
    start: async (value) => {
      handlers = value;
    },
    stop: async () => {
      stopped = true;
    },
    sendCard: async (_chat, value) => {
      card = value;
      return "card-id";
    },
    sendText: async () => "sent",
    updateCard: async () => {},
    createTask: async () => {
      throw new Error("unused");
    },
    getTask: async () => {
      throw new Error("unused");
    },
    updateTask: async () => {},
    createGroup: async () => "group",
    deleteGroup: async () => {},
  };
  return {
    platform,
    handlers: () => {
      assert.ok(handlers);
      return handlers;
    },
    stopped: () => stopped,
    card: () => {
      assert.ok(card);
      return card;
    },
  };
}
function cardAction(card: Record<string, unknown>): CardAction {
  const elements = card.elements as Array<{ actions?: Array<{ value: Record<string, unknown> }> }>;
  const value = elements[1]?.actions?.[0]?.value;
  assert.ok(value);
  return { eventId: "a", ownerId: "owner", chatId: "chat", messageId: "card-id", value };
}

test("verification requires both owner DM and exact nonce/card callback", async () => {
  const mock = fake();
  const phases: string[] = [];
  const result = await verifyPlatform(mock.platform, {
    signal: new AbortController().signal,
    expectedOwnerId: "owner",
    inboundTimeoutMs: 100,
    cardTimeoutMs: 100,
    onPhase: (phase) => {
      phases.push(phase);
      if (phase === "message")
        void (async () => {
          await mock.handlers().message({ ...message, ownerId: "stranger" });
          await mock.handlers().message({ ...message, chatType: "group" });
          await mock.handlers().message(message);
        })();
      if (phase === "card")
        void (async () => {
          const action = cardAction(mock.card());
          await mock.handlers().action({ ...action, messageId: "stale-card" });
          await mock.handlers().action({ ...action, ownerId: "stranger" });
          await mock.handlers().action(action);
        })();
    },
  });
  assert.deepEqual(result, { inboundOK: true, cardOK: true, ownerId: "owner", chatId: "chat" });
  assert.deepEqual(phases, ["connecting", "message", "card", "verified"]);
  assert.equal(mock.stopped(), true);
});

test("missing card round trip stays partial and always closes temporary connection", async () => {
  const mock = fake();
  const result = await verifyPlatform(mock.platform, {
    signal: new AbortController().signal,
    inboundTimeoutMs: 10,
    cardTimeoutMs: 5,
    onPhase: (phase) => {
      if (phase === "message") void mock.handlers().message(message);
    },
  });
  assert.equal(result.inboundOK, true);
  assert.equal(result.cardOK, false);
  assert.equal(mock.stopped(), true);
});
