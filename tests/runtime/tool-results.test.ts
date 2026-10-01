import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import {
  archiveSerializedResult,
  createResultProjection,
  listStoredResults,
  MODEL_TOOL_RESULT_BYTES,
  RESULT_MAX_PAGES,
  readCanonicalResult,
  resultScope,
  type StoredResultReference,
  serializeToolResult,
} from "../../src/runtime/tool-results.js";
import { Store } from "../../src/storage/store.js";

const owner: ActorContext = {
  ownerId: "owner",
  chatId: "chat",
  sessionId: "session-1",
  taskId: "task-1",
  messageId: "message-1",
};

const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
const giant = (size = 400_000) => ({
  outcome: "successful",
  taskId: "task-1",
  entries: "审".repeat(size),
});

function storage(): Store {
  return new Store(":memory:");
}

test("small results stay intact and never allocate durable storage", () => {
  const store = storage();
  try {
    const factory = createResultProjection(store, owner, "turn:t:g0");
    const small = { accepted: true, taskId: "task-1" };
    assert.deepEqual(
      factory.projectToolResult({ tool: "task_get", args: {}, toolCallId: "call", result: small }),
      small,
    );
    assert.equal(store.entries("tool_results").length, 0);
    assert.equal(store.entries("tool_result_pages").length, 0);
  } finally {
    store.close();
  }
});

test("an oversized result is replaced by a bounded, deterministic reference", () => {
  const store = storage();
  try {
    const factory = createResultProjection(store, owner, "turn:t:g0");
    const input = {
      tool: "task_get",
      args: { taskId: "task-1" },
      toolCallId: "call-1",
      result: giant(),
    };
    const first = factory.projectToolResult(input) as StoredResultReference;
    assert.ok(bytes(first) <= MODEL_TOOL_RESULT_BYTES, `reference is ${bytes(first)} bytes`);
    assert.equal(first.kind, "myrix.tool_result.reference");
    assert.equal(first.persisted, true);
    assert.equal(first.outcome, "successful");
    assert.equal(first.isError, false);
    assert.match(first.reference, /^rt1_[0-9a-f]{32}$/);
    assert.equal(first.bytes, bytes(giant()));
    assert.ok((first.pageCount ?? 0) > 1);
    // Facts survive so claims stay evaluable, but raw content never does.
    assert.equal(first.facts?.taskId, "task-1");
    assert.ok(!JSON.stringify(first).includes("审审"));
    // Identical content in the same scope deduplicates to the same receipt.
    const second = factory.projectToolResult({ ...input, toolCallId: "call-2" }) as
      | StoredResultReference
      | undefined;
    assert.equal(second?.reference, first.reference);
    assert.equal(store.entries("tool_results").length, 1);
  } finally {
    store.close();
  }
});

test("every page stays inside the model budget and rejoins to the exact bytes", async () => {
  const store = storage();
  try {
    const factory = createResultProjection(store, owner, "turn:t:g0");
    const value = {
      outcome: "successful",
      nested: ['审"quote\\slash\n换行', "𝄞".repeat(20_000)],
      tail: "终",
    };
    const canonical = serializeToolResult(value);
    assert.ok(canonical);
    const reference = factory.projectToolResult({
      tool: "task_get",
      args: {},
      toolCallId: "call",
      result: value,
    }) as StoredResultReference;
    const pages: string[] = [];
    for (let page = 0; ; page++) {
      const read = (await factory.tool.execute(
        { reference: reference.reference, page },
        owner,
      )) as { text?: string; complete?: boolean; page?: number; pageCount?: number };
      assert.equal(read.page, page);
      assert.ok(bytes(read) <= MODEL_TOOL_RESULT_BYTES, `page ${page} is ${bytes(read)} bytes`);
      pages.push(read.text ?? "");
      if (read.complete) {
        assert.equal(page, (read.pageCount ?? 0) - 1);
        break;
      }
      assert.ok(page < 1000, "pagination must terminate");
    }
    assert.ok(pages.length > 1);
    assert.equal(pages.join(""), canonical);
    assert.equal(readCanonicalResult(store, owner, "turn:t:g0", reference.reference), canonical);
    assert.deepEqual(
      listStoredResults(store, owner, "turn:t:g0")[0]?.reference,
      reference.reference,
    );
  } finally {
    store.close();
  }
});

