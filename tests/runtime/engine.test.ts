import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type { EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { config, response, scripted } from "./helpers.js";

const actor = { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "message" };
function input(tools: RuntimeTool[] = []): EngineInput {
  return {
    actor,
    sessionId: "session",
    prompt: "创建讨论任务",
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

test("ordinary text-only conversation remains a model reply when tools are available", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([response("你好，我可以帮你梳理需求。")]),
  });
  const result = await engine.run(
    input([
      {
        name: "create",
        description: "create",
        parameters: schema,
        readOnly: false,
        execute: async () => ({ accepted: true }),
      },
    ]),
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

test("tool calls stop at twelve and invalid arguments cannot reach execute", async () => {
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
    ]),
  });
  await assert.rejects(engine.run(input(tools)));
  assert.equal(executed, 12);
  const invalid = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "bad", name: "write", arguments: {} }]),
      response("参数无效"),
    ]),
  });
  await invalid.run(input(tools));
  assert.equal(executed, 12);
});
