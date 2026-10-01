import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { boundToolResultMessage, MODEL_RESULT_MAX_BYTES } from "../../src/runtime/model-context.js";
import { config, response, scripted } from "./helpers.js";

/**
 * A2 adversarial follow-up for the shared whole-envelope tool-result bound.
 *
 * The parent suite (tests/runtime/model-boundary-review.test.ts) pins the two
 * recovered-transcript regressions. These tests attack the same seam from the
 * other directions it can be bypassed: `details`/`usage` envelope fields the
 * provider never reads, double escaping of control-heavy content, multibyte
 * identity and content, mixed success/error batches in one recovered history,
 * named durable references, and checkpoint/request agreement.
 *
 * Real `PiEngine` runs with a scripted transport are used wherever the claim is
 * about what a provider would receive; `boundToolResultMessage` is exercised
 * directly for the irreducible-identity refusals a provider run cannot observe.
 */

const actor = { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "message" };
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");

const input = {
  actor,
  sessionId: "session",
  systemPrompt: "Review only the supplied canonical evidence.",
  messages: [] as AgentMessage[],
  prompt: "Inspect the evidence without additional actions.",
  enforceClaims: false,
};

function toolResult(
  overrides: Partial<Extract<AgentMessage, { role: "toolResult" }>> & { toolCallId: string },
): AgentMessage {
  return {
    role: "toolResult",
    toolName: "read_evidence",
    content: [{ type: "text", text: "{}" }],
    isError: false,
    timestamp: 2,
    ...overrides,
  } as AgentMessage;
}

function textOf(message: AgentMessage | undefined): string {
  if (!message || message.role !== "toolResult") return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Observes every tool-result message the scripted provider is asked to send. */
function observer(sizes: AgentMessage[]) {
  return (context: Parameters<ReturnType<typeof scripted>>[1]) => {
    for (const message of context.messages) if (message.role === "toolResult") sizes.push(message);
  };
}

// ---------------------------------------------------------------------------
// 1. Non-identity envelope fields: `details`/`usage` are part of the message
//    the provider receives, so they count against the budget — but they are
//    not identity, so an oversized blob there is reduced, not fatal.
// ---------------------------------------------------------------------------

test("an oversized recovered details blob cannot bypass the model envelope budget", async () => {
  const observed: AgentMessage[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted([response("The recovered evidence is retained.")], observer(observed)),
  });
  const history: AgentMessage[] = [
    { role: "user", content: "Inspect evidence.", timestamp: 1 },
    response("", [{ type: "toolCall", id: "details-call", name: "read_evidence", arguments: {} }]),
    toolResult({
      toolCallId: "details-call",
      content: [{ type: "text", text: JSON.stringify({ observed: true }) }],
      // A legacy checkpoint may stash the raw body in `details`, which the
      // provider serializes as part of the same message.
      details: { raw: "\\".repeat(20_000) },
    }),
  ];
  await engine.run({ ...input, messages: history, tools: [] });
  assert.ok(observed.length > 0);
  for (const message of observed)
    assert.ok(
      bytes(message) <= MODEL_RESULT_MAX_BYTES,
      `provider received a ${bytes(message)}-byte tool result with oversized details`,
    );
  const first = observed[0];
  assert.ok(first && first.role === "toolResult");
  assert.equal(first.toolCallId, "details-call", "identity is never rewritten");
  assert.equal(first.toolName, "read_evidence");
});

test("a giant toolResult usage block is bounded without touching identity", async () => {
  const observed: AgentMessage[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted([response("Retained.")], observer(observed)),
  });
  const history: AgentMessage[] = [
    { role: "user", content: "Inspect evidence.", timestamp: 1 },
    response("", [{ type: "toolCall", id: "usage-call", name: "read_evidence", arguments: {} }]),
    toolResult({
      toolCallId: "usage-call",
      content: [{ type: "text", text: JSON.stringify({ observed: true }) }],
      usage: { blob: "u".repeat(30_000) } as never,
    }),
  ];
  await engine.run({ ...input, messages: history, tools: [] });
  assert.ok(observed.length > 0);
  for (const message of observed) {
    assert.ok(bytes(message) <= MODEL_RESULT_MAX_BYTES, `usage-inflated message ${bytes(message)}`);
    assert.equal(message.role === "toolResult" ? message.toolCallId : "", "usage-call");
  }
});

