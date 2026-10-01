import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { SessionService } from "../../src/runtime/index.js";
import type { ConversationEngine, EngineResult, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

const tool: RuntimeTool = {
  name: "task_create",
  description: "Register a task",
  readOnly: false,
  parameters: { type: "object", properties: {} },
  execute: async () => ({ accepted: true }),
};

for (const scenario of [
  { name: "confirmed write", successfulWrites: 1, writeCalls: 1, unknown: 0, outcome: "unknown" },
  { name: "unknown effect", successfulWrites: 0, writeCalls: 1, unknown: 1, outcome: "unknown" },
  {
    name: "definitely refused write",
    successfulWrites: 0,
    writeCalls: 1,
    unknown: 0,
    outcome: "not_executed",
  },
  { name: "read only", successfulWrites: 0, writeCalls: 0, unknown: 0, outcome: "not_executed" },
  { name: "legacy write evidence", writeCalls: 1, unknown: 0, outcome: "unknown" },
]) {
  test(`session claim rejection preserves ${scenario.name} outcome`, async () => {
    const store = new Store(":memory:");
    const result: EngineResult = {
      text: "飞书任务已创建，任务群已建立。",
      messages: [],
      toolCalls: 1,
      writeCalls: scenario.writeCalls,
      ...(scenario.successfulWrites === undefined
        ? {}
        : {
            toolEvidence: {
              successful: scenario.successfulWrites,
              successfulWrites: scenario.successfulWrites,
              unknown: scenario.unknown,
              notExecuted: scenario.successfulWrites || scenario.unknown ? 0 : 1,
              provisioning: { created: [], tasks: [] },
            },
          }),
    };
    const engine: ConversationEngine = {
      contextTokens: 50_000,
      summarize: async () => "",
      run: async () => result,
    };
    const sessions = new SessionService(store, engine, { tools: () => [tool] });
    try {
      const session = sessions.current("owner", "entry");
      await assert.rejects(
        sessions.reply(
          { ownerId: "owner", chatId: "entry", sessionId: session.id, messageId: "request" },
          "创建任务",
        ),
        (error: unknown) =>
          error instanceof OperationError &&
          error.code === "model_failed" &&
          error.outcome === scenario.outcome,
      );
      assert.equal(
        sessions.history("owner", session.id).some((message) => message.role === "assistant"),
        false,
      );
    } finally {
      store.close();
    }
  });
}