test("references are owner, session and task scoped and foreign reads fail", async () => {
  const store = storage();
  try {
    const factory = createResultProjection(store, owner, "turn:t:g0");
    const reference = factory.projectToolResult({
      tool: "task_get",
      args: {},
      toolCallId: "call",
      result: giant(),
    }) as StoredResultReference;
    // The owner is bound at factory creation: a foreign actor cannot even
    // construct the same factory scope.
    const foreignFactory = createResultProjection(
      store,
      { ...owner, ownerId: "intruder" },
      "turn:t:g0",
    );
    await assert.rejects(
      foreignFactory.tool.execute(
        { reference: reference.reference, page: 0 },
        {
          ...owner,
          ownerId: "intruder",
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, "result_not_found");
        return true;
      },
    );
    for (const foreign of [
      { ...owner, sessionId: "session-2" },
      { ...owner, taskId: "task-2" },
      { ...owner, taskId: undefined },
      { ...owner, ownerId: "intruder" },
    ]) {
      await assert.rejects(
        factory.tool.execute({ reference: reference.reference, page: 0 }, foreign),
        (error: unknown) => {
          assert.ok(error instanceof OperationError);
          assert.ok(["invalid_scope", "result_not_found"].includes(error.code), error.code);
          return true;
        },
      );
    }
    // A scope from another activation or generation of the same identity is
    // reported as a stale scope, never as readable content.
    const otherScope = createResultProjection(store, owner, "turn:other:g0");
    await assert.rejects(
      otherScope.tool.execute({ reference: reference.reference, page: 0 }, owner),
      { code: "invalid_scope" },
    );
    // A different identity cannot even learn that the reference exists.
    const foreignIdentity = createResultProjection(
      store,
      { ...owner, ownerId: "other-owner" },
      "turn:t:g0",
    );
    await assert.rejects(
      foreignIdentity.tool.execute(
        { reference: reference.reference, page: 0 },
        {
          ...owner,
          ownerId: "other-owner",
        },
      ),
      { code: "result_not_found" },
    );
  } finally {
    store.close();
  }
});

test("invalid references and pages fail without leaking existence", async () => {
  const store = storage();
  try {
    const factory = createResultProjection(store, owner, "turn:t:g0");
    for (const reference of ["", "rt1_", "rt1_zzzz", "../../etc/passwd", `rt1_${"0".repeat(32)}`]) {
      await assert.rejects(
        factory.tool.execute({ reference, page: 0 }, owner),
        (error: unknown) => {
          assert.ok(error instanceof OperationError);
          assert.ok(["invalid_reference", "result_not_found"].includes(error.code), error.code);
          return true;
        },
      );
    }
    await assert.rejects(factory.tool.execute({ page: 0 }, owner), { code: "invalid_reference" });
    const reference = factory.projectToolResult({
      tool: "task_get",
      args: {},
      toolCallId: "call",
      result: giant(),
    }) as StoredResultReference;
    for (const page of [-1, 1.5, "many", 999_999]) {
      await assert.rejects(factory.tool.execute({ reference: reference.reference, page }, owner), {
        code: "invalid_page",
      });
    }
    // Page 0 is the default when omitted.
    const read = (await factory.tool.execute({ reference: reference.reference }, owner)) as {
      page: number;
      text: string;
    };
    assert.equal(read.page, 0);
    assert.ok(read.text.length > 0);
  } finally {
    store.close();
  }
});

