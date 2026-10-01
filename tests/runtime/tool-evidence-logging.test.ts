import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "../../src/app/logger.js";
import { OperationError } from "../../src/core/errors.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type { RuntimeTool } from "../../src/runtime/types.js";
import { config, response, scripted } from "./helpers.js";

type Record_ = Record<string, unknown>;

function harness(streamFn: ReturnType<typeof scripted>, tools: RuntimeTool[]) {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const engine = new PiEngine(config, { logger, streamFn });
  return {
    lines,
    records: () => lines.map((line) => JSON.parse(line) as Record_),
    run: () =>
      engine.run({
        actor: { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "event" },
        sessionId: "session",
        systemPrompt: "Only orchestrate",
        prompt: "查询当前状态",
        messages: [],
        tools,
        // Isolate diagnostics from claim recovery, which would append turns.
        enforceClaims: false,
      }),
  };
}

const counters = (record: Record_) => ({
  successfulToolCalls: record.successfulToolCalls,
  successfulWriteCalls: record.successfulWriteCalls,
  unknownToolResults: record.unknownToolResults,
  notExecutedToolResults: record.notExecutedToolResults,
});

test("engine logs flattened primitive tool evidence and never the nested result", async () => {
  const tool: RuntimeTool = {
    name: "task_get",
    description: "task_get",
    readOnly: true,
    parameters: { type: "object", properties: { taskId: { type: "string" } } },
    execute: async () => ({
      id: "task_untrusted_id",
      chatId: "chat_untrusted_id",
      status: "running",
      token: "private-token",
      participants: [{ id: "claude-1", name: "Claude", sent: true }],
      outcome: "successful",
    }),
  };
  const h = harness(
    scripted([
      response("", [{ type: "toolCall", id: "call-1", name: "task_get", arguments: {} }]),
      response("当前任务正在运行。"),
    ]),
    [tool],
  );
  const result = await h.run();
  assert.equal(result.toolEvidence?.successful, 1);
  const records = h.records();
  const completed = records.find((record) => record.event === "pi.tool_completed");
  assert.deepEqual(counters(completed ?? {}), {
    successfulToolCalls: 1,
    successfulWriteCalls: 0,
    unknownToolResults: 0,
    notExecutedToolResults: 0,
  });
  const turn = records.find((record) => record.event === "pi.turn_completed");
  assert.deepEqual(counters(turn ?? {}), {
    successfulToolCalls: 1,
    successfulWriteCalls: 0,
    unknownToolResults: 0,
    notExecutedToolResults: 0,
  });
  // The logger keeps only primitives, so nested diagnostic evidence is dropped
  // even when the engine hands it over; the flat counters are what survives.
  assert.ok(
    records
      .filter((record) => Object.hasOwn(record, "toolEvidence"))
      .every((record) =>
        Object.keys(record.toolEvidence as object).every((key) =>
          ["successful", "successfulWrites", "unknown", "notExecuted"].includes(key),
        ),
      ),
  );
  const text = h.lines.join("\n");
  assert.doesNotMatch(text, /task_untrusted_id|chat_untrusted_id|private-token|claude-1/);
});

test("failed tools count in their own diagnostic line and on the turn failure", async () => {
  const tool: RuntimeTool = {
    name: "task_action",
    description: "task_action",
    readOnly: false,
    parameters: { type: "object", properties: { action: { type: "string" } } },
    execute: async () => {
      throw new OperationError("declined", "private-body");
    },
  };
  const h = harness(
    scripted([
      response("", [{ type: "toolCall", id: "call-1", name: "task_action", arguments: {} }]),
      { ...response(""), stopReason: "error", errorMessage: "private-provider-error" },
    ]),
    [tool],
  );
  await assert.rejects(h.run());
  const records = h.records();
  const failed = records.find((record) => record.event === "pi.tool_failed");
  assert.equal(failed?.code, "declined");
  assert.deepEqual(counters(failed ?? {}), {
    successfulToolCalls: 0,
    successfulWriteCalls: 0,
    unknownToolResults: 0,
    notExecutedToolResults: 1,
  });
  const turn = records.find((record) => record.event === "pi.turn_failed");
  assert.equal(turn?.code, "model_failed");
  assert.deepEqual(counters(turn ?? {}), {
    successfulToolCalls: 0,
    successfulWriteCalls: 0,
    unknownToolResults: 0,
    notExecutedToolResults: 1,
  });
  // A raw Logger still receives the legacy nested shape (covered by the
  // provision-evidence tests); createLogger drops it and keeps only the flat
  // counters, which is exactly why the flattened fields exist.
  assert.equal(turn?.toolEvidence, undefined);
  assert.doesNotMatch(h.lines.join("\n"), /private-body|private-provider-error/);
});

test("unknown effects are reported as a primitive counter, not as evidence objects", async () => {
  const tool: RuntimeTool = {
    name: "task_create",
    description: "task_create",
    readOnly: false,
    parameters: { type: "object", properties: { title: { type: "string" } } },
    execute: async () => ({
      error: { code: "transport_failed", outcome: "unknown", message: "private-body" },
      token: "private-token",
    }),
  };
  const h = harness(
    scripted([
      response("", [{ type: "toolCall", id: "call-1", name: "task_create", arguments: {} }]),
      response("状态未知，请稍后查询。"),
    ]),
    [tool],
  );
  const result = await h.run();
  assert.equal(result.toolEvidence?.unknown, 1);
  const completed = h.records().find((record) => record.event === "pi.tool_completed");
  assert.deepEqual(counters(completed ?? {}), {
    successfulToolCalls: 0,
    successfulWriteCalls: 0,
    unknownToolResults: 1,
    notExecutedToolResults: 0,
  });
  assert.doesNotMatch(h.lines.join("\n"), /private-body|private-token|transport_failed/);
});
