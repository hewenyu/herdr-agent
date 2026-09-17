import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../../src/app/logger.js";
import { OperationError } from "../../src/core/errors.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type { RuntimeTool } from "../../src/runtime/types.js";
import { config, response, scripted } from "./helpers.js";

test("pi logs distinguish plain replies, actual tool calls and failures without conversation data", async () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const tool: RuntimeTool = {
    name: "write",
    description: "write",
    parameters: { type: "object", properties: { secret: { type: "string" } } },
    readOnly: false,
    execute: async () => {
      throw new OperationError("declined", "DO_NOT_LOG_ERROR_BODY");
    },
  };
  const engine = new PiEngine(config, {
    logger,
    streamFn: scripted([
      response("DO_NOT_LOG_REPLY"),
      response("", [
        {
          type: "toolCall",
          id: "call",
          name: "write",
          arguments: { secret: "DO_NOT_LOG_ARGUMENT" },
        },
      ]),
      response("DO_NOT_LOG_REPLY"),
      { ...response(""), stopReason: "error", errorMessage: "DO_NOT_LOG_PROVIDER_ERROR" },
    ]),
  });
  const input = {
    actor: { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "event" },
    sessionId: "session",
    systemPrompt: "DO_NOT_LOG_SYSTEM",
    prompt: "DO_NOT_LOG_PROMPT",
    messages: [],
    tools: [tool],
  };
  await engine.run(input);
  await engine.run(input);
  await assert.rejects(engine.run(input));
  const records = lines.map((line) => JSON.parse(line));
  const completed = records.filter((record) => record.event === "pi.turn_completed");
  assert.deepEqual(
    completed.map((record) => [record.toolCalls, record.writeCalls]),
    [
      [0, 0],
      [1, 1],
    ],
  );
  assert.equal(records.filter((record) => record.event === "pi.tool_started").length, 1);
  assert.equal(records.find((record) => record.event === "pi.tool_failed")?.code, "declined");
  assert.equal(records.find((record) => record.event === "pi.turn_failed")?.code, "model_failed");
  assert.ok(
    records.every((record) => record.sessionId === "session" && record.messageId === "event"),
  );
  assert.ok(!lines.join("\n").includes("DO_NOT_LOG"));
  assert.ok(!lines.join("\n").includes(config.apiKey));
});