test("read-only and missing pages never fabricate success", async () => {
  const store = storage();
  try {
    const factory = createResultProjection(store, owner, "turn:t:g0");
    assert.equal(factory.tool.readOnly, true);
    assert.equal(factory.tool.name, "tool_result_read");
    const reference = factory.projectToolResult({
      tool: "task_get",
      args: {},
      toolCallId: "call",
      result: giant(100_000),
    }) as StoredResultReference;
    // A deleted page is a typed state error, never an empty success.
    const pageKey = store.entries<string>("tool_result_pages")[0]?.[0];
    assert.ok(pageKey);
    store.delete("tool_result_pages", pageKey);
    await assert.rejects(
      factory.tool.execute({ reference: reference.reference, page: 0 }, owner),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, "state_invalid");
        assert.equal(error.outcome, "unknown");
        return true;
      },
    );
  } finally {
    store.close();
  }
});

test("error receipts keep typed outcome and never become silent success", () => {
  const store = storage();
  try {
    const factory = createResultProjection(store, owner, "turn:t:g0");
    const error = factory.projectToolResult({
      tool: "task_create",
      args: {},
      toolCallId: "call",
      result: { outcome: "unknown", code: "transport", error: { message: "网".repeat(90_000) } },
      isError: true,
    }) as StoredResultReference;
    assert.equal(error.outcome, "unknown");
    assert.equal(error.isError, true);
    assert.equal(error.facts?.code, "transport");
    assert.ok(bytes(error) <= MODEL_TOOL_RESULT_BYTES);
    // The 240-character fact cap keeps error prose bounded, and the raw message
    // is never nested into the reference payload.
    assert.ok((error.facts?.errorMessage as string).length <= 241);
    // A successful oversized write keeps its success outcome and facts.
    const success = factory.projectToolResult({
      tool: "task_create",
      args: {},
      toolCallId: "call-2",
      result: { accepted: true, taskId: "task-9", notes: "审".repeat(30_000) },
    }) as StoredResultReference;
    assert.equal(success.outcome, "successful");
    assert.equal(success.isError, false);
    assert.equal(success.facts?.taskId, "task-9");
    assert.equal(success.facts?.accepted, true);
  } finally {
    store.close();
  }
});

test("storage failures degrade to a bounded marker, not to a failed or replayed write", () => {
  const store = storage();
  try {
    const factory = createResultProjection(store, owner, "turn:t:g0");
    store.close();
    const projected = factory.projectToolResult({
      tool: "task_create",
      args: {},
      toolCallId: "call",
      result: { accepted: true, taskId: "task-3", notes: "审".repeat(40_000) },
    }) as Record<string, unknown>;
    assert.equal(projected.persisted, false);
    assert.equal(projected.outcome, "successful");
    assert.equal(projected.isError, false);
    assert.ok(bytes(projected) <= MODEL_TOOL_RESULT_BYTES);
    assert.match(String(projected.omitted), /持久存储/);
  } finally {
    // Closing twice would throw; the store is already closed.
  }
});

test("an unserializable value is omitted explicitly rather than reported as success", () => {
  const store = storage();
  try {
    const factory = createResultProjection(store, owner, "turn:t:g0");
    const cyclic: Record<string, unknown> = { outcome: "unknown" };
    cyclic.self = cyclic;
    const projected = factory.projectToolResult({
      tool: "task_get",
      args: {},
      toolCallId: "call",
      result: cyclic,
    }) as Record<string, unknown>;
    assert.equal(projected.error, "result_unserializable");
    assert.equal(projected.isError, false);
    assert.equal(projected.persisted, false);
  } finally {
    store.close();
  }
});

test("archiving a raw serialized page set is capped and byte-bounded", () => {
  const store = storage();
  try {
    const text = serializeToolResult({ entries: "a".repeat(RESULT_MAX_PAGES * 12 * 1024 + 1) });
    assert.ok(text);
    const reference = archiveSerializedResult(store, owner, "turn:t:g0", {
      tool: "bulk_read",
      toolCallId: "call",
      text,
    });
    // Above the page cap the store refuses instead of writing unbounded pages.
    assert.equal(reference, undefined);
    assert.equal(store.entries("tool_results").length, 0);
  } finally {
    store.close();
  }
});

