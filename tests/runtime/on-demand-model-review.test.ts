import assert from "node:assert/strict";
import test from "node:test";
import { PiEngine } from "../../src/runtime/engine.js";
import { MODEL_RESULT_MAX_BYTES } from "../../src/runtime/model-context.js";
import { pageChunks } from "../../src/runtime/result-projection-pages.js";
import { createResultProjection } from "../../src/runtime/tool-results.js";
import type { RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "./helpers.js";

const actor = {
  ownerId: "owner",
  chatId: "chat",
  sessionId: "session",
  taskId: "task",
  messageId: "message",
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
type Projection = ReturnType<typeof createResultProjection>;

test("page chunking drains a shrunken final page without dropping its remaining suffix", () => {
  const text = 'line "quote" 🦊\n'.repeat(100);
  const fits = (page: string) => bytes({ text: JSON.stringify(page) }) <= 128;
  const pages = pageChunks(text, fits, 200);
  assert.ok(pages);
  assert.ok(pages.every(fits));
  assert.equal(pages.join(""), text, "every code point must survive a probe-driven shrink");
  assert.equal(
    pageChunks(text, fits, 1),
    undefined,
    "page cap must fail rather than return a prefix",
  );
  assert.equal(
    pageChunks("x", () => false, 200),
    undefined,
    "no fitting character means refusal",
  );
});

for (const referenceKind of [
  "business-key",
  "another-result-reference",
  "page-shaped-with-extra-field",
  "page-shaped-with-modified-text",
] as const) {
  test(`a business result's ${referenceKind} field cannot bypass lossless projection`, async () => {
    const store = new Store(":memory:");
    try {
      const projection = createResultProjection(store, actor, "review");
      const other = (await projection.projectToolResult({
        tool: "read_other_evidence",
        toolCallId: "other",
        args: {},
        result: { body: "unrelated evidence".repeat(2000) },
      })) as { reference: string };
      assert.equal(typeof other.reference, "string");
      const pageShape = referenceKind.startsWith("page-shaped")
        ? ((await projection.tool.execute(
            { reference: other.reference, page: 0 },
            actor,
          )) as Record<string, unknown>)
        : {};
      const escaped = '\\"'.repeat(2200);
      const canonical = {
        ...pageShape,
        reference: referenceKind === "business-key" ? "document:design" : other.reference,
        ...(referenceKind === "page-shaped-with-modified-text"
          ? { text: escaped }
          : { body: escaped }),
      };
      const received = await receivedByModel(projection, {
        name: "read_evidence",
        description: "Read evidence with its own business reference field",
        readOnly: true,
        parameters: { type: "object", properties: {} },
        execute: async () => canonical,
      });
      assert.equal(typeof received.reference, "string");
      assert.notEqual(received.reference, canonical.reference);
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
      assert.equal(source, JSON.stringify(canonical));
    } finally {
      store.close();
    }
  });
}

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
    tools: [tool],
    projectToolResult: projection.projectToolResult,
    enforceClaims: false,
  });
  assert.ok(received, "the actual next provider request must carry this tool result");
  return received;
}

test("a value below the raw result cap is not lost when its model envelope requires projection", async () => {
  const store = new Store(":memory:");
  const canonical = { body: '\\"'.repeat(2200) };
  assert.ok(bytes(canonical) < MODEL_RESULT_MAX_BYTES);
  try {
    const projection = createResultProjection(store, actor, "review");
    const received = await receivedByModel(projection, {
      name: "read_evidence",
      description: "Read complete canonical evidence",
      readOnly: true,
      parameters: { type: "object", properties: {} },
      execute: async () => canonical,
    });
    if (received.body === canonical.body) return;
    assert.equal(
      typeof received.reference,
      "string",
      "a nested-envelope reduction must retain a usable durable reference, not only a lossy excerpt",
    );
    let source = "";
    const pages = Number(received.pageCount);
    assert.ok(Number.isSafeInteger(pages) && pages > 0);
    for (let page = 0; page < pages; page++) {
      const value = await receivedByModel(projection, projection.tool, {
        reference: received.reference,
        page,
      });
      assert.equal(
        typeof value.text,
        "string",
        "the model must actually receive every source page",
      );
      source += value.text;
    }
    assert.equal(source, JSON.stringify(canonical));
  } finally {
    store.close();
  }
});

test("tool_result_read pages remain lossless inside actual provider messages, not merely canonical tool returns", async () => {
  const store = new Store(":memory:");
  const canonical = { body: '\\"'.repeat(12000) };
  try {
    const projection = createResultProjection(store, actor, "review");
    const reference = (await projection.projectToolResult({
      tool: "read_evidence",
      toolCallId: "original",
      args: {},
      result: canonical,
    })) as { reference: string; pageCount: number };
    assert.equal(typeof reference.reference, "string");
    assert.ok(reference.pageCount > 1);
    let source = "";
    for (let page = 0; page < reference.pageCount; page++) {
      const args = { reference: reference.reference, page };
      const canonicalPage = (await projection.tool.execute(args, actor)) as { text: string };
      const received = await receivedByModel(projection, projection.tool, args);
      assert.equal(
        typeof received.text,
        "string",
        `page ${page} was replaced by a lossy envelope marker`,
      );
      assert.equal(
        received.text,
        canonicalPage.text,
        `page ${page} must survive projection verbatim`,
      );
      source += received.text;
    }
    assert.equal(source, JSON.stringify(canonical));
  } finally {
    store.close();
  }
});
