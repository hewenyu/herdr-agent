import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { PiEngine } from "../../src/runtime/engine.js";
import type { EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { config, response, scripted } from "./helpers.js";

function input(tools: RuntimeTool[] = []): EngineInput {
  return {
    actor: { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "request" },
    sessionId: "session",
    prompt: "process work",
    systemPrompt: "Use the available tools and report their results.",
    messages: [],
    tools,
    enforceClaims: false,
  };
}

function tool(execute: RuntimeTool["execute"]): RuntimeTool {
  return {
    name: "work",
    description: "Process a work item",
    parameters: { type: "object", properties: {} },
    readOnly: false,
    execute,
  };
}

const call = (id: string) => response("", [{ type: "toolCall", id, name: "work", arguments: {} }]);

test("healthy provider and tool steps can exceed the operation deadline in total", async () => {
  const timeoutMs = 100;
  const script = scripted([call("1"), call("2"), call("3"), response("processed")]);
  let executed = 0;
  const engine = new PiEngine(
    { ...config, timeoutMs },
    {
      streamFn: async (...args) => {
        await delay(60);
        return script(...args);
      },
    },
  );
  const started = Date.now();
  const result = await engine.run(
    input([
      tool(async () => {
        await delay(60);
        executed++;
        return { accepted: true };
      }),
    ]),
  );
  assert.equal(result.text, "processed");
  assert.equal(executed, 3);
  assert.ok(Date.now() - started > timeoutMs, "the deadline applies to each step, not the run");
});

test("provider stream creation that ignores cancellation releases the lane", {
  timeout: 1000,
}, async () => {
  const engine = new PiEngine(
    { ...config, timeoutMs: 20 },
    { streamFn: () => new Promise<AssistantMessageEventStream>(() => {}) },
  );
  await assert.rejects(engine.run(input()), { code: "model_failed" });
});

test("a stalled tool releases the lane and cannot start the next call after cancellation", {
  timeout: 1000,
}, async () => {
  let finish!: () => void;
  let calls = 0;
  let toolSignal: AbortSignal | undefined;
  let providerCalls = 0;
  const script = scripted([
    response("", [
      { type: "toolCall", id: "first", name: "work", arguments: {} },
      { type: "toolCall", id: "later", name: "work", arguments: {} },
    ]),
    response("should not resume"),
  ]);
  const engine = new PiEngine(
    { ...config, timeoutMs: 20 },
    {
      streamFn: (...args) => {
        providerCalls++;
        return script(...args);
      },
    },
  );
  await assert.rejects(
    engine.run(
      input([
        tool(async (_args, _actor, signal) => {
          calls++;
          toolSignal = signal;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { accepted: true };
        }),
      ]),
    ),
    { code: "model_failed" },
  );
  assert.equal(toolSignal?.aborted, true);
  assert.equal(calls, 1);
  finish();
  await delay(0);
  assert.equal(calls, 1);
  assert.equal(providerCalls, 1);
});
