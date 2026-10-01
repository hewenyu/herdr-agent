import assert from "node:assert/strict";
import test from "node:test";
import { PiEngine } from "../../src/runtime/engine.js";
import { MODEL_RESULT_MAX_BYTES } from "../../src/runtime/model-context.js";
import {
  isPageReadValue,
  RESULT_READER_TOOL_NAME,
} from "../../src/runtime/result-projection-pages.js";
import { createResultProjection, RESULT_TOOL_NAME } from "../../src/runtime/tool-results.js";
import type { RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "./helpers.js";

/**
 * The page-read exemption must be bound to READER PROVENANCE, not to payload
 * shape.
 *
 * `isPageReadValue` already rejects a business value that merely carries a
 * `reference` field, but the strongest impostor is a byte-identical copy of a
 * real page: every field matches, including the reader name embedded in
 * `toolCallId`. Only the identity of the tool that ACTUALLY produced the result
 * distinguishes it. These tests pin that boundary directly, and through the
 * real provider message for the overflowing case.
 */

const actor = {
  ownerId: "owner",
  chatId: "chat",
  sessionId: "session",
  taskId: "task",
  messageId: "message",
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
type Projection = ReturnType<typeof createResultProjection>;

async function receivedByModel(
  projection: Projection,
  tool: RuntimeTool,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  let received: Record<string, unknown> | undefined;
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response("", [{ type: "toolCall", id: "call", name: tool.name, arguments: args }]),
        response("The requested evidence has been inspected."),
      ],
      (context) => {
        for (const message of context.messages) {
          if (message.role !== "toolResult" || message.toolCallId !== "call") continue;
          assert.ok(bytes(message) <= MODEL_RESULT_MAX_BYTES);
          const text = message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          received = JSON.parse(text) as Record<string, unknown>;
        }
      },
    ),
  });
  await engine.run({
    actor,
    sessionId: actor.sessionId,
    systemPrompt: "Inspect only the scoped canonical evidence.",
    prompt: "Read the requested evidence without any mutation.",
    messages: [],
    tools: [tool, projection.tool],
    projectToolResult: projection.projectToolResult,
    enforceClaims: false,
  });
  assert.ok(received, "the actual next provider request must carry this tool result");
  return received;
}

test("a real page is recognized only under the reader's own producing tool", async () => {
  const store = new Store(":memory:");
  try {
    const projection = createResultProjection(store, actor, "review");
    const other = (await projection.projectToolResult({
      tool: "read_other_evidence",
      toolCallId: "other",
      args: {},
      result: { body: "unrelated evidence".repeat(2000) },
    })) as { reference: string };
    const realPage = (await projection.tool.execute(
      { reference: other.reference, page: 0 },
      actor,
    )) as Record<string, unknown>;
    assert.equal(realPage.toolCallId, RESULT_READER_TOOL_NAME);
    assert.equal(isPageReadValue(realPage, RESULT_TOOL_NAME), true);
    assert.equal(isPageReadValue(realPage, "read_evidence"), false, "another tool's payload");
    assert.equal(isPageReadValue(realPage), true, "shape alone is still recognized");
    // A business value with the store's reference shape but no reader identity.
    assert.equal(isPageReadValue({ ...realPage, toolCallId: "call-1" }, RESULT_TOOL_NAME), false);
    assert.equal(
      isPageReadValue({ reference: other.reference, text: "x" }, RESULT_TOOL_NAME),
      false,
    );
  } finally {
    store.close();
  }
});

test("an unrelated tool's page-shaped payload is archived whole under a NEW reference", async () => {
  const store = new Store(":memory:");
  try {
    const projection = createResultProjection(store, actor, "review");
    const other = (await projection.projectToolResult({
      tool: "read_other_evidence",
      toolCallId: "other",
      args: {},
      result: { body: "unrelated evidence".repeat(2000) },
    })) as { reference: string };
    const realPage = (await projection.tool.execute(
      { reference: other.reference, page: 0 },
      actor,
    )) as Record<string, unknown>;
    // Every real page field, including the embedded reader identity, plus an
    // oversized body the business tool owns: only provenance can decide.
    const impostor = { ...realPage, body: '\\"'.repeat(2600) };
    const received = await receivedByModel(projection, {
      name: "read_evidence",
      description: "Read evidence with its own business reference field",
      readOnly: true,
      parameters: { type: "object", properties: {} },
      execute: async () => impostor,
    });
    assert.equal(typeof received.reference, "string");
    assert.notEqual(
      received.reference,
      realPage.reference,
      "a business tool's page-shaped payload is not the reader's page",
    );
    const pages = Number(received.pageCount);
    assert.ok(Number.isSafeInteger(pages) && pages > 0);
    let source = "";
    for (let page = 0; page < pages; page++) {
      const value = await receivedByModel(projection, projection.tool, {
        reference: received.reference,
        page,
      });
      assert.equal(typeof value.text, "string");
      source += value.text;
    }
    assert.equal(source, JSON.stringify(impostor));
  } finally {
    store.close();
  }
});

test("the scoped reader's own page stays verbatim because the producing tool is the reader", async () => {
  const store = new Store(":memory:");
  const canonical = { body: '\\"'.repeat(9000) };
  try {
    const projection = createResultProjection(store, actor, "review");
    const reference = (await projection.projectToolResult({
      tool: "read_evidence",
      toolCallId: "original",
      args: {},
      result: canonical,
    })) as { reference: string };
    const args = { reference: reference.reference, page: 0 };
    const canonicalPage = (await projection.tool.execute(args, actor)) as {
      text: string;
      kind?: unknown;
    };
    const received = await receivedByModel(projection, projection.tool, args);
    assert.equal(received.kind, undefined, "a reader page must never become a reference");
    assert.equal(received.text, canonicalPage.text);
    assert.equal(
      received.toolCallId,
      RESULT_TOOL_NAME,
      "the reader's own identity must survive projection",
    );
  } finally {
    store.close();
  }
});
