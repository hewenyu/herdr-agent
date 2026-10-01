import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import {
  boundModelValue,
  boundToolResultMessage,
  MODEL_OUTPUT_RESERVE_TOKENS,
  MODEL_REQUEST_OVERHEAD_TOKENS,
  MODEL_RESULT_MAX_BYTES,
  modelInputBudgetTokens,
  prefix,
  serialize,
  serializedBytes,
} from "../../src/runtime/model-context.js";

const giantText = (bytes: number): string => "x".repeat(bytes);
const bytesOf = (value: unknown): number => Buffer.byteLength(serialize(value) ?? "", "utf8");

test("the frozen model-result budget is 16KiB", () => {
  assert.equal(MODEL_RESULT_MAX_BYTES, 16384);
});

test("a value within budget is returned unchanged, by reference", () => {
  const small = { accepted: true, nested: { id: "task-1" } };
  assert.equal(boundModelValue(small), small);
  assert.deepEqual(boundModelValue(small), small);
  const array = [1, 2, 3];
  assert.equal(boundModelValue(array), array);
  assert.equal(boundModelValue("short text"), "short text");
  assert.equal(boundModelValue(null), null);
  assert.equal(boundModelValue(undefined), undefined);
});

test("the bound applies to the FULL serialized value, not just the body", () => {
  // JSON escaping can inflate a value well past its raw character count.
  const escaped = { outcome: "unknown", blob: '"'.repeat(40_000) };
  assert.ok(bytesOf(escaped) > MODEL_RESULT_MAX_BYTES);
  const bounded = boundModelValue(escaped);
  assert.ok(
    bytesOf(bounded) <= MODEL_RESULT_MAX_BYTES,
    `bounded ${bytesOf(bounded)} bytes must fit the budget`,
  );
});

test("multibyte content cannot smuggle the value past a UTF-8 byte budget", () => {
  const bounded = boundModelValue({ outcome: "unknown", blob: "汉".repeat(40_000) });
  assert.ok(bytesOf(bounded) <= MODEL_RESULT_MAX_BYTES);
  // A stricter budget must also hold, and the prefix helper is byte-based.
  const tiny = boundModelValue({ outcome: "unknown", blob: giantText(50_000) }, 512);
  assert.ok(bytesOf(tiny) <= 512, `tiny marker was ${bytesOf(tiny)} bytes`);
  assert.ok(Buffer.byteLength(prefix("汉字".repeat(100), 7), "utf8") <= 7);
});

test("bounding never promotes an outcome into a silent success", () => {
  for (const outcome of ["unknown", "not_executed", "unconfirmed"] as const) {
    const bounded = boundModelValue({ outcome, code: "transport", blob: giantText(60_000) });
    const record = bounded as Record<string, unknown>;
    assert.equal(record.outcome, outcome, `${outcome} must survive bounding`);
    assert.equal(record.code, "transport");
    assert.equal(record.truncated, true);
    assert.match(String(record.omitted), /省略/);
  }
});

test("a failed result keeps its error facts and never becomes a success envelope", () => {
  const bounded = boundModelValue({
    error: "写入失败",
    outcome: "unknown",
    isError: true,
    entries: giantText(80_000),
  }) as Record<string, unknown>;
  assert.equal(bounded.outcome, "unknown");
  assert.equal(bounded.isError, true);
  assert.equal(bounded.error, "写入失败");
  assert.equal(bounded.accepted, undefined, "no success marker may be invented");
  assert.ok(bytesOf(bounded) <= MODEL_RESULT_MAX_BYTES);
});

test("provisioning evidence survives so a confirmed write is not lost", () => {
  const bounded = boundModelValue({
    outcome: "successful",
    task: {
      id: "task-1",
      remoteTaskId: "remote-9",
      chatId: "chat-7",
      groupDeleted: false,
      participants: [
        { id: "p1", name: "张三", kind: "user", initialDelivery: "confirmed", initialSent: true },
      ],
    },
    entries: giantText(200_000),
  }) as Record<string, unknown>;
  assert.equal(bounded.outcome, "successful");
  const tasks = bounded.tasks as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(tasks), "a provisioning digest must be retained");
  const task = tasks[0] ?? {};
  assert.equal(task.remoteTaskId, "remote-9");
  assert.equal(task.chatId, "chat-7");
  assert.equal(task.groupDeleted, false);
  const participants = task.participants as Array<Record<string, unknown>>;
  assert.equal(participants?.[0]?.initialDelivery, "confirmed");
  assert.ok(bytesOf(bounded) <= MODEL_RESULT_MAX_BYTES);
});

