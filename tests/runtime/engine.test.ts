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