test("several huge non-identity envelope fields are reduced monotonically", () => {
  // A message whose `details` AND `usage` are both far over budget must still
  // be reducible when its payload alone cannot shrink: the reduction drops the
  // least significant fields first and keeps identity untouched throughout.
  const message = toolResult({
    toolCallId: "multi-field",
    content: [{ type: "text", text: JSON.stringify({ observed: true }) }],
    details: { raw: "\u0000".repeat(20_000) },
    usage: { blob: "u".repeat(20_000) } as never,
    addedToolNames: Array.from({ length: 200 }, (_, index) => `tool-${index}-${"t".repeat(50)}`),
  });
  assert.ok(bytes(message) > MODEL_RESULT_MAX_BYTES, "fixture must exceed the budget");
  const bounded = boundToolResultMessage(message);
  assert.ok(bytes(bounded) <= MODEL_RESULT_MAX_BYTES, `bounded ${bytes(bounded)} bytes`);
  assert.equal(bounded.role === "toolResult" ? bounded.toolCallId : "", "multi-field");
  assert.equal(bounded.role === "toolResult" ? bounded.isError : true, false);
  // The payload still carries the canonical fact even after metadata was shed.
  const body = JSON.parse(textOf(bounded)) as Record<string, unknown>;
  assert.deepEqual(body, { observed: true });
});

// ---------------------------------------------------------------------------
// 2. Control-heavy content: the provider message re-escapes the text, so a
//    payload that fits on its own can still overflow the envelope.
// ---------------------------------------------------------------------------

test("control characters and NULs cannot inflate a recovered result past the envelope", async () => {
  // Each fixture fits the budget as its OWN JSON value (canonical bytes below
  // 16384) but overflows once the message re-escapes that JSON text into a
  // string field: the whole provider message is 2400 NULs -> 16979 bytes,
  // 8000 backslashes -> 32179, 2500 control chars -> 22679.
  for (const body of ["\u0000".repeat(2_400), "\\".repeat(8_000), "\t\n\r".repeat(2_500)]) {
    const observed: AgentMessage[] = [];
    const engine = new PiEngine(config, {
      streamFn: scripted([response("Retained.")], observer(observed)),
    });
    const canonical = JSON.stringify({ outcome: "unknown", body });
    assert.ok(
      Buffer.byteLength(canonical, "utf8") <= MODEL_RESULT_MAX_BYTES,
      `fixture must fit on its own: ${Buffer.byteLength(canonical, "utf8")} bytes`,
    );
    const history: AgentMessage[] = [
      { role: "user", content: "Inspect evidence.", timestamp: 1 },
      response("", [{ type: "toolCall", id: "ctl-call", name: "read_evidence", arguments: {} }]),
      toolResult({ toolCallId: "ctl-call", content: [{ type: "text", text: canonical }] }),
    ];
    assert.ok(
      bytes(history[2]) > MODEL_RESULT_MAX_BYTES,
      `the provider message must overflow: ${bytes(history[2])} bytes`,
    );
    await engine.run({ ...input, messages: history, tools: [] });
    assert.ok(observed.length > 0);
    for (const message of observed)
      assert.ok(
        bytes(message) <= MODEL_RESULT_MAX_BYTES,
        `control-heavy message carried ${bytes(message)} bytes`,
      );
    const body2 = JSON.parse(textOf(observed[0])) as Record<string, unknown>;
    assert.equal(body2.outcome, "unknown", "the typed outcome must survive the reduction");
    assert.equal(body2.truncated, true, "the omission must be explicit");
  }
});

// ---------------------------------------------------------------------------
// 3. Multibyte identity and content: byte budgets, not character counts.
// ---------------------------------------------------------------------------

test("multibyte content is bounded by UTF-8 bytes, never split mid-character", async () => {
  const observed: AgentMessage[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted([response("Retained.")], observer(observed)),
  });
  const history: AgentMessage[] = [
    { role: "user", content: "Inspect evidence.", timestamp: 1 },
    response("", [{ type: "toolCall", id: "multi", name: "read_evidence", arguments: {} }]),
    toolResult({
      toolCallId: "multi",
      content: [{ type: "text", text: JSON.stringify({ body: "审".repeat(9_000) }) }],
    }),
  ];
  await engine.run({ ...input, messages: history, tools: [] });
  for (const message of observed) {
    assert.ok(bytes(message) <= MODEL_RESULT_MAX_BYTES);
    // A byte-sliced prefix would leave a lone surrogate, which JSON.stringify
    // escapes as U+FFFD and grows. Re-encoding must be stable and exact.
    const text = textOf(message);
    assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
    if (text) assert.doesNotThrow(() => JSON.parse(text));
  }
});

test("a multibyte tool name is counted in bytes inside the envelope", () => {
  const name = "查".repeat(6_000);
  const message = toolResult({
    toolCallId: "call",
    toolName: name,
    content: [{ type: "text", text: JSON.stringify({ observed: true }) }],
  });
  assert.throws(
    () => boundToolResultMessage(message),
    (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "context_budget");
      return true;
    },
    "a 18KB multibyte name must be refused rather than truncated",
  );
  // The message is left untouched by the caller because the bound never
  // returns a rewritten identity: what was refused is never silently altered.
  assert.equal((message as { toolName: string }).toolName, name);
});

