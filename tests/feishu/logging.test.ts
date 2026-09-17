import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventDispatcher } from "@larksuiteoapi/node-sdk";
import { Inbox } from "../../src/app/inbox.js";
import { createLogger } from "../../src/app/logger.js";
import { sdkLogger } from "../../src/feishu/api.js";
import { FeishuPlatform, type PlatformDependencies } from "../../src/feishu/platform.js";
import { Store } from "../../src/storage/store.js";

test("SDK event to durable inbox and connection transitions are traceable without transport secrets", async () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const store = new Store(":memory:");
  const inbox = new Inbox(store, async () => {}, logger);
  let dispatcher: EventDispatcher | undefined;
  let callbacks: Parameters<NonNullable<PlatformDependencies["connection"]>>[0] | undefined;
  const platform = new FeishuPlatform(
    { appId: "cli_test", appSecret: "credential-secret", logger },
    {
      request: async () => ({ code: 0, bot: { open_id: "bot" } }),
      connection: (input) => {
        callbacks = input;
        return {
          start: async (input) => {
            dispatcher = input.eventDispatcher;
            callbacks?.onReady();
          },
          close() {},
        };
      },
    },
  );
  try {
    await platform.start(
      {
        message: async (message) => {
          inbox.enqueue("message", message.messageId, message);
        },
        action: async () => {},
        taskChanged: async () => {},
      },
      new AbortController().signal,
    );
    assert.ok(dispatcher);
    assert.ok(callbacks);
    const event = {
      schema: "2.0",
      header: { app_id: "cli_test", event_id: "event-1", event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "owner" } },
        message: {
          message_id: "m1",
          chat_id: "chat",
          chat_type: "p2p",
          message_type: "text",
          content: '{"text":"private-body"}',
        },
      },
    };
    await dispatcher.invoke(event, { needCheck: false });
    await dispatcher.invoke(event, { needCheck: false });
    await inbox.drain();
    callbacks.onReconnecting();
    callbacks.onReconnected();
    callbacks.onError(new Error("wss://api.test/?access_key=url-secret credential-secret"));
    const sdk = sdkLogger(logger);
    for (const level of ["info", "debug", "trace", "warn", "error"] as const)
      sdk[level]("https://api.test/?token=url-secret", {
        body: "private-body",
        secret: "credential-secret",
      });
    const logs = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      logs.filter((entry) => entry.event).map((entry) => entry.event),
      [
        "feishu.connection_ready",
        "feishu.message_received",
        "inbox.accepted",
        "feishu.message_received",
        "inbox.duplicate",
        "inbox.processing",
        "inbox.completed",
        "feishu.reconnecting",
        "feishu.reconnected",
        "feishu.connection_failed",
      ],
    );
    assert.equal(
      logs.find((entry) => entry.event === "feishu.message_received")?.eventId,
      "event-1",
    );
    assert.doesNotMatch(
      lines.join("\n"),
      /private-body|credential-secret|url-secret|access_key|api\.test/,
    );
    await platform.stop();
    const count = lines.length;
    callbacks.onReady();
    callbacks.onReconnecting();
    callbacks.onReconnected();
    callbacks.onError(new Error("late"));
    assert.equal(
      lines.length,
      count,
      "stale connection callbacks must not claim current readiness",
    );
  } finally {
    await platform.stop();
    await inbox.shutdown();
    store.close();
  }
});
