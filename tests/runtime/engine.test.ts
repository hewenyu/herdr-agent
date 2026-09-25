import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type { EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { config, response, scripted } from "./helpers.js";

const actor = { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "message" };
function input(tools: RuntimeTool[] = [], prompt = "创建讨论任务"): EngineInput {
  return {
    actor,
    sessionId: "session",
    prompt,
    messages: [],
    systemPrompt: "Only orchestrate",
    tools,
  };
}
const schema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

function sse(events: Array<{ type: string; [key: string]: unknown }>): Response {
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function openAiResponse(kind: "text" | "tool", text = "已根据工具结果登记。"): Response {
  const responseId = `resp_${kind}`;
  if (kind === "text") {
    return sse([
      { type: "response.created", response: { id: responseId, status: "in_progress" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] },
      },
      { type: "response.output_text.delta", output_index: 0, delta: text },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: responseId,
          status: "completed",
          output: [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]);
  }
  const argumentsJson = JSON.stringify({ title: "新项目" });
  return sse([
    { type: "response.created", response: { id: responseId, status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_create",
        name: "create",
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: argumentsJson },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      arguments: argumentsJson,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_create",
        name: "create",
        arguments: argumentsJson,
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [
          {
            id: "fc_1",
            type: "function_call",
            call_id: "call_create",
            name: "create",
            arguments: argumentsJson,
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

function anthropicResponse(kind: "text" | "tool", text = "已根据工具结果登记。"): Response {
  const content =
    kind === "text"
      ? [
          {
            event: "message_start",
            data: {
              type: "message_start",
              message: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "test",
                content: [],
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
          },
          {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          },
          {
            event: "content_block_delta",
            data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
          },
          { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 5 },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ]
      : [
          {
            event: "message_start",
            data: {
              type: "message_start",
              message: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "test",
                content: [],
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
          },
          {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "call_create", name: "create", input: {} },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify({ title: "新项目" }),
              },
            },
          },
          { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 5 },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ];
  const body = content
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("real pi loop validates tool arguments, binds actor and checkpoints before execution", async () => {
  const order: string[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [
        { type: "toolCall", id: "call", name: "create", arguments: { title: "讨论" } },
      ]),
      response("已登记"),
    ]),
  });
  const result = await engine.run({
    ...input([
      {
        name: "create",
        description: "create",
        parameters: schema,
        readOnly: false,
        execute: async (args, bound) => {
          order.push("execute");
          assert.deepEqual(bound, actor);
          assert.equal(args.title, "讨论");
          return { accepted: true };
        },
      },
    ]),
    onCheckpoint: (messages) => {
      if (messages.some((message) => message.role === "assistant")) order.push("persist");
    },
  });
  assert.equal(result.text, "已登记");
  assert.ok(order.indexOf("persist") < order.indexOf("execute"));
  assert.ok(result.messages.some((message) => message.role === "toolResult"));
  assert.equal(result.toolCalls, 1);
  assert.equal(result.writeCalls, 1);
});

test("a text-only business turn is retried with required tool selection before success", async () => {
  let requests = 0;
  let writes = 0;
  const choices: unknown[] = [];
  const messages = [
    response("已安排新项目。"),
    response("", [
      { type: "toolCall", id: "create", name: "create", arguments: { title: "新项目" } },
    ]),
    response("已根据工具结果登记。"),
  ];
  const engine = new PiEngine(config, {
    streamFn: (model, context, options) => {
      choices.push(options?.toolChoice);
      requests++;
      return scripted(messages)(model, context, options);
    },
  });
  const result = await engine.run(
    input([
      {
        name: "create",
        description: "create",
        parameters: schema,
        readOnly: false,
        execute: async () => {
          writes++;
          return { accepted: true };
        },
      },
    ]),
  );
  assert.equal(requests, 3);
  assert.equal(choices[0], undefined);
  assert.equal(choices[1], "required");
  assert.equal(choices[2], undefined);
  assert.equal(result.text, "已根据工具结果登记。");
  assert.equal(result.toolCalls, 1);
  assert.equal(result.writeCalls, 1);
  assert.equal(writes, 1);
});

test("a future action promise is retried with required tool selection", async () => {
  let requests = 0;
  const messages = [
    response("我会创建一个新项目并拉群。"),
    response("", [
      { type: "toolCall", id: "create", name: "create", arguments: { title: "新项目" } },
    ]),
    response("已根据工具结果登记。"),
  ];
  const stream = scripted(messages);
  let writes = 0;
  const engine = new PiEngine(config, {
    streamFn: (model, context, options) => {
      requests++;
      return stream(model, context, options);
    },
  });
  const result = await engine.run(
    input([
      {
        name: "create",
        description: "create",
        parameters: schema,
        readOnly: false,
        execute: async () => {
          writes++;
          return { accepted: true };
        },
      },
    ]),
  );
  assert.equal(requests, 3);
  assert.equal(result.text, "已根据工具结果登记。");
  assert.equal(result.toolCalls, 1);
  assert.equal(writes, 1);
});

test("an empty claims recovery cannot reuse the original assistant claim after many tools", async () => {
  let reads = 0;
  const recoveryCalls = Array.from({ length: 13 }, (_, index) =>
    response("", [{ type: "toolCall", id: `read-${index}`, name: "status", arguments: {} }]),
  );
  const engine = new PiEngine(config, {
    streamFn: scripted([response("我会创建一个新项目。"), ...recoveryCalls, response("")]),
  });
  await assert.rejects(
    engine.run(
      input([
        {
          name: "status",
          description: "read status",
          parameters: { type: "object", properties: {} },
          readOnly: true,
          execute: async () => {
            reads++;
            return { status: "pending" };
          },
        },
      ]),
    ),
    (error: unknown) => error instanceof OperationError && error.code === "empty_response",
  );
  assert.equal(reads, 13);
});

for (const provider of ["openai-responses", "anthropic-messages"] as const) {
  test(`${provider} applies forced tool choice once and then returns to provider auto`, async () => {
    const choices: unknown[] = [];
    let writes = 0;
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { tool_choice?: unknown };
      choices.push(body.tool_choice);
      if (choices.length > 6) throw new Error("fixture request budget exceeded");
      const forced =
        provider === "openai-responses"
          ? body.tool_choice === "required"
          : JSON.stringify(body.tool_choice) === JSON.stringify({ type: "any" });
      if (forced) {
        return provider === "openai-responses" ? openAiResponse("tool") : anthropicResponse("tool");
      }
      if (choices.length === 1) {
        return provider === "openai-responses"
          ? openAiResponse("text", "我会创建一个新项目。")
          : anthropicResponse("text", "我会创建一个新项目。");
      }
      return provider === "openai-responses" ? openAiResponse("text") : anthropicResponse("text");
    };
    const engine = new PiEngine(
      { ...config, provider, baseUrl: "http://127.0.0.1:1/v1" },
      { fetch },
    );
    const result = await engine.run(
      input([
        {
          name: "create",
          description: "create",
          parameters: schema,
          readOnly: false,
          execute: async () => {
            writes++;
            return { accepted: true };
          },
        },
      ]),
    );
    assert.equal(choices.length, 3);
    assert.equal(choices[0], undefined);
    assert.deepEqual(choices[1], provider === "openai-responses" ? "required" : { type: "any" });
    assert.equal(choices[2], undefined);
    assert.equal(result.text, "已根据工具结果登记。");
    assert.equal(result.toolCalls, 1);
    assert.equal(result.writeCalls, 1);
    assert.equal(writes, 1);
  });
}

test("ordinary text-only conversation remains a model reply when tools are available", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([response("你好，我可以帮你梳理需求。")]),
  });
  const result = await engine.run(
    input(
      [
        {
          name: "create",
          description: "create",
          parameters: schema,
          readOnly: false,
          execute: async () => ({ accepted: true }),
        },
      ],
      "你好，今天怎么样？",
    ),
  );
  assert.equal(result.text, "你好，我可以帮你梳理需求。");
  assert.equal(result.toolCalls, 0);
  assert.equal(result.writeCalls, 0);
});