// ---------------------------------------------------------------------------
// 4. Irreducible identity: typed refusal, no truncation, no orphaned results.
// ---------------------------------------------------------------------------

test("irreducible identity refuses without truncating the call id", () => {
  // `c`.repeat(20_000) and `\`.repeat(9_000) are irreducible: the call id alone
  // is over budget (20151 and 18151 bytes) and it is identity, so no marker may
  // replace it and no prefix may be spliced into it.
  for (const id of ["🔒".repeat(5_000), "c".repeat(20_000), "\\".repeat(9_000)]) {
    const message = toolResult({
      toolCallId: id,
      content: [{ type: "text", text: JSON.stringify({ observed: true }) }],
    });
    assert.ok(bytes(message) > MODEL_RESULT_MAX_BYTES, "fixture must exceed the budget");
    assert.throws(
      () => boundToolResultMessage(message),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, "context_budget");
        assert.equal(error.outcome, "not_executed");
        return true;
      },
      `an irreducible ${id.length}-character identity must be refused`,
    );
    assert.equal((message as { toolCallId: string }).toolCallId, id, "never mutated in place");
  }
  // An id that fits once the payload is reduced is NOT refused: refusal is the
  // last resort, not the first response to an oversized message.
  const fits = boundToolResultMessage(
    toolResult({
      toolCallId: "c".repeat(4_000),
      content: [{ type: "text", text: JSON.stringify({ body: "\\".repeat(9_000) }) }],
    }),
  );
  assert.ok(bytes(fits) <= MODEL_RESULT_MAX_BYTES);
  assert.equal(fits.role === "toolResult" ? fits.toolCallId : "", "c".repeat(4_000));
});

test("an unsendable recovered identity is refused before the provider, never spliced", async () => {
  const observed: AgentMessage[] = [];
  const id = `recovered-${"🔒".repeat(5_000)}`;
  const engine = new PiEngine(config, {
    streamFn: scripted([response("Retained.")], observer(observed)),
  });
  const history: AgentMessage[] = [
    { role: "user", content: "Inspect evidence.", timestamp: 1 },
    response("", [{ type: "toolCall", id, name: "read_evidence", arguments: {} }]),
    toolResult({
      toolCallId: id,
      content: [{ type: "text", text: JSON.stringify({ observed: true }) }],
    }),
  ];
  await assert.rejects(engine.run({ ...input, messages: history, tools: [] }), (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, "context_budget", "not a generic retryable model_failed");
    assert.equal(error.outcome, "not_executed", "a failed read is not an unknown effect");
    return true;
  });
  for (const message of observed)
    assert.ok(bytes(message) <= MODEL_RESULT_MAX_BYTES, "nothing oversized may be sent");
});

test("a write already committed keeps its unknown-effect report when identity is unsendable", async () => {
  const store = new PiEngine(config, {
    streamFn: scripted([
      response("", [
        { type: "toolCall", id: `call-${"🔒".repeat(5_000)}`, name: "commit", arguments: {} },
      ]),
    ]),
  });
  let writes = 0;
  await assert.rejects(
    store.run({
      ...input,
      tools: [
        {
          name: "commit",
          description: "commit",
          parameters: { type: "object", properties: {} },
          readOnly: false,
          execute: async () => {
            writes++;
            return { outcome: "successful", id: "t1" };
          },
        },
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "context_budget");
      assert.equal(
        error.outcome,
        "unknown",
        "a committed write must never be reported as not executed",
      );
      return true;
    },
  );
  assert.equal(writes, 1, "the committed write is never replayed to make context fit");
});

// ---------------------------------------------------------------------------
// 5. Batches: a mixed recovered history keeps one result per call, in order.
// ---------------------------------------------------------------------------

test("a mixed recovered batch keeps exactly one bounded result per call", async () => {
  const observed: AgentMessage[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted([response("Retained.")], observer(observed)),
  });
  const history: AgentMessage[] = [
    { role: "user", content: "Inspect evidence.", timestamp: 1 },
    response("", [
      { type: "toolCall", id: "ok-call", name: "read_evidence", arguments: {} },
      { type: "toolCall", id: "err-call", name: "read_evidence", arguments: {} },
    ]),
    toolResult({
      toolCallId: "ok-call",
      content: [{ type: "text", text: JSON.stringify({ body: "\\".repeat(6_000) }) }],
    }),
    toolResult({
      toolCallId: "err-call",
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ outcome: "unknown", error: "\u0000".repeat(9_000) }),
        },
      ],
    }),
  ];
  await engine.run({ ...input, messages: history, tools: [] });
  const ids = observed.map((message) => (message.role === "toolResult" ? message.toolCallId : ""));
  assert.deepEqual(ids, ["ok-call", "err-call"], "batch order and identity are preserved");
  for (const message of observed) {
    assert.ok(bytes(message) <= MODEL_RESULT_MAX_BYTES);
    if (message.role !== "toolResult") continue;
    if (message.toolCallId === "err-call") assert.equal(message.isError, true);
  }
  const errorBody = JSON.parse(textOf(observed[1])) as Record<string, unknown>;
  assert.equal(errorBody.outcome, "unknown", "an error result is never promoted to success");
});

