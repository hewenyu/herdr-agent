import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../../src/app/logger.js";

function capture() {
  const lines: string[] = [];
  return { lines, logger: createLogger((line) => lines.push(line)) };
}

test("logger emits safe primitive counters and keeps secret-bearing keys filtered", () => {
  const h = capture();
  h.logger.info("pi 已生成回复", {
    event: "pi.turn_completed",
    sessionId: "session",
    messageId: "message",
    toolCalls: 4,
    writeCalls: 2,
    successfulToolCalls: 3,
    successfulWriteCalls: 2,
    unknownToolResults: 1,
    notExecutedToolResults: 0,
    durationMs: 12,
    token: "private-token",
    secret: "private-secret",
    apiKey: "private-key",
    prompt: "private-prompt",
    body: "private-body",
  });
  const record = JSON.parse(h.lines[0] ?? "{}") as Record<string, unknown>;
  assert.deepEqual(
    {
      successfulToolCalls: record.successfulToolCalls,
      successfulWriteCalls: record.successfulWriteCalls,
      unknownToolResults: record.unknownToolResults,
      notExecutedToolResults: record.notExecutedToolResults,
    },
    {
      successfulToolCalls: 3,
      successfulWriteCalls: 2,
      unknownToolResults: 1,
      notExecutedToolResults: 0,
    },
  );
  assert.equal(record.event, "pi.turn_completed");
  assert.doesNotMatch(
    h.lines[0] ?? "",
    /private-token|private-secret|private-key|private-prompt|private-body/,
  );
  for (const key of ["token", "secret", "apiKey", "prompt", "body"]) {
    assert.equal(Object.hasOwn(record, key), false, `${key} must not be logged`);
  }
});

test("logger drops nested objects and arrays, including untrusted tool evidence", () => {
  const h = capture();
  const untrusted = {
    secret: "private-secret",
    taskId: "task_leak",
    participants: [{ id: "claude-1", name: "Claude", sent: true }],
    token: "private-token",
  };
  h.logger.error("pi 本轮未完成", {
    event: "pi.turn_failed",
    code: "model_failed",
    outcome: "unknown",
    successfulToolCalls: 0,
    nested: untrusted,
    listed: [untrusted],
  });
  const text = h.lines[0] ?? "";
  const record = JSON.parse(text) as Record<string, unknown>;
  assert.equal(record.code, "model_failed");
  assert.equal(record.successfulToolCalls, 0);
  assert.equal(Object.hasOwn(record, "nested"), false);
  assert.equal(Object.hasOwn(record, "listed"), false);
  assert.equal(Object.hasOwn(record, "toolEvidence"), false);
  assert.doesNotMatch(text, /task_leak|claude-1|private-secret|private-token|participants/);
});

test("logger still redacts URLs inside otherwise primitive fields", () => {
  const h = capture();
  h.logger.warn("请求失败 https://api.test/?access_token=private-key", {
    event: "test.failed",
    detail: "wss://api.test/?token=private-key",
    code: "request_failed",
  });
  const text = h.lines[0] ?? "";
  assert.doesNotMatch(text, /api\.test|private-key/);
  assert.equal(JSON.parse(text).code, "request_failed");
});
