import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import {
  createResultProjection,
  listStoredResults,
  MODEL_TOOL_RESULT_BYTES,
  RESULT_MANIFEST_NAMESPACE,
  readCanonicalResult,
  resultManifestKey,
  resultScope,
  type StoredResultManifest,
  type StoredResultReference,
} from "../../src/runtime/tool-results.js";
import { Store } from "../../src/storage/store.js";

/**
 * B2 follow-up review: the four parent-reported hardening defects plus the
 * adjacent identity/bounding properties they depend on. Every assertion is on
 * the actual serialized envelope, not on a character count.
 */
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
const actor: ActorContext = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  chatId: "chat",
  messageId: "event",
};
const big = (size = 60_000) => ({ outcome: "successful", entries: "审".repeat(size) });

function projection(store: Store, who: ActorContext = actor, scope = "g") {
  return createResultProjection(store, who, scope);
}

function project(
  factory: ReturnType<typeof createResultProjection>,
  result: unknown,
  extra: Record<string, unknown> = {},
) {
  return factory.projectToolResult({
    tool: "inspect",
    args: {},
    toolCallId: "call",
    result,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// 1. Metadata and fact identities are explicitly bounded in serialized bytes.
// ---------------------------------------------------------------------------

test("bounded metadata honours escaped bytes for control-heavy tool ids", async () => {
  const store = new Store(":memory:");
  try {
    for (const identity of ["\u0000".repeat(400), "\\".repeat(400), '"'.repeat(400)]) {
      const value = project(projection(store), big(), {
        tool: identity,
        toolCallId: identity,
      }) as StoredResultReference;
      assert.ok(
        bytes(value) <= MODEL_TOOL_RESULT_BYTES,
        `escaped identity ${JSON.stringify(identity.slice(0, 1))} produced ${bytes(value)} bytes`,
      );
      assert.equal(typeof value.reference, "string", "the canonical body stays addressable");
      const page = await awaitPage(store, value.reference);
      assert.ok(page > 0, "pages remain readable under the bounded identity");
    }
  } finally {
    store.close();
  }
});

test("distinct oversized tool identities never collapse onto one reference", () => {
  const store = new Store(":memory:");
  try {
    const factory = projection(store);
    const first = project(factory, big(), {
      tool: `${"t".repeat(300)}A`,
      toolCallId: "call",
    }) as StoredResultReference;
    const second = project(factory, big(), {
      tool: `${"t".repeat(300)}B`,
      toolCallId: "call",
    }) as StoredResultReference;
    assert.notEqual(first.reference, second.reference);
    assert.notEqual(first.tool, second.tool, "truncated metadata must stay distinguishable");
    assert.equal(store.entries(RESULT_MANIFEST_NAMESPACE).length, 2);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Scope encoding is unambiguous and proved on EVERY read path.
// ---------------------------------------------------------------------------

test("scope encoding cannot alias distinct owner/session/task tuples", () => {
  const tuples: ActorContext[] = [
    { ...actor, ownerId: "owner\u001fb", sessionId: "session" },
    { ...actor, ownerId: "owner", sessionId: "b\u001fsession" },
    { ...actor, ownerId: "owner", sessionId: "b", taskId: "session" },
    { ...actor, ownerId: "ownerb", sessionId: "session" },
    { ...actor, ownerId: "owner", sessionId: "b\u0000session" },
    { ...actor, ownerId: "owner%b", sessionId: "session" },
    { ...actor, ownerId: "owner%1fb", sessionId: "session" },
    { ...actor, ownerId: "owner", sessionId: "1fb" },
    { ...actor, ownerId: "owner\u0000", sessionId: "session" },
    { ...actor, ownerId: "owner", sessionId: "session", taskId: "task\u001ftask" },
    { ...actor, ownerId: "owner", sessionId: "session", taskId: "task" },
  ];
  const scopes = tuples.map((who) => resultScope("g", who));
  assert.equal(new Set(scopes).size, scopes.length, "scope encoding must be injective");
  // An absent task and an empty task id name the same (no task) scope, which is
  // the pre-existing contract, but neither may alias another identity.
  assert.equal(
    resultScope("g", { ...actor, taskId: undefined }),
    resultScope("g", { ...actor, taskId: "" }),
  );
  // The exact parent-reported alias pair must stay distinct.
  assert.notEqual(
    resultScope("g", { ...actor, ownerId: "owner\u001fb", sessionId: "session" }),
    resultScope("g", { ...actor, ownerId: "owner", sessionId: "b\u001fsession" }),
  );
});

test("a foreign identity never reads a page, canonical body or listing", async () => {
  const store = new Store(":memory:");
  try {
    const first = projection(store, { ...actor, ownerId: "owner\u001fb" });
    const value = project(first, big()) as StoredResultReference;
    for (const foreign of [
      { ...actor, ownerId: "owner", sessionId: "b\u001fsession" },
      { ...actor, ownerId: "owner" },
      { ...actor, sessionId: "other" },
      { ...actor, taskId: "other" },
      { ...actor, taskId: undefined },
    ]) {
      const factory = projection(store, foreign);
      await assert.rejects(
        Promise.resolve().then(() => factory.tool.execute({ reference: value.reference }, foreign)),
        (error: unknown) => {
          assert.ok(error instanceof OperationError);
          assert.ok(["result_not_found", "invalid_scope"].includes(error.code), error.code);
          return true;
        },
      );
      assert.throws(
        () => readCanonicalResult(store, foreign, "g", value.reference),
        (error: unknown) => {
          assert.ok(error instanceof OperationError);
          assert.ok(["result_not_found", "invalid_scope"].includes(error.code), error.code);
          return true;
        },
      );
      assert.deepEqual(listStoredResults(store, foreign, "g"), []);
    }
  } finally {
    store.close();
  }
});

test("a record with a colliding key but a foreign identity fails closed", async () => {
  const store = new Store(":memory:");
  try {
    const scopeKey = resultScope("g", actor);
    const reference = `rt1_${"a".repeat(32)}`;
    const forged: StoredResultManifest = {
      version: 1,
      scope: scopeKey,
      scopeLabel: "g",
      // The key proves this identity, the record claims another one.
      ownerId: "intruder",
      sessionId: actor.sessionId,
      taskId: actor.taskId,
      reference,
      tool: "task_get",
      toolCallId: "call",
      outcome: "successful",
      isError: false,
      facts: {},
      bytes: 10,
      pageBytes: 1024,
      pageCount: 1,
      createdAt: new Date(0).toISOString(),
    };
    const key = resultManifestKey(scopeKey, reference);
    store.set(RESULT_MANIFEST_NAMESPACE, key, forged);
    store.set("tool_result_pages", `${key}\u001f0`, "PRIVATE");
    // Either typed refusal is safe; returning the page is not.
    await assert.rejects(projection(store).tool.execute({ reference }, actor), (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.ok(["invalid_scope", "result_not_found"].includes(error.code), error.code);
      return true;
    });
    assert.throws(
      () => readCanonicalResult(store, actor, "g", reference),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.ok(["invalid_scope", "result_not_found"].includes(error.code), error.code);
        return true;
      },
    );
    assert.deepEqual(
      listStoredResults(store, actor, "g"),
      [],
      "the listing must not become a bypass",
    );
  } finally {
    store.close();
  }
});

test("a record aliased under another scope label is refused as stale", async () => {
  const store = new Store(":memory:");
  try {
    const value = project(projection(store, actor, "g1"), big()) as StoredResultReference;
    // Same identity, another activation: the exact scope label must match.
    await assert.rejects(
      projection(store, actor, "g2").tool.execute({ reference: value.reference }, actor),
      { code: "invalid_scope" },
    );
    // The same identity under a foreign label is listed nowhere.
    assert.deepEqual(listStoredResults(store, actor, "g2"), []);
    assert.equal(listStoredResults(store, actor, "g1").length, 1);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Deterministic identity keeps error semantics and tool identity, while the
//    same canonical result still deduplicates across tool call ids.
// ---------------------------------------------------------------------------

test("success and error projections of one body stay independently readable", async () => {
  const store = new Store(":memory:");
  try {
    const factory = projection(store);
    const raw = { text: "x".repeat(60_000) };
    const success = project(factory, raw) as StoredResultReference;
    const failure = project(factory, raw, { isError: true }) as StoredResultReference;
    assert.equal(success.outcome, "successful");
    assert.equal(success.isError, false);
    assert.equal(failure.outcome, "unknown", "an unclassified error is never a success");
    assert.equal(failure.isError, true);
    assert.notEqual(success.reference, failure.reference);
    assert.equal(store.entries(RESULT_MANIFEST_NAMESPACE).length, 2);
    const canonical = JSON.stringify(raw);
    assert.equal(readCanonicalResult(store, actor, "g", success.reference), canonical);
    assert.equal(readCanonicalResult(store, actor, "g", failure.reference), canonical);
    // Each classification keeps its own page set.
    for (const reference of [success.reference, failure.reference]) {
      const page = (await factory.tool.execute({ reference, page: 0 }, actor)) as {
        text: string;
        pageCount: number;
      };
      assert.ok(page.text.length > 0);
      assert.ok(page.pageCount > 1);
    }
  } finally {
    store.close();
  }
});

test("the same body projected twice as an error deduplicates instead of growing", () => {
  const store = new Store(":memory:");
  try {
    const factory = projection(store);
    const raw = { outcome: "not_executed", code: "invalid_argument", error: "x".repeat(40_000) };
    const first = project(factory, raw, { isError: true }) as StoredResultReference;
    const second = project(factory, raw, { isError: true, toolCallId: "other-call" }) as
      | StoredResultReference
      | undefined;
    assert.equal(second?.reference, first.reference);
    assert.equal(second?.outcome, first.outcome);
    assert.equal(store.entries(RESULT_MANIFEST_NAMESPACE).length, 1);
  } finally {
    store.close();
  }
});

test("a different tool identity never reuses another tool's reference", () => {
  const store = new Store(":memory:");
  try {
    const factory = projection(store);
    const raw = { text: "x".repeat(60_000) };
    const first = project(factory, raw, { tool: "task_get" }) as StoredResultReference;
    const second = project(factory, raw, { tool: "participant_send" }) as StoredResultReference;
    assert.notEqual(first.reference, second.reference);
    assert.equal(store.entries(RESULT_MANIFEST_NAMESPACE).length, 2);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Storage failure markers are bounded in bytes and never reclassify work.
// ---------------------------------------------------------------------------

test("storage-failure markers stay bounded for every escaped fact shape", () => {
  for (const text of ["\u0000".repeat(240), "界".repeat(240), "\\".repeat(400), '"'.repeat(400)]) {
    for (const isError of [false, true]) {
      const store = new Store(":memory:");
      const factory = projection(store);
      store.close();
      const value = factory.projectToolResult({
        tool: "\u0000".repeat(300),
        toolCallId: "\\".repeat(300),
        args: {},
        result: {
          ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`fact${index}`, text])),
          outcome: isError ? "not_executed" : "successful",
          accepted: true,
          error: { code: text, message: text },
          text: "x".repeat(40_000),
        },
        isError,
      }) as Record<string, unknown>;
      assert.equal(value.persisted, false);
      assert.equal(
        value.outcome,
        isError ? "not_executed" : "successful",
        "a storage failure must not rewrite the canonical outcome",
      );
      assert.equal(value.isError, isError);
      assert.ok(
        bytes(value) <= MODEL_TOOL_RESULT_BYTES,
        `${JSON.stringify(text.slice(0, 1))} marker is ${bytes(value)} bytes`,
      );
    }
  }
});

test("an unserializable canonical value keeps a bounded explicit marker", () => {
  const store = new Store(":memory:");
  try {
    const cyclic: Record<string, unknown> = { outcome: "unknown", note: "\u0000".repeat(4000) };
    cyclic.self = cyclic;
    const value = project(projection(store), cyclic, {
      tool: "\u0000".repeat(300),
      toolCallId: "\u0000".repeat(300),
    }) as Record<string, unknown>;
    assert.equal(value.error, "result_unserializable");
    assert.equal(value.persisted, false);
    assert.equal(value.outcome, "unknown");
    assert.ok(bytes(value) <= MODEL_TOOL_RESULT_BYTES);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Canonical bodies and pages stay exact and bounded under hostile content.
// ---------------------------------------------------------------------------

test("pages rejoin byte-exactly for surrogates, NULs and quotes", async () => {
  for (const text of ["\ud800".repeat(4000), "\u0000".repeat(20_000), '\\"'.repeat(20_000)]) {
    const store = new Store(":memory:");
    try {
      const factory = projection(store);
      const original = { outcome: "successful", nested: [text], tail: "终" };
      const value = project(factory, original) as StoredResultReference;
      assert.ok(bytes(value) <= MODEL_TOOL_RESULT_BYTES);
      let reconstructed = "";
      for (let page = 0; page < value.pageCount; page++) {
        const read = (await factory.tool.execute({ reference: value.reference, page }, actor)) as {
          text: string;
        };
        assert.ok(bytes(read) <= MODEL_TOOL_RESULT_BYTES, `page ${page} is ${bytes(read)} bytes`);
        reconstructed += read.text;
      }
      assert.equal(reconstructed, JSON.stringify(original));
      assert.equal(
        readCanonicalResult(store, actor, "g", value.reference),
        JSON.stringify(original),
      );
    } finally {
      store.close();
    }
  }
});

test("a page read never overshoots even with oversized stored metadata", async () => {
  const store = new Store(":memory:");
  try {
    const factory = projection(store);
    const value = project(factory, big(200_000), {
      tool: "t".repeat(20_000),
      toolCallId: "c".repeat(20_000),
    }) as StoredResultReference;
    assert.ok(bytes(value) <= MODEL_TOOL_RESULT_BYTES);
    for (let page = 0; page < value.pageCount; page++) {
      const read = await factory.tool.execute({ reference: value.reference, page }, actor);
      assert.ok(bytes(read) <= MODEL_TOOL_RESULT_BYTES, `page ${page} is ${bytes(read)} bytes`);
    }
    assert.equal(
      readCanonicalResult(store, actor, "g", value.reference),
      JSON.stringify(big(200_000)),
    );
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Read page 0, assert its serialized bound and report its size. */
async function awaitPage(store: Store, reference: string): Promise<number> {
  const value = await projection(store).tool.execute({ reference, page: 0 }, actor);
  assert.ok(bytes(value) <= MODEL_TOOL_RESULT_BYTES, `page is ${bytes(value)} bytes`);
  return bytes(value);
}