test("the same canonical result in different scopes stays independently readable", () => {
  const store = storage();
  try {
    const value = giant(200_000);
    const first = createResultProjection(store, owner, "turn:a:g0").projectToolResult({
      tool: "task_get",
      args: {},
      toolCallId: "call",
      result: value,
    }) as StoredResultReference;
    const second = createResultProjection(store, owner, "turn:b:g0").projectToolResult({
      tool: "task_get",
      args: {},
      toolCallId: "call",
      result: value,
    }) as StoredResultReference;
    assert.notEqual(first.reference, second.reference);
    assert.equal(store.entries("tool_results").length, 2);
    // Same content in the same scope, different generation: also distinct.
    const third = createResultProjection(store, owner, "turn:a:g1").projectToolResult({
      tool: "task_get",
      args: {},
      toolCallId: "call",
      result: value,
    }) as StoredResultReference;
    assert.notEqual(third.reference, first.reference);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Additive B2 coverage: the deterministic identity must separate contradictory
// error semantics while still deduplicating one canonical result, and the
// bounded reference must never alias a foreign owner/session/task identity.
// ---------------------------------------------------------------------------

test("one canonical body projected as success and as error stays fully readable", () => {
  const store = storage();
  try {
    const factory = createResultProjection(store, owner, "turn:t:g0");
    const raw = { entries: "审".repeat(80_000) };
    const success = factory.projectToolResult({
      tool: "task_get",
      args: {},
      toolCallId: "call-1",
      result: raw,
    }) as StoredResultReference;
    const failure = factory.projectToolResult({
      tool: "task_get",
      args: {},
      toolCallId: "call-1",
      result: raw,
      isError: true,
    }) as StoredResultReference;
    assert.equal(success.outcome, "successful");
    assert.equal(success.isError, false);
    assert.equal(failure.outcome, "unknown");
    assert.equal(failure.isError, true);
    assert.notEqual(success.reference, failure.reference);
    // Both canonical originals remain durably and exactly readable.
    assert.equal(
      readCanonicalResult(store, owner, "turn:t:g0", success.reference),
      JSON.stringify(raw),
    );
    assert.equal(
      readCanonicalResult(store, owner, "turn:t:g0", failure.reference),
      JSON.stringify(raw),
    );
    // Retrying the same classification still deduplicates.
    const retry = factory.projectToolResult({
      tool: "task_get",
      args: {},
      toolCallId: "call-2",
      result: raw,
      isError: true,
    }) as StoredResultReference;
    assert.equal(retry.reference, failure.reference);
    assert.equal(store.entries("tool_results").length, 2);
  } finally {
    store.close();
  }
});

test("control-character scope separators cannot alias distinct identities", async () => {
  const store = storage();
  try {
    const leftIdentity = { ...owner, ownerId: "owner\u001fb", sessionId: "session" };
    const rightIdentity = { ...owner, ownerId: "owner", sessionId: "b\u001fsession" };
    const left = createResultProjection(store, leftIdentity, "turn:t:g0");
    const right = createResultProjection(store, rightIdentity, "turn:t:g0");
    const value = left.projectToolResult({
      tool: "task_get",
      args: {},
      toolCallId: "call",
      result: giant(),
    }) as StoredResultReference;
    await assert.rejects(
      right.tool.execute({ reference: value.reference, page: 0 }, rightIdentity),
      { code: "result_not_found" },
    );
    // The aliased identity can neither read the body nor learn it exists.
    assert.deepEqual(listStoredResults(store, rightIdentity, "turn:t:g0"), []);
    assert.notEqual(
      resultScope("turn:t:g0", leftIdentity),
      resultScope("turn:t:g0", rightIdentity),
      "the two raw tuples must not encode to one scope",
    );
    // The same encoded scope is stable across calls, so dedup still works.
    assert.equal(
      resultScope("turn:t:g0", leftIdentity),
      resultScope("turn:t:g0", { ...leftIdentity }),
    );
  } finally {
    store.close();
  }
});
