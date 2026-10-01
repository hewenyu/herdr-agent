import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import { runTaskLeader } from "../../src/orchestration/leader-session.js";
import { boundCheckpointMessages } from "../../src/orchestration/leader-session-journal.js";
import type { ConversationEngine } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { response } from "../runtime/helpers.js";

function result(id: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "inspect",
    content: [{ type: "text", text: '{"ok":true}' }],
    isError: false,
    timestamp: 1,
  };
}

function assertClosed(messages: AgentMessage[]) {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      assert.equal(pending.size, 0, "prior tool batch must be closed");
      for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
    } else if (message.role === "toolResult") {
      assert.ok(pending.delete(message.toolCallId), "a kept tool result must have its kept call");
    } else assert.equal(pending.size, 0, "non-tool messages must not interrupt a tool batch");
  }
  assert.equal(pending.size, 0, "the checkpoint ends with a closed batch");
}

test("Leader checkpoint message-count reduction retains only complete tool batches", () => {
  const ids = Array.from({ length: 90 }, (_, index) => `call-${index}`);
  const messages = [
    response(
      "",
      ids.map((id) => ({ type: "toolCall" as const, id, name: "inspect", arguments: {} })),
    ),
    ...ids.map(result),
  ];
  const checkpoint = boundCheckpointMessages(messages, 262144, 80);
  assert.ok(checkpoint.messages.length <= 80);
  assertClosed(checkpoint.messages);
});

test("Leader checkpoint summaries count toward the whole durable byte budget", () => {
  const messages: AgentMessage[] = Array.from({ length: 4 }, (_, index) => ({
    role: "user",
    content: `history-${index}:${"x".repeat(250)}`,
    timestamp: 1,
  }));
  const checkpoint = boundCheckpointMessages(messages, 512, 80);
  const actual = Buffer.byteLength(JSON.stringify(checkpoint.messages));
  assert.equal(checkpoint.bytes, actual, "reported size must match the exact persisted array");
  assert.ok(actual <= 512, `summary-inclusive checkpoint exceeded its budget: ${actual}`);
});

test("Leader checkpoint byte accounting measures the entire kept array exactly", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "first", timestamp: 1 },
    { role: "user", content: "second", timestamp: 2 },
  ];
  const checkpoint = boundCheckpointMessages(messages, 1024, 80);
  assert.equal(checkpoint.bytes, Buffer.byteLength(JSON.stringify(checkpoint.messages)));
});

test("Leader recovery cannot lose the current mandatory request behind the message-count cap", async () => {
  const store = new Store(":memory:");
  const marker =
    "HARD_CONSTRAINT: no deployment, no directory widening, no close without acceptance";
  let calls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      calls++;
      if (calls === 1) {
        const checkpoint: AgentMessage[] = [{ role: "user", content: input.prompt, timestamp: 1 }];
        for (let index = 0; index < 45; index++) {
          const id = `read-${index}`;
          checkpoint.push(
            response("", [{ type: "toolCall", id, name: "inspect", arguments: {} }]),
            result(id),
          );
        }
        await input.onCheckpoint?.(checkpoint);
        throw new OperationError("model_failed", "offline interrupted request", "not_executed");
      }
      assert.equal(input.resume, true);
      assert.ok(
        JSON.stringify(input.messages).includes(marker),
        "resume ignores input.prompt: the complete current constraints must remain in model messages",
      );
      assertClosed(input.messages);
      return { text: "约束保持不变。", messages: input.messages };
    },
  };
  const input = {
    store,
    engine,
    actor: {
      ownerId: "owner",
      chatId: "chat",
      sessionId: "management",
      messageId: "request",
      taskId: "task-checkpoint",
    },
    eventId: "event",
    revision: "revision",
    systemPrompt: "Follow all current mandatory requirements without granting new authority.",
    prompt: marker,
    tools: [],
  };
  try {
    await assert.rejects(runTaskLeader(input), { code: "model_failed" });
    await runTaskLeader(input);
    assert.equal(calls, 2);
  } finally {
    store.close();
  }
});