// ---------------------------------------------------------------------------
// 6. Durable reference: a named reference from the projection survives the
//    envelope reduction, so the model keeps a usable source to page from.
// ---------------------------------------------------------------------------

test("a durable reference survives the whole-envelope reduction intact", async () => {
  const observed: AgentMessage[] = [];
  const reference = { reference: `rt1_${"a".repeat(40)}`, pages: 12, omitted: "正文已省略" };
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response("", [{ type: "toolCall", id: "call", name: "bulk_read", arguments: {} }]),
        response("已根据工具结果核对。"),
      ],
      observer(observed),
    ),
  });
  await engine.run({
    ...input,
    tools: [
      {
        name: "bulk_read",
        description: "read",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => ({ outcome: "successful", entries: "x".repeat(400_000) }),
      },
    ],
    projectToolResult: () => reference,
  });
  assert.ok(observed.length > 0);
  const text = textOf(observed[0]);
  assert.match(text, /rt1_/, "the durable source reference must remain usable");
  assert.doesNotMatch(text, /x{1000}/u, "the raw body is never smuggled back in");
});

// ---------------------------------------------------------------------------
// 7. Checkpoint agreement: the durable checkpoint must equal the model view
//    that produced it, including the reduction shape.
// ---------------------------------------------------------------------------

test("the durable checkpoint matches the bounded request shape it was built from", async () => {
  let checkpoint: AgentMessage[] = [];
  let request: AgentMessage[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted([response("The recovered evidence is retained.")], (context) => {
      request = context.messages.map((message) => structuredClone(message));
    }),
  });
  const history: AgentMessage[] = [
    { role: "user", content: "Inspect evidence.", timestamp: 1 },
    response("", [{ type: "toolCall", id: "cp-call", name: "read_evidence", arguments: {} }]),
    toolResult({
      toolCallId: "cp-call",
      content: [{ type: "text", text: JSON.stringify({ body: "\\".repeat(6_000) }) }],
      details: { raw: "\u0000".repeat(4_000) },
    }),
  ];
  await engine.run({
    ...input,
    messages: history,
    tools: [],
    onCheckpoint: (messages) => {
      checkpoint = structuredClone(messages);
    },
  });
  assert.ok(request.length > 0, "a provider request was made");
  const requested = request.find((message) => message.role === "toolResult");
  const stored = checkpoint.find((message) => message.role === "toolResult");
  assert.ok(requested && stored, "both the request and the checkpoint carry the result");
  assert.equal(
    JSON.stringify(stored),
    JSON.stringify(requested),
    "the durable checkpoint must be exactly the bounded model view, not the raw original",
  );
  assert.ok(bytes(stored) <= MODEL_RESULT_MAX_BYTES);
  assert.equal(
    stored.role === "toolResult" ? stored.toolCallId : "",
    "cp-call",
    "identity survives persistence unchanged",
  );
});

test("EngineResult.messages is the same bounded model view as the request", async () => {
  const observed: AgentMessage[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted([response("Retained.")], observer(observed)),
  });
  const history: AgentMessage[] = [
    { role: "user", content: "Inspect evidence.", timestamp: 1 },
    response("", [{ type: "toolCall", id: "res-call", name: "read_evidence", arguments: {} }]),
    toolResult({
      toolCallId: "res-call",
      content: [{ type: "text", text: JSON.stringify({ body: "\\".repeat(6_000) }) }],
    }),
  ];
  const result = await engine.run({ ...input, messages: history, tools: [] });
  const returned = result.messages.find((message) => message.role === "toolResult");
  assert.ok(returned, "the caller sees the tool result");
  assert.ok(bytes(returned) <= MODEL_RESULT_MAX_BYTES, "returned result is bounded");
  assert.equal(
    JSON.stringify(returned),
    JSON.stringify(observed[0]),
    "callers must never see a result the provider did not",
  );
  assert.equal(
    returned.role === "toolResult" ? returned.toolCallId : "",
    "res-call",
    "identity is preserved for the caller too",
  );
});
