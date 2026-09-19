import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type { EngineInput } from "../../src/runtime/types.js";
import { config, response, scripted } from "./helpers.js";

function input(execute: () => Promise<unknown>, requireToolCall = true): EngineInput {
  return {
    actor: { ownerId: "owner", chatId: "task-group", sessionId: "trust", messageId: "startup" },
    sessionId: "trust",
    systemPrompt:
      "Only confirm an authorized native startup directory menu through the guarded tool.",
    prompt: JSON.stringify({ event: "participant_startup_blocked" }),
    messages: [],
    requireToolCall,
    tools: [
      {
        name: "directory_trust_confirm",
        description: "Guarded native startup confirmation",
        parameters: { type: "object", properties: {} },
        readOnly: false,
        execute,
      },
    ],
  };
}

const call = (id: string) =>
  response("", [{ type: "toolCall", id, name: "directory_trust_confirm", arguments: {} }]);

for (const provider of ["openai-responses", "anthropic-messages"] as const) {
  test(`authorized internal operation requires one initial tool call and then ordinary reply: ${provider}`, async () => {
    const choices: unknown[] = [];
    const stream = scripted([call("trust"), response("目录已确认。")]);
    let writes = 0;
    const engine = new PiEngine(
      { ...config, provider },
      {
        streamFn: (model, context, options) => {
          choices.push(options?.toolChoice);
          return stream(model, context, options);
        },
      },
    );
    const result = await engine.run(
      input(async () => {
        writes++;
        return { confirmed: true };
      }),
    );
    assert.equal(writes, 1);
    assert.equal(result.toolCalls, 1);
    assert.deepEqual(choices, [provider === "anthropic-messages" ? "any" : "required", undefined]);
  });
}

test("unknown or ordinary menu observations do not force a tool call", async () => {
  const choices: unknown[] = [];
  const stream = scripted([response("请由用户选择。")]);
  const engine = new PiEngine(config, {
    streamFn: (model, context, options) => {
      choices.push(options?.toolChoice);
      return stream(model, context, options);
    },
  });
  const result = await engine.run(input(async () => assert.fail("must not execute"), false));
  assert.equal(result.toolCalls, 0);
  assert.deepEqual(choices, [undefined]);
});

test("provider ignoring required tool selection gets one recovery and cannot finish without a call", async () => {
  const choices: unknown[] = [];
  const stream = scripted([response("留给用户。"), response("收到。")]);
  const engine = new PiEngine(config, {
    streamFn: (model, context, options) => {
      choices.push(options?.toolChoice);
      return stream(model, context, options);
    },
  });
  await assert.rejects(
    engine.run({ ...input(async () => assert.fail("not called")), enforceClaims: false }),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === "model_failed" &&
      error.outcome === "not_executed",
  );
  assert.deepEqual(choices, ["required", "required"]);
});

test("required startup operation cannot repeat a write whose first result is unknown", async () => {
  let writes = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted([call("first"), call("second"), response("结果未知，需要核对现场。")]),
  });
  const result = await engine.run(
    input(async () => {
      writes++;
      throw new OperationError("input_unconfirmed", "原生按键结果未知", "unknown");
    }),
  );
  assert.equal(writes, 1);
  assert.equal(result.writeCalls, 1);
  assert.equal(result.toolEvidence?.unknown, 1);
});
