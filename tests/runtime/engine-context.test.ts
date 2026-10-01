import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { MODEL_RESULT_MAX_BYTES } from "../../src/runtime/model-context.js";
import type { RuntimeTool } from "../../src/runtime/types.js";
import { config, response, scripted } from "./helpers.js";

const actor: ActorContext = {
  ownerId: "owner",
  chatId: "chat",
  sessionId: "session",
  messageId: "message",
};

const giantText = (bytes: number): string => "x".repeat(bytes);
const bytesOf = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");

function textOf(message: AgentMessage | undefined): string {
  if (!message) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "",
    )
    .join("\n");
}

function tool(name: string, execute: RuntimeTool["execute"], readOnly = true): RuntimeTool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    readOnly,
    execute,
  };
}

function baseInput(tools: RuntimeTool[]) {
  return {
    actor,
    sessionId: "session",
    systemPrompt: "Only orchestrate",
    messages: [] as AgentMessage[],
    prompt: "查询任务状态",
    tools,
  };
}

// ---------------------------------------------------------------------------
// First giant result: the very first tool result already exceeds the budget.
// ---------------------------------------------------------------------------

test("a first giant tool result is projected before the model sees it", async () => {
  const payload = { outcome: "successful", taskId: "task", entries: giantText(400_000) };
  const requests: number[] = [];
  let projections = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response("", [{ type: "toolCall", id: "call", name: "bulk_read", arguments: {} }]),
        response("已根据工具结果核对。"),
      ],
      (context) => requests.push(Buffer.byteLength(JSON.stringify(context.messages), "utf8")),
    ),
  });
  const result = await engine.run({
    ...baseInput([tool("bulk_read", async () => payload)]),
    projectToolResult: (input) => {
      projections++;
      return { reference: "rt_durable_1", bytes: bytesOf(input.result), omitted: "正文已省略" };
    },
  });
  assert.ok(projections >= 1, "the durable projection seam is invoked");
  assert.ok(requests.length >= 2, "both the tool round and the final answer are requested");
  for (const bytes of requests) assert.ok(bytes < 100_000, `request carried ${bytes} bytes`);
  const toolResult = result.messages.find((message) => message.role === "toolResult");
  assert.ok(bytesOf(toolResult) <= MODEL_RESULT_MAX_BYTES);
  assert.match(textOf(toolResult), /rt_durable_1/);
});

// ---------------------------------------------------------------------------
// Recovered result: a resume replays a persisted oversized receipt, which must
// be bounded before it reaches any new provider request.
// ---------------------------------------------------------------------------

test("a recovered oversized receipt is bounded before the resumed request", async () => {
  const requests: number[] = [];
  const recovered: AgentMessage[] = [
    { role: "user", content: "查询任务状态", timestamp: 1 },
    {
      role: "assistant",
      api: "openai-responses",
      provider: "myrix",
      model: "test",
      content: [{ type: "toolCall", id: "call", name: "task_get", arguments: {} }],
      stopReason: "toolUse",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 2,
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "task_get",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            outcome: "successful",
            taskId: "task",
            entries: giantText(300_000),
          }),
        },
      ],
      isError: false,
      timestamp: 3,
    } as AgentMessage,
  ];
  const engine = new PiEngine(config, {
    streamFn: scripted([response("已根据工具结果核对。")], (context) =>
      requests.push(Buffer.byteLength(JSON.stringify(context.messages), "utf8")),
    ),
  });
  await engine.run({
    ...baseInput([tool("task_get", async () => ({ accepted: true }))]),
    messages: recovered,
    resume: true,
  });
  assert.ok(requests.length >= 1);
  for (const bytes of requests)
    assert.ok(bytes < 100_000, `resumed request carried ${bytes} bytes`);
});

// ---------------------------------------------------------------------------
// Projection failure after a successful write must not replay the write.
// ---------------------------------------------------------------------------