test("an unserializable value becomes an explicit marker, not a crash", () => {
  const cyclic: Record<string, unknown> = { outcome: "unknown" };
  cyclic.self = cyclic;
  const bounded = boundModelValue(cyclic) as Record<string, unknown>;
  assert.equal(bounded.truncated, true);
  assert.match(String(bounded.omitted), /序列化|省略/);
  assert.doesNotThrow(() => serialize(bounded));
  const bigint = boundModelValue({ outcome: "unknown", value: 1n }) as Record<string, unknown>;
  assert.equal(bigint.truncated, true);
});

test("an array result reports its length while bounding the payload", () => {
  const bounded = boundModelValue({
    outcome: "successful",
    items: Array(500).fill(giantText(500)),
  });
  assert.ok(bytesOf(bounded) <= MODEL_RESULT_MAX_BYTES);
  const direct = boundModelValue(Array.from({ length: 400 }, () => giantText(200))) as Record<
    string,
    unknown
  >;
  assert.equal(direct.items, 400);
  assert.ok(bytesOf(direct) <= MODEL_RESULT_MAX_BYTES);
});

test("a strict budget still returns a well-formed marker", () => {
  for (const maxBytes of [64, 256, 1024]) {
    const bounded = boundModelValue({ outcome: "unknown", blob: giantText(20_000) }, maxBytes);
    const size = bytesOf(bounded);
    assert.ok(size <= maxBytes, `budget ${maxBytes} produced ${size} bytes`);
  }
  // Below JSON's smallest value (`null`, 4 bytes) no bounded representation
  // exists: the caller gets a typed failure, never a value that would silently
  // break its byte budget.
  for (const maxBytes of [0, 1, 3]) {
    assert.throws(
      () => boundModelValue({ outcome: "unknown", blob: giantText(20_000) }, maxBytes),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, "context_budget");
        return true;
      },
    );
  }
  assert.equal(boundModelValue({ outcome: "unknown", blob: giantText(20_000) }, 4), null);
});

test("tool-result messages are bounded in place and left alone when small", () => {
  const message = {
    role: "toolResult" as const,
    toolCallId: "call",
    toolName: "task_get",
    content: [{ type: "text" as const, text: JSON.stringify({ outcome: "successful", id: "t1" }) }],
    isError: false,
    timestamp: Date.now(),
  };
  assert.equal(boundToolResultMessage(message), message);

  const oversized = {
    ...message,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ outcome: "unknown", blob: giantText(90_000) }),
      },
    ],
  };
  const bounded = boundToolResultMessage(oversized);
  assert.ok(bounded.role === "toolResult");
  const size = Buffer.byteLength(
    bounded.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    "utf8",
  );
  assert.ok(size <= MODEL_RESULT_MAX_BYTES, `bounded tool result was ${size} bytes`);
  assert.equal(
    JSON.parse(bounded.content[0]?.type === "text" ? bounded.content[0].text : "{}").outcome,
    "unknown",
  );
});

test("the request budget reserves tools, overhead and output space", () => {
  assert.equal(
    modelInputBudgetTokens(50_000),
    50_000 - MODEL_REQUEST_OVERHEAD_TOKENS - MODEL_OUTPUT_RESERVE_TOKENS,
  );
  assert.ok(MODEL_OUTPUT_RESERVE_TOKENS > 0, "output space must be reserved");
  assert.ok(modelInputBudgetTokens(1_000) < 1_000);
  assert.equal(modelInputBudgetTokens(0), 0);
  assert.equal(serializedBytes({ a: 1 }), Buffer.byteLength('{"a":1}', "utf8"));
  assert.equal(serializedBytes(undefined), 4, "undefined serializes as null for budget purposes");
});