test("a text-only turn that remains tool-free fails without a successful response", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([response("已安排新项目。"), response("仍然没有调用工具。")]),
  });
  await assert.rejects(
    engine.run(
      input([
        {
          name: "create",
          description: "create",
          parameters: schema,
          readOnly: false,
          execute: async () => ({ accepted: true }),
        },
      ]),
    ),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === "model_failed" &&
      error.outcome === "not_executed",
  );
});

test("an explicit request cannot succeed with a tool-free acknowledgement", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([response("收到，我马上处理。"), response("好的，我会处理。")]),
  });
  await assert.rejects(
    engine.run(
      input(
        [
          {
            name: "create",
            description: "create",
            parameters: schema,
            readOnly: false,
            execute: async () => ({ accepted: true }),
          },
        ],
        "请创建一个新项目并拉群",
      ),
    ),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === "model_failed" &&
      error.outcome === "not_executed",
  );
});

test("English business claims fail without any tool context", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([response("Created project demo and started Codex")]),
  });
  await assert.rejects(
    engine.run(input()),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === "model_failed" &&
      error.outcome === "not_executed",
  );
});

test("a read-only lookup cannot authorize an action completion claim", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "read-1", name: "status", arguments: {} }]),
      response("The task was created and the group was closed"),
      response("The task was created and the group was closed"),
    ]),
  });
  await assert.rejects(
    engine.run(
      input([
        {
          name: "status",
          description: "read status",
          parameters: { type: "object", properties: {} },
          readOnly: true,
          execute: async () => ({ status: "completed", taskId: "t1" }),
        },
      ]),
    ),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === "model_failed" &&
      error.outcome === "not_executed",
  );
});