test("a projection failure after a successful write never replays the write", async () => {
  let writes = 0;
  let projections = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [
        { type: "toolCall", id: "call", name: "task_create", arguments: { title: "审计" } },
      ]),
      response("已登记。"),
    ]),
  });
  const result = await engine.run({
    ...baseInput([
      tool(
        "task_create",
        async () => {
          writes++;
          return { outcome: "successful", taskId: "task-1" };
        },
        false,
      ),
    ]),
    projectToolResult: () => {
      projections++;
      throw new Error("durable store unavailable");
    },
  });
  assert.equal(projections, 1, "the projection was attempted");
  assert.equal(writes, 1, "the confirmed write is never replayed");
  assert.equal(result.toolEvidence?.successful, 1);
  assert.equal(result.toolEvidence?.successfulWrites, 1);
  const toolResult = result.messages.find((message) => message.role === "toolResult");
  assert.ok(bytesOf(toolResult) <= MODEL_RESULT_MAX_BYTES);
  assert.match(textOf(toolResult), /task-1/, "the canonical facts survive the failed projection");
});

test("a projection returning an oversized value cannot smuggle it into a request", async () => {
  const requests: number[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response("", [{ type: "toolCall", id: "call", name: "task_get", arguments: {} }]),
        response("已核对。"),
      ],
      (context) => requests.push(Buffer.byteLength(JSON.stringify(context.messages), "utf8")),
    ),
  });
  const result = await engine.run({
    ...baseInput([tool("task_get", async () => ({ outcome: "successful", id: "t1" }))]),
    projectToolResult: () => ({ outcome: "successful", blob: giantText(500_000) }),
  });
  for (const bytes of requests) assert.ok(bytes < 100_000, `request carried ${bytes} bytes`);
  const toolResult = result.messages.find((message) => message.role === "toolResult");
  assert.ok(bytesOf(toolResult) <= MODEL_RESULT_MAX_BYTES);
});

// ---------------------------------------------------------------------------
// Giant error envelopes: errors are bounded and keep their typed outcome.
// ---------------------------------------------------------------------------

test("a giant error envelope is bounded and keeps its typed outcome", async () => {
  const requests: number[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response("", [{ type: "toolCall", id: "call", name: "task_get", arguments: {} }]),
        response("结果未知，请查询状态。"),
      ],
      (context) => requests.push(Buffer.byteLength(JSON.stringify(context.messages), "utf8")),
    ),
  });
  const result = await engine.run(
    baseInput([
      tool("task_get", async () => {
        throw new OperationError("transport", giantText(300_000), "unknown");
      }),
    ]),
  );
  for (const bytes of requests) assert.ok(bytes < 100_000, `request carried ${bytes} bytes`);
  const toolResult = result.messages.find((message) => message.role === "toolResult");
  assert.ok(toolResult && toolResult.role === "toolResult");
  assert.equal(toolResult.isError, true);
  assert.ok(bytesOf(toolResult) <= MODEL_RESULT_MAX_BYTES);
  assert.match(textOf(toolResult), /transport/);
  assert.equal(result.toolEvidence?.unknown, 1, "the typed outcome is preserved");
});

test("error envelopes never inflate details beyond the byte budget", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "call", name: "task_get", arguments: {} }]),
      response("已核对。"),
    ]),
  });
  const result = await engine.run({
    ...baseInput([
      tool("task_get", async () => {
        throw new OperationError("transport", giantText(200_000), "unknown");
      }),
    ]),
    projectToolResult: (input) => ({
      // A projection may echo facts, but not the giant body.
      outcome: "unknown",
      isError: input.isError === true,
      omitted: "错误详情已省略",
    }),
  });
  const toolResult = result.messages.find((message) => message.role === "toolResult");
  assert.ok(bytesOf(toolResult) <= MODEL_RESULT_MAX_BYTES);
  const body = JSON.parse(textOf(toolResult)) as Record<string, unknown>;
  assert.equal(body.outcome, "unknown");
  assert.equal(body.isError, true);
});

// ---------------------------------------------------------------------------
// Low / small budget: a typed context_budget, never a generic retryable error.
// ---------------------------------------------------------------------------

