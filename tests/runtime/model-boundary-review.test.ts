import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { boundModelValue, MODEL_RESULT_MAX_BYTES } from "../../src/runtime/model-context.js";
import { config, response, scripted } from "./helpers.js";

const actor = { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "message" };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const input = {
  actor,
  sessionId: "session",
  systemPrompt: "Review only the supplied canonical evidence.",
  messages: [] as AgentMessage[],
  prompt: "Inspect the evidence without additional actions.",
  enforceClaims: false,
};

test("unserializable result markers respect the caller's whole-value budget or fail typed", () => {
  const cyclic: Record<string, unknown> = { outcome: "unknown" };
  cyclic.self = cyclic;
  for (const budget of [0, 16, 64, 128]) {
    let projected: unknown;
    try {
      projected = boundModelValue(cyclic, budget);
    } catch (error) {
      assert.equal((error as { code?: string }).code, "context_budget");
      continue;
    }
    assert.ok(bytes(projected) <= budget, `unserializable marker exceeds ${budget} bytes`);
  }
});

test("escaped error text is bounded inside the entire model tool-result message", async () => {
  const observed: number[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response("", [{ type: "toolCall", id: "call", name: "read_evidence", arguments: {} }]),
        response("The result is unknown; no operation was repeated."),
      ],
      (context) => {
        for (const message of context.messages)
          if (message.role === "toolResult") observed.push(bytes(message));
      },
    ),
  });
  const result = await engine.run({
    ...input,
    tools: [
      {
        name: "read_evidence",
        description: "Read evidence",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => {
          throw new OperationError("transport", "\\".repeat(60_000), "unknown");
        },
      },
    ],
  });
  assert.ok(observed.length > 0);
  for (const size of observed)
    assert.ok(size <= MODEL_RESULT_MAX_BYTES, `provider received a ${size}-byte tool result`);
  for (const message of result.messages)
    if (message.role === "toolResult") assert.ok(bytes(message) <= MODEL_RESULT_MAX_BYTES);
});

test("irreducible tool identity metadata cannot bypass the result envelope budget", async () => {
  const id = `call-${"🔒".repeat(5000)}`;
  const observed: number[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response("", [{ type: "toolCall", id, name: "read_evidence", arguments: {} }]),
        response("Inspected the supplied evidence."),
      ],
      (context) => {
        for (const message of context.messages)
          if (message.role === "toolResult") observed.push(bytes(message));
      },
    ),
  });
  try {
    await engine.run({
      ...input,
      tools: [
        {
          name: "read_evidence",
          description: "Read evidence",
          parameters: { type: "object", properties: {} },
          readOnly: true,
          execute: async () => ({ observed: true }),
        },
      ],
    });
  } catch (error) {
    assert.equal((error as { code?: string }).code, "context_budget");
  }
  for (const size of observed)
    assert.ok(
      size <= MODEL_RESULT_MAX_BYTES,
      "oversized identity must be refused, not truncated or sent",
    );
});

for (const oversized of ["escaped-body", "identity"] as const)
  test(`recovered ${oversized} results cannot bypass the whole provider-message budget`, async () => {
    const id = oversized === "identity" ? `recovered-${"🔒".repeat(5000)}` : "recovered-call";
    const canonical =
      oversized === "escaped-body" ? { body: "\\".repeat(6000) } : { observed: true };
    const observed: number[] = [];
    const engine = new PiEngine(config, {
      streamFn: scripted([response("The recovered evidence is retained.")], (context) => {
        for (const message of context.messages)
          if (message.role === "toolResult") observed.push(bytes(message));
      }),
    });
    const history: AgentMessage[] = [
      { role: "user", content: "Inspect evidence.", timestamp: 1 },
      response("", [{ type: "toolCall", id, name: "read_evidence", arguments: {} }]),
      {
        role: "toolResult",
        toolCallId: id,
        toolName: "read_evidence",
        content: [{ type: "text", text: JSON.stringify(canonical) }],
        isError: false,
        timestamp: 2,
      },
    ];
    let completed: AgentMessage[] | undefined;
    try {
      completed = (await engine.run({ ...input, messages: history, tools: [] })).messages;
    } catch (error) {
      assert.equal((error as { code?: string }).code, "context_budget");
    }
    for (const size of observed)
      assert.ok(size <= MODEL_RESULT_MAX_BYTES, `recovered provider message carried ${size} bytes`);
    if (completed) {
      assert.ok(observed.length > 0, "the recovered tool batch must remain a valid transcript");
      for (const message of completed)
        if (message.role === "toolResult") assert.ok(bytes(message) <= MODEL_RESULT_MAX_BYTES);
    }
  });

test("a compacted request is durably checkpointed before its next provider call", async () => {
  let durable: AgentMessage[] = [];
  const snapshots: Array<{ request: string; durable: string }> = [];
  const engine = new PiEngine(
    { ...config, contextTokens: 12_000 },
    {
      streamFn: scripted(
        Array.from({ length: 24 }, () => response("A compact historical summary.")),
        (context) => {
          if (context.systemPrompt === input.systemPrompt)
            snapshots.push({
              request: JSON.stringify(context.messages),
              durable: JSON.stringify(durable),
            });
        },
      ),
    },
  );
  const history: AgentMessage[] = [
    { role: "user", content: "A previous request.", timestamp: 1 },
    ...Array.from({ length: 8 }, () => response("historical observation ".repeat(300))),
  ];
  await engine.run({
    ...input,
    messages: history,
    tools: [],
    onCheckpoint: async (messages) => {
      await Promise.resolve();
      durable = structuredClone(messages);
    },
  });
  assert.equal(snapshots.length, 1);
  assert.match(snapshots[0]?.request ?? "", /历史工具执行摘要/);
  assert.ok(
    snapshots[0]?.durable.includes("历史工具执行摘要"),
    "the next request must not race ahead of persistence of the reduced transcript",
  );
});