test("a read-only lookup cannot authorize a future action promise", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "read-1", name: "status", arguments: {} }]),
      response("I will create a project and group"),
      response("I will create a project and group"),
    ]),
  });
  await assert.rejects(
    engine.run(
      input([
        {
          name: "status",
          description: "read status",
          parameters: { type: "object", properties: {} },
          readOnly: true,
          execute: async () => ({ status: "completed", taskId: "t1" }),
        },
      ]),
    ),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === "model_failed" &&
      error.outcome === "not_executed",
  );
});

test("unknown tool result cannot support a successful completion claim", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "write-1", name: "write", arguments: {} }]),
      response("Created task t1"),
      response("Created task t1"),
    ]),
  });
  await assert.rejects(
    engine.run(
      input([
        {
          name: "write",
          description: "write",
          parameters: { type: "object", properties: {} },
          readOnly: false,
          execute: async () => {
            throw new OperationError("timeout", "unknown", "unknown");
          },
        },
      ]),
    ),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === "model_failed" &&
      error.outcome === "unknown",
  );
});

test("not-executed tool result cannot support a successful completion claim", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "write-1", name: "write", arguments: {} }]),
      response("Created task t1"),
      response("Created task t1"),
    ]),
  });
  await assert.rejects(
    engine.run(
      input([
        {
          name: "write",
          description: "write",
          parameters: { type: "object", properties: {} },
          readOnly: false,
          execute: async () => ({ outcome: "not_executed" }),
        },
      ]),
    ),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === "model_failed" &&
      error.outcome === "not_executed",
  );
});

test("unknown write outcome blocks later writes but permits reads", async () => {
  let writes = 0;
  let reads = 0;
  const tool: RuntimeTool = {
    name: "write",
    description: "write",
    parameters: schema,
    readOnly: false,
    execute: async () => {
      writes++;
      throw new OperationError("unknown", "unconfirmed", "unknown");
    },
  };
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response(
        "",
        [1, 2].map((n) => ({
          type: "toolCall",
          id: `${n}`,
          name: "write",
          arguments: { title: `${n}` },
        })),
      ),
      response("", [{ type: "toolCall", id: "3", name: "read", arguments: { title: "read" } }]),
      response("结果未确认"),
    ]),
  });
  await engine.run(
    input([
      tool,
      {
        ...tool,
        name: "read",
        readOnly: true,
        execute: async () => {
          reads++;
          return {};
        },
      },
    ]),
  );
  assert.equal(writes, 1);
  assert.equal(reads, 1);
});

test("known nonexecution permits corrected call, actual model failure is never treated as success", async () => {
  let calls = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "1", name: "write", arguments: { title: "a" } }]),
      response("", [{ type: "toolCall", id: "2", name: "write", arguments: { title: "b" } }]),
      response("完成"),
    ]),
  });
  await engine.run(
    input([
      {
        name: "write",
        description: "write",
        parameters: schema,
        readOnly: false,
        execute: async () => {
          if (++calls === 1) throw new OperationError("invalid", "not executed");
          return {};
        },
      },
    ]),
  );
  assert.equal(calls, 2);
  const error = {
    ...response(""),
    stopReason: "error" as const,
    errorMessage: "secret test-secret",
  };
  const failing = new PiEngine(config, { streamFn: scripted([error]) });
  await assert.rejects(
    failing.run(input()),
    (error: unknown) => error instanceof OperationError && !error.message.includes("test-secret"),
  );
});

test("both real providers use correct endpoint and prohibit redirects", async () => {
  for (const provider of ["openai-responses", "anthropic-messages"] as const) {
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const engine = new PiEngine(
      { ...config, provider },
      {
        fetch: async (url, init) => {
          calls.push({ url: String(url), redirect: init?.redirect });
          return new Response(
            JSON.stringify({ error: { message: "local fixture", type: "api_error" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        },
      },
    );
    await assert.rejects(engine.run(input()));
    assert.equal(calls.length, 1);
    assert.equal(
      new URL(calls[0]?.url ?? "").pathname,
      provider === "openai-responses" ? "/v1/responses" : "/v1/messages",
    );
    assert.equal(calls[0]?.redirect, "error");
  }
});

test("tool calls continue past twelve and invalid arguments cannot reach execute", async () => {
  let executed = 0;
  const tools: RuntimeTool[] = [
    {
      name: "write",
      description: "write",
      parameters: schema,
      readOnly: false,
      execute: async () => {
        executed++;
        return {};
      },
    },
  ];
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response(
        "",
        Array.from({ length: 14 }, (_, i) => ({
          type: "toolCall",
          id: `${i}`,
          name: "write",
          arguments: { title: "x" },
        })),
      ),
      response("请求已记录。"),
    ]),
  });
  const result = await engine.run(input(tools));
  assert.equal(result.text, "请求已记录。");
  assert.equal(result.toolCalls, 14);
  assert.equal(result.writeCalls, 14);
  assert.equal(executed, 14);
  const invalid = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "bad", name: "write", arguments: {} }]),
      response("参数无效"),
    ]),
  });
  await invalid.run(input(tools));
  assert.equal(executed, 14);
});
