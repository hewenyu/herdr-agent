import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import {
  boundCheckpointMessages,
  boundRecoveryValue,
  RECOVERY_RESULT_MAX_BYTES,
} from "../../src/runtime/recovery.js";
import { SessionService } from "../../src/runtime/sessions.js";
import type { ConversationEngine, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { response } from "./helpers.js";

function result(text: string, toolCallId = "call"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "inspect",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

function boundedOrTyped(run: () => AgentMessage[], expectedId = "call") {
  let messages: AgentMessage[];
  try {
    messages = run();
  } catch (error) {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, "context_budget");
    return;
  }
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    assert.equal(message.toolCallId, expectedId, "a protocol identity must not be truncated");
    assert.ok(
      Buffer.byteLength(JSON.stringify(message)) <= RECOVERY_RESULT_MAX_BYTES,
      "the complete persisted tool-result message, including JSON escaping, must fit",
    );
  }
}

test("recovery fallback bounds nested error metadata without promoting its outcome", () => {
  const canonical = {
    outcome: "not_executed",
    error: { code: "🔒".repeat(10000), message: "failed", outcome: "not_executed" },
  };
  for (const budget of [512, RECOVERY_RESULT_MAX_BYTES]) {
    const bounded = boundRecoveryValue(canonical, budget) as { outcome?: string };
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= budget);
    assert.equal(bounded.outcome, "not_executed");
  }
});

test("persisted recovery checkpoints bound the whole escaped result envelope", () => {
  const text = JSON.stringify({ body: "\\".repeat(6000) });
  boundedOrTyped(() => boundCheckpointMessages([result(text)]));
});

test("non-JSON legacy tool text cannot evade the persisted whole-message budget", () => {
  boundedOrTyped(() => boundCheckpointMessages([result(`legacy ${"\u0000".repeat(6000)}`)]));
});

test("irreducible recovered call identity fails closed rather than changing the batch", () => {
  const id = `call-${"🔒".repeat(5000)}`;
  boundedOrTyped(
    () =>
      boundCheckpointMessages([
        response("", [{ type: "toolCall", name: "inspect", id, arguments: {} }]),
        result("{}", id),
      ]),
    id,
  );
});

test("recovery does not trust an oversized custom projection as a bounded checkpoint", () => {
  boundedOrTyped(() =>
    boundCheckpointMessages([result(JSON.stringify({ body: "x".repeat(30000) }))], {
      project: () => ({ body: "\\".repeat(60000) }),
    }),
  );
});

test("context-reduction retry restores missing tool results from exact completed receipts", async () => {
  const store = new Store(":memory:");
  let engineCalls = 0;
  let writes = 0;
  const large = { accepted: true, body: "x".repeat(100000) };
  const confirmed = { accepted: true, id: "committed-second-write" };
  const tools: RuntimeTool[] = ["large_write", "small_write"].map((name) => ({
    name,
    description: name,
    readOnly: false,
    parameters: { type: "object", properties: {} },
    execute: async () => {
      writes++;
      return name === "large_write" ? large : confirmed;
    },
  }));
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      engineCalls++;
      if (engineCalls === 1) {
        for (const name of ["large_write", "small_write"]) {
          const tool = input.tools.find((entry) => entry.name === name);
          assert.ok(tool);
          await tool.execute({}, input.actor);
        }
        await input.onCheckpoint?.([
          { role: "user", content: input.prompt, timestamp: 1 },
          response("", [
            { type: "toolCall", name: "large_write", id: "large", arguments: {} },
            { type: "toolCall", name: "small_write", id: "small", arguments: {} },
          ]),
          {
            role: "toolResult",
            toolCallId: "large",
            toolName: "large_write",
            content: [{ type: "text", text: JSON.stringify(large) }],
            isError: false,
            timestamp: 2,
          },
          // A crash after the second canonical receipt but before its model result.
        ]);
        throw new OperationError("context_budget", "reduce the durable context", "not_executed");
      }
      assert.equal(input.resume, true);
      const recovered = input.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "small",
      );
      assert.ok(recovered?.role === "toolResult");
      assert.equal(recovered.isError, false, "a completed receipt is not an unexecuted call");
      const text = recovered.content.find((part) => part.type === "text");
      assert.ok(text?.type === "text");
      assert.deepEqual(JSON.parse(text.text), confirmed);
      return {
        text: "两次操作均已确认。",
        messages: input.messages,
        toolCalls: 2,
        writeCalls: 2,
        toolEvidence: { successful: 2, successfulWrites: 2, unknown: 0, notExecuted: 0 },
      };
    },
  };
  try {
    const sessions = new SessionService(store, engine, { tools: () => tools });
    const session = sessions.current("owner", "chat");
    await sessions.reply(
      { ownerId: "owner", chatId: "chat", sessionId: session.id, messageId: "request" },
      "记录两次操作",
    );
    assert.equal(engineCalls, 2);
    assert.equal(writes, 2, "recovery never reissues either completed write");
  } finally {
    store.close();
  }
});