test("an unprojectable oversized result reports a typed context_budget", async () => {
  const engine = new PiEngine(
    { ...config, contextTokens: 3000 },
    {
      streamFn: scripted([
        response("", [{ type: "toolCall", id: "call", name: "bulk_read", arguments: {} }]),
      ]),
    },
  );
  await assert.rejects(
    engine.run(baseInput([tool("bulk_read", async () => ({ entries: giantText(2_000_000) }))])),
    (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "context_budget");
      return true;
    },
  );
});

test("a low budget still serves a bounded projected result", async () => {
  const requests: number[] = [];
  const engine = new PiEngine(
    { ...config, contextTokens: 8000 },
    {
      streamFn: scripted(
        [
          response("", [{ type: "toolCall", id: "call", name: "bulk_read", arguments: {} }]),
          response("已根据工具结果核对。"),
        ],
        (context) => requests.push(Buffer.byteLength(JSON.stringify(context.messages), "utf8")),
      ),
    },
  );
  const result = await engine.run({
    ...baseInput([
      tool("bulk_read", async () => ({ outcome: "successful", entries: giantText(200_000) })),
    ]),
    projectToolResult: () => ({ reference: "rt_small", omitted: "正文已省略" }),
  });
  assert.ok(requests.length >= 2);
  for (const bytes of requests) assert.ok(bytes < 100_000, `request carried ${bytes} bytes`);
  const toolResult = result.messages.find((message) => message.role === "toolResult");
  assert.ok(bytesOf(toolResult) <= MODEL_RESULT_MAX_BYTES);
});

test("tool schemas are charged to the budget before messages", async () => {
  // With a large schema and a small window, the request still must not exceed
  // the configured context: schemas are part of the budget, not free.
  const engine = new PiEngine(
    { ...config, contextTokens: 4000 },
    {
      streamFn: scripted([
        response("", [{ type: "toolCall", id: "call", name: "huge_schema", arguments: {} }]),
      ]),
    },
  );
  const schemaTool: RuntimeTool = {
    name: "huge_schema",
    description: giantText(200_000),
    parameters: { type: "object", properties: {} },
    readOnly: true,
    execute: async () => ({ entries: giantText(200_000) }),
  };
  await assert.rejects(engine.run(baseInput([schemaTool])), (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, "context_budget");
    return true;
  });
});

// ---------------------------------------------------------------------------
// Existing claim / retry behavior is preserved by the new seam.
// ---------------------------------------------------------------------------

test("the projection seam does not weaken claim enforcement", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "call", name: "task_get", arguments: {} }]),
    ]),
  });
  await assert.rejects(
    engine.run({
      ...baseInput([tool("task_get", async () => ({ outcome: "unknown", code: "transport" }))]),
      projectToolResult: () => ({ outcome: "unknown", code: "transport" }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "model_failed");
      return true;
    },
  );
});

test("an unknown write still blocks later writes when projection succeeds", async () => {
  let writes = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "call", name: "task_create", arguments: {} }]),
      response("", [{ type: "toolCall", id: "call2", name: "task_create", arguments: {} }]),
      response("状态未知，请查询。"),
    ]),
  });
  const result = await engine.run({
    ...baseInput([
      tool(
        "task_create",
        async () => {
          writes++;
          return writes === 1 ? { outcome: "unknown" } : { accepted: true };
        },
        false,
      ),
    ]),
    projectToolResult: (input) => input.result,
  });
  assert.equal(writes, 1, "an uncertain write must block the next write");
  assert.equal(result.toolEvidence?.unknown, 1);
});

test("per-call error flags reach the model through the documented hook", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "call", name: "task_get", arguments: {} }]),
      response("已核对。"),
    ]),
  });
  const result = await engine.run(
    baseInput([
      tool("task_get", async () => {
        throw new OperationError("not_found", "任务不存在", "not_executed");
      }),
    ]),
  );
  const toolResult = result.messages.find((message) => message.role === "toolResult");
  assert.ok(toolResult && toolResult.role === "toolResult");
  assert.equal(toolResult.isError, true, "a failed call is marked as an error for the model");
  assert.equal(result.toolEvidence?.notExecuted, 1);
});
