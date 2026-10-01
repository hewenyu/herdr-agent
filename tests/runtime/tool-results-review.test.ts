import assert from "node:assert/strict";
import test from "node:test";
import {
  createResultProjection,
  MODEL_TOOL_RESULT_BYTES,
  type StoredResultReference,
} from "../../src/runtime/tool-results.js";
import { Store } from "../../src/storage/store.js";

const actor = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  chatId: "chat",
  messageId: "message",
};

for (const text of ["\\".repeat(20000), '"'.repeat(20000), "\ud800".repeat(10000)]) {
  test(`result pages bound their full serialized envelope (${JSON.stringify(text.slice(0, 1))})`, async () => {
    const store = new Store(":memory:");
    try {
      const projection = createResultProjection(store, actor, "review");
      const original = { text };
      const reference = (await projection.projectToolResult({
        tool: "inspect",
        toolCallId: "call",
        args: {},
        result: original,
      })) as StoredResultReference;
      let reconstructed = "";
      for (let page = 0; page < reference.pageCount; page++) {
        const value = (await projection.tool.execute(
          { reference: reference.reference, page },
          actor,
        )) as { text: string };
        assert.ok(
          Buffer.byteLength(JSON.stringify(value)) <= MODEL_TOOL_RESULT_BYTES,
          "raw page bytes are insufficient: JSON quoting plus metadata count too",
        );
        reconstructed += value.text;
      }
      assert.deepEqual(
        JSON.parse(reconstructed),
        original,
        "bounded pages must not silently lose text",
      );
    } finally {
      store.close();
    }
  });
}

test("result references bound oversized metadata as well as the result body", async () => {
  const store = new Store(":memory:");
  try {
    const projection = createResultProjection(store, actor, "review");
    const reference = (await projection.projectToolResult({
      tool: "t".repeat(20000),
      toolCallId: "c".repeat(20000),
      args: {},
      result: { text: "x".repeat(20000) },
    })) as StoredResultReference;
    assert.ok(Buffer.byteLength(JSON.stringify(reference)) <= MODEL_TOOL_RESULT_BYTES);
    assert.equal(typeof reference.reference, "string", "the raw source must remain addressable");
    const page = await projection.tool.execute({ reference: reference.reference }, actor);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MODEL_TOOL_RESULT_BYTES);
  } finally {
    store.close();
  }
});

test("oversized not-executed error references preserve the canonical outcome", async () => {
  const store = new Store(":memory:");
  try {
    const projection = createResultProjection(store, actor, "review");
    const value = (await projection.projectToolResult({
      tool: "inspect",
      toolCallId: "call",
      args: {},
      isError: true,
      result: { outcome: "not_executed", code: "invalid_argument", error: "x".repeat(20000) },
    })) as StoredResultReference;
    assert.equal(value.isError, true);
    assert.equal(value.outcome, "not_executed", "projection must not rewrite operation semantics");
  } finally {
    store.close();
  }
});
