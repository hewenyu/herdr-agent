import assert from "node:assert/strict";
import test from "node:test";
import { PiEngine } from "../../src/runtime/engine.js";
import type { RuntimeTool } from "../../src/runtime/types.js";
import { config, response, scripted } from "./helpers.js";

const cases = [
  {
    name: "legacy unparseable write result",
    text: "connection lost",
    isError: false,
    blocked: true,
  },
  { name: "legacy error text", text: "connection lost", isError: true, blocked: true },
  {
    name: "error without an explicit outcome",
    text: '{"error":"lost"}',
    isError: true,
    blocked: true,
  },
  { name: "explicit unknown effect", text: '{"outcome":"unknown"}', isError: true, blocked: true },
  {
    name: "explicit nonexecution",
    text: '{"outcome":"not_executed"}',
    isError: true,
    blocked: false,
  },
  {
    name: "confirmed successful result",
    text: '{"accepted":true}',
    isError: false,
    blocked: false,
  },
  {
    name: "unknown effect from a removed tool",
    text: '{"outcome":"unknown"}',
    isError: true,
    blocked: true,
    removed: true,
  },
  {
    name: "explicit nonexecution from a removed tool",
    text: '{"outcome":"not_executed"}',
    isError: true,
    blocked: false,
    removed: true,
  },
  {
    name: "confirmed result from a removed tool",
    text: '{"accepted":true}',
    isError: false,
    blocked: false,
    removed: true,
  },
  {
    name: "unparseable read-only result",
    text: "connection lost",
    isError: true,
    blocked: false,
    readOnly: true,
  },
];

for (const scenario of cases)
  test(`recovery preserves write safety for ${scenario.name}`, async () => {
    let writes = 0;
    let reads = 0;
    const parameters = { type: "object", properties: {}, additionalProperties: false };
    const tools: RuntimeTool[] = [
      {
        name: "old_operation",
        description: "Previously attempted operation; must not be replayed",
        parameters,
        readOnly: scenario.readOnly ?? false,
        execute: async () => assert.fail("the previous call must not be replayed"),
      },
      {
        name: "new_write",
        description: "New write after recovery",
        parameters,
        readOnly: false,
        execute: async () => {
          writes++;
          return {};
        },
      },
      {
        name: "read",
        description: "Read-only inspection remains available",
        parameters,
        readOnly: true,
        execute: async () => {
          reads++;
          return {};
        },
      },
    ];
    const engine = new PiEngine(config, {
      streamFn: scripted([
        response("", [{ type: "toolCall", id: "new", name: "new_write", arguments: {} }]),
        response("", [{ type: "toolCall", id: "inspect", name: "read", arguments: {} }]),
        response("结果未确认"),
      ]),
    });
    const result = await engine.run({
      actor: { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "message" },
      sessionId: "session",
      prompt: "核对先前操作",
      systemPrompt: "Use tools and preserve uncertainty",
      tools: scenario.removed ? tools.filter((tool) => tool.name !== "old_operation") : tools,
      resume: true,
      messages: [
        response("", [{ type: "toolCall", id: "old", name: "old_operation", arguments: {} }]),
        {
          role: "toolResult",
          toolCallId: "old",
          toolName: "old_operation",
          content: [{ type: "text", text: scenario.text }],
          isError: scenario.isError,
          timestamp: Date.now(),
        },
      ],
    });
    assert.equal(writes, scenario.blocked ? 0 : 1);
    assert.equal(reads, 1);
    if (scenario.blocked) assert.ok((result.toolEvidence?.unknown ?? 0) > 0);
    if (scenario.removed)
      assert.equal(
        result.toolEvidence?.successfulWrites,
        writes,
        "a missing tool definition cannot prove that an old successful result was a write",
      );
  });
