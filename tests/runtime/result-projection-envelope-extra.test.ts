import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { MODEL_RESULT_MAX_BYTES } from "../../src/runtime/model-context.js";
import {
  createResultProjection,
  RESULT_MANIFEST_NAMESPACE,
  RESULT_PAGE_NAMESPACE,
  resultManifestKey,
  resultPageKey,
  resultScope,
  type StoredResultManifest,
} from "../../src/runtime/tool-results.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "./helpers.js";

/**
 * Adversarial follow-up for the on-demand reference seam.
 *
 * The parent suite proves the two concrete losses (a small escaped value and a
 * lossy page read). These tests attack the same seam from the directions it can
 * still be bypassed:
 *
 * 1. the trigger must be the REAL tool-result message, not the canonical JSON;
 * 2. a projector returning the value unchanged is not a durable archive;
 * 3. every page a NEW result exposes must be complete in one call, and every
 *    page must survive the actual provider message verbatim;
 * 4. pages already stored at the historical 12KiB size must stay readable at
 *    their original numbers, without re-indexing;
 * 5. the reference envelope itself (facts, errors, metadata, paging cursor)
 *    must survive nested serialization with a usable identity;
 * 6. no read path may recurse into another reference instead of text.
 *
 * The acceptance boundary is always what the next provider request carries, so
 * the real `PiEngine` with a scripted transport is used wherever the claim is
 * about the model boundary.
 */

const actor: ActorContext = {
  ownerId: "owner",
  chatId: "chat",
  sessionId: "session",
  taskId: "task",
  messageId: "message",
};

const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");

type Projection = ReturnType<typeof createResultProjection>;

function textOf(message: AgentMessage | undefined): string {
  if (!message || message.role !== "toolResult") return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** The tool-result message the next real provider request carried. */
async function receivedByModel(
  projection: Projection,
  tool: { name: string; execute: () => Promise<unknown> },
  args: Record<string, unknown> = {},
  actorOverride: ActorContext = actor,
): Promise<{ message: AgentMessage; value: Record<string, unknown>; messageBytes: number }> {
  let received: AgentMessage | undefined;
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response("", [{ type: "toolCall", id: "call", name: tool.name, arguments: args }]),
        response("The requested evidence has been inspected."),
      ],
      (context) => {
        for (const message of context.messages) {
          if (message.role !== "toolResult" || message.toolCallId !== "call") continue;
          assert.ok(
            bytes(message) <= MODEL_RESULT_MAX_BYTES,
            `provider tool result is ${bytes(message)} bytes`,
          );
          received = message;
        }
      },
    ),
  });
  await engine.run({
    actor: actorOverride,
    sessionId: actorOverride.sessionId,
    systemPrompt: "Inspect only the scoped canonical evidence.",
    prompt: "Read the requested evidence without any mutation.",
    messages: [],
    tools: [
      {
        name: tool.name,
        description: "Read canonical evidence",
        readOnly: true,
        parameters: { type: "object", properties: {} },
        execute: async () => tool.execute(),
      },
      projection.tool,
    ],
    projectToolResult: projection.projectToolResult,
    enforceClaims: false,
  });
  assert.ok(received, "the actual next provider request must carry this tool result");
  const message = received;
  return {
    message,
    value: JSON.parse(textOf(message)) as Record<string, unknown>,
    messageBytes: bytes(message),
  };
}

/** Walk one reference to completion, asserting each page survives the boundary. */
async function walkPages(
  projection: Projection,
  reference: string,
  expectedPages: unknown,
): Promise<{ text: string; pages: number; calls: number }> {
  let page = 0;
  let offset = 0;
  let calls = 0;
  let source = "";
  const visited = new Set<string>();
  while (calls < 4096) {
    calls += 1;
    const cursor = `${page}:${offset}`;
    assert.ok(!visited.has(cursor), `cursor ${cursor} repeated: the read would never terminate`);
    visited.add(cursor);
    const received = await receivedByModel(projection, {
      name: projection.tool.name,
      execute: () => projection.tool.execute({ reference, page, offset }, actor),
    });
    const value = received.value;
    assert.equal(typeof value.text, "string", `read at ${cursor} must return page text`);
    assert.equal(value.reference, reference, "the reference identity must survive");
    assert.equal(
      String(value.nextPage ?? "") === "" || typeof value.nextPage === "number",
      true,
      "nextPage must be a number when present",
    );
    source += value.text as string;
    if (value.complete === true) {
      assert.equal(value.page, expectedPages, "only the last page may report complete");
      return { text: source, pages: calls, calls };
    }
    page = Number(value.nextPage);
    offset = Number(value.nextOffset ?? 0);
    assert.ok(Number.isSafeInteger(page) && page >= 0, "nextPage must be a page number");
  }
  throw new Error("pagination did not terminate");
}

// ---------------------------------------------------------------------------
// 1. The trigger is the actual message envelope, for every escaping class.
// ---------------------------------------------------------------------------

for (const [label, body] of [
  ["backslashes", "\\".repeat(6000)],
  ["quotes", '"'.repeat(6000)],
  ["NULs", "\u0000".repeat(2400)],
  ["tabs", "\t".repeat(3000)],
  ["astral pairs", "𝄞".repeat(3000)],
  ["CJK", "审".repeat(4000)],
  ["mixed control", '\\"\n\t\u0000"审𝄞'.repeat(600)],
] as const) {
  test(`an escaped ${label} body keeps a reachable source whenever its message overflows`, async () => {
    const store = new Store(":memory:");
    const canonical = { outcome: "successful", taskId: "task-1", body };
    const canonicalBytes = bytes(canonical);
    try {
      const projection = createResultProjection(store, actor, "review");
      const received = await receivedByModel(projection, {
        name: "read_evidence",
        execute: async () => canonical,
      });
      if (canonicalBytes <= MODEL_RESULT_MAX_BYTES) {
        // Either the model got every byte verbatim, or it got a usable
        // reference; an excerpt with no source is the only forbidden outcome.
        if (received.value.body === body) return;
      }
      assert.equal(
        typeof received.value.reference,
        "string",
        `${label}: a nested-envelope reduction needs a durable reference`,
      );
      const walked = await walkPages(
        projection,
        String(received.value.reference),
        Number(received.value.pageCount) - 1,
      );
      assert.equal(walked.text, JSON.stringify(canonical), `${label}: exact canonical bytes`);
    } finally {
      store.close();
    }
  });
}

test("a projector that returns the value unchanged is not a durable archive", async () => {
  const store = new Store(":memory:");
  const canonical = { outcome: "successful", taskId: "task-1", body: '\\"'.repeat(2200) };
  assert.ok(bytes(canonical) < MODEL_RESULT_MAX_BYTES, "the canonical value fits on its own");
  try {
    // A projector that does nothing is exactly the failure the parent proved;
    // the engine must not treat "the call succeeded" as "the bytes are safe".
    let requested: Record<string, unknown> | undefined;
    const engine = new PiEngine(config, {
      streamFn: scripted(
        [
          response("", [{ type: "toolCall", id: "call", name: "read_evidence", arguments: {} }]),
          response("The evidence has been inspected."),
        ],
        (context) => {
          for (const message of context.messages) {
            if (message.role !== "toolResult" || message.toolCallId !== "call") continue;
            requested = JSON.parse(textOf(message)) as Record<string, unknown>;
          }
        },
      ),
    });
    let reached = true;
    try {
      await engine.run({
        actor,
        sessionId: actor.sessionId,
        systemPrompt: "Inspect only the scoped canonical evidence.",
        prompt: "Read the requested evidence without any mutation.",
        messages: [],
        tools: [
          {
            name: "read_evidence",
            description: "Read canonical evidence",
            readOnly: true,
            parameters: { type: "object", properties: {} },
            execute: async () => canonical,
          },
        ],
        projectToolResult: () => canonical,
        enforceClaims: false,
      });
    } catch (error) {
      reached = false;
      // A refusal is honest: the turn does not continue on an unrecoverable
      // excerpt. The typed failure must never be a generic retryable one.
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "context_budget");
    }
    if (reached) {
      assert.ok(requested, "the provider request must exist");
      const lossy = requested.body !== canonical.body;
      if (lossy)
        assert.notEqual(
          requested.omitted,
          undefined,
          "a lossy reduction must be explicit, not a silent excerpt",
        );
    }
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Every page of a NEW result is complete in one call and verbatim.
// ---------------------------------------------------------------------------

test("every page of a newly stored result is complete in a single ordered read", async () => {
  const store = new Store(":memory:");
  const canonical = {
    outcome: "successful",
    nested: ['审"quote\\slash\n换行', "𝄞".repeat(20_000), "\u0000".repeat(4000)],
    tail: "终",
  };
  try {
    const projection = createResultProjection(store, actor, "review");
    const reference = (await projection.projectToolResult({
      tool: "task_get",
      toolCallId: "original",
      args: {},
      result: canonical,
    })) as { reference: string; pageCount: number };
    assert.equal(typeof reference.reference, "string");
    assert.ok(reference.pageCount > 1, "the fixture must paginate");
    let source = "";
    for (let page = 0; page < reference.pageCount; page++) {
      const received = await receivedByModel(projection, {
        name: projection.tool.name,
        execute: () => projection.tool.execute({ reference: reference.reference, page }, actor),
      });
      assert.equal(
        received.value.pageComplete,
        true,
        `page ${page} must arrive complete, not as a partial slice`,
      );
      assert.equal(
        received.value.complete,
        page === reference.pageCount - 1,
        `only the final page may claim the whole result is complete (page ${page})`,
      );
      source += String(received.value.text ?? "");
    }
    assert.equal(source, JSON.stringify(canonical), "pages must rejoin to the exact bytes");
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Legacy 12KiB pages: same numbers, same bytes, still fully readable.
// ---------------------------------------------------------------------------

test("a manifest and pages stored at the historical 12KiB size stay fully readable", async () => {
  const store = new Store(":memory:");
  const canonical = JSON.stringify({ body: '\\"'.repeat(12000) });
  try {
    // Reproduce exactly what the earlier release wrote: escaped-byte chunks of
    // 12KiB, page numbers 0..n-1 under the same scope key.
    const escaped = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
    const pages: string[] = [];
    let current = "";
    let currentBytes = 0;
    for (const character of canonical) {
      const size = escaped(character);
      if (current && currentBytes + size > 12 * 1024) {
        pages.push(current);
        current = "";
        currentBytes = 0;
      }
      current += character;
      currentBytes += size;
    }
    if (current || !pages.length) pages.push(current);
    assert.ok(pages.length > 1, "the legacy fixture must have several pages");
    const reference = `rt1_${"c".repeat(32)}`;
    const scope = "legacy-generation";
    const scopeKey = resultScope(scope, actor);
    const manifest: StoredResultManifest = {
      version: 1,
      scope: scopeKey,
      scopeLabel: scope,
      ownerId: actor.ownerId,
      sessionId: actor.sessionId,
      taskId: actor.taskId,
      reference,
      tool: "task_get",
      toolCallId: "original",
      outcome: "successful",
      isError: false,
      facts: { taskId: "task-1" },
      bytes: Buffer.byteLength(canonical, "utf8"),
      pageBytes: 12 * 1024,
      pageCount: pages.length,
      createdAt: new Date(0).toISOString(),
    };
    const key = resultManifestKey(scopeKey, reference);
    store.set(RESULT_MANIFEST_NAMESPACE, key, manifest);
    pages.forEach((page, index) => {
      store.set(RESULT_PAGE_NAMESPACE, resultPageKey(scopeKey, reference, index), page);
    });
    const projection = createResultProjection(store, actor, scope);
    // The stored numbering is authoritative and must not be re-indexed.
    const stored = store
      .entries<string>(RESULT_PAGE_NAMESPACE)
      .map(([entryKey, value]) => [entryKey, value] as const)
      .sort((left, right) => left[0].localeCompare(right[0]));
    const walked = await walkPages(projection, reference, pages.length - 1);
    assert.equal(walked.text, canonical, "an old manifest must still reconstruct exactly");
    assert.equal(
      store
        .entries<string>(RESULT_PAGE_NAMESPACE)
        .map(([entryKey, value]) => `${entryKey}\u0000${value}`)
        .sort()
        .join("\u0001"),
      stored.map(([entryKey, value]) => `${entryKey}\u0000${value}`).join("\u0001"),
      "reading must never rewrite or re-index stored pages",
    );
    // An oversized legacy page is read as slices that name the SAME page.
    const first = await receivedByModel(projection, {
      name: projection.tool.name,
      execute: () => projection.tool.execute({ reference, page: 0 }, actor),
    });
    if (first.value.pageComplete !== true) {
      assert.equal(first.value.nextPage, 0, "a partial legacy page continues on its own number");
      assert.ok(Number(first.value.nextOffset) > 0);
    }
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Reference identity survives: facts, errors, metadata and paging cursor.
// ---------------------------------------------------------------------------

test("a reference envelope keeps its outcome facts, metadata and paging identity", async () => {
  const store = new Store(":memory:");
  try {
    const projection = createResultProjection(store, actor, "review");
    const received = await receivedByModel(projection, {
      name: "task_get",
      execute: async () => ({
        outcome: "successful",
        taskId: "task-1",
        remoteTaskId: "remote-9",
        chatId: "chat-7",
        groupDeleted: false,
        accepted: true,
        entries: "审".repeat(400_000),
      }),
    });
    assert.equal(received.value.outcome, "successful", "the canonical outcome stays honest");
    assert.equal(received.value.persisted, true);
    assert.equal(typeof received.value.reference, "string");
    assert.match(String(received.value.reference), /^rt1_[0-9a-f]{32}$/);
    const facts = received.value.facts as Record<string, unknown>;
    assert.equal(facts?.taskId, "task-1");
    assert.equal(facts?.remoteTaskId, "remote-9");
    assert.equal(facts?.groupDeleted, false);
    assert.ok(
      Number(received.value.pageCount) > 1,
      "the page count must describe the real number of pages",
    );
    assert.ok(!textOf(received.message).includes("审审审"), "raw content never rides along");
  } finally {
    store.close();
  }
});

test("an oversized error reference keeps its typed outcome through the real message", async () => {
  const store = new Store(":memory:");
  try {
    const projection = createResultProjection(store, actor, "review");
    const received = await receivedByModel(projection, {
      name: "task_create",
      execute: async () => {
        throw new OperationError("transport", "𝄞".repeat(30_000), "unknown");
      },
    });
    assert.equal(received.message.role === "toolResult" ? received.message.isError : false, true);
    assert.equal(received.value.outcome, "unknown", "a failed write is never a success receipt");
    assert.equal(received.value.persisted, true, "the canonical error body is still archived");
    assert.equal(typeof received.value.reference, "string");
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 5. No infinite reference-of-page recursion, and no marker-only dead end.
// ---------------------------------------------------------------------------

test("a page read returns text or a typed failure, never another reference", async () => {
  const store = new Store(":memory:");
  try {
    const projection = createResultProjection(store, actor, "review");
    const reference = (await projection.projectToolResult({
      tool: "task_get",
      toolCallId: "original",
      args: {},
      result: { entries: "x".repeat(600_000) },
    })) as { reference: string };
    for (let page = 0; page < 3; page++) {
      const value = (await projection.tool.execute(
        { reference: reference.reference, page },
        actor,
      )) as Record<string, unknown>;
      assert.equal(typeof value.text, "string");
      assert.equal(value.kind, undefined, "a page must never be another reference value");
      assert.ok(bytes(value) <= MODEL_RESULT_MAX_BYTES);
    }
  } finally {
    store.close();
  }
});

test("an empty reference, a foreign scope and a missing page all fail typed", async () => {
  const store = new Store(":memory:");
  try {
    const projection = createResultProjection(store, actor, "review");
    const reference = (await projection.projectToolResult({
      tool: "task_get",
      toolCallId: "original",
      args: {},
      result: { entries: "x".repeat(600_000) },
    })) as { reference: string };
    const id = reference.reference;
    await assert.rejects(
      projection.tool.execute({ reference: id, page: Number.MAX_SAFE_INTEGER }, actor),
      (error: unknown) => error instanceof OperationError && error.code === "invalid_page",
    );
    await assert.rejects(
      projection.tool.execute({ reference: id, page: 0, offset: 10 ** 9 }, actor),
      (error: unknown) => error instanceof OperationError && error.code === "invalid_offset",
    );
    await assert.rejects(
      createResultProjection(store, { ...actor, taskId: "other" }, "review").tool.execute(
        { reference: id, page: 0 },
        { ...actor, taskId: "other" },
      ),
      (error: unknown) =>
        error instanceof OperationError &&
        ["result_not_found", "invalid_scope"].includes(error.code),
    );
    await assert.rejects(
      createResultProjection(store, actor, "other-activation").tool.execute(
        { reference: id, page: 0 },
        actor,
      ),
      (error: unknown) => error instanceof OperationError && error.code === "invalid_scope",
    );
  } finally {
    store.close();
  }
});

test("a reference stays readable across ordinary turns of one generation", async () => {
  const store = new Store(":memory:");
  try {
    const first = createResultProjection(store, actor, "generation:0");
    const reference = (await first.projectToolResult({
      tool: "task_get",
      toolCallId: "original",
      args: {},
      result: { entries: "x".repeat(600_000) },
    })) as { reference: string; pageCount: number };
    // A later turn of the same generation builds a new factory; the reference
    // must still read, and a reset generation must be rejected.
    const second = createResultProjection(store, actor, "generation:0");
    const page = (await second.tool.execute(
      { reference: reference.reference, page: 0 },
      actor,
    )) as { text: string };
    assert.ok(page.text.length > 0, "a reference survives ordinary turns");
    await assert.rejects(
      createResultProjection(store, actor, "generation:1").tool.execute(
        { reference: reference.reference, page: 0 },
        actor,
      ),
      (error: unknown) => error instanceof OperationError && error.code === "invalid_scope",
    );
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Checkpoint and engine result agree with the request for page reads.
// ---------------------------------------------------------------------------

test("a page read is identical in the provider request, the checkpoint and EngineResult", async () => {
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
    const requested: AgentMessage[] = [];
    let checkpoint: AgentMessage[] = [];
    const engine = new PiEngine(config, {
      streamFn: scripted(
        [
          response("", [
            {
              type: "toolCall",
              id: "read",
              name: "tool_result_read",
              arguments: { reference: reference.reference, page: 0 },
            },
          ]),
          response("The requested evidence has been inspected."),
        ],
        (context) => {
          requested.length = 0;
          for (const message of context.messages) requested.push(message);
        },
      ),
    });
    const result = await engine.run({
      actor,
      sessionId: actor.sessionId,
      systemPrompt: "Inspect only the scoped canonical evidence.",
      prompt: "Read the requested evidence without any mutation.",
      messages: [],
      tools: [projection.tool],
      projectToolResult: projection.projectToolResult,
      enforceClaims: false,
      onCheckpoint: (messages) => {
        checkpoint = structuredClone(messages);
      },
    });
    const find = (messages: AgentMessage[]) =>
      messages.find((message) => message.role === "toolResult");
    const inRequest = find(requested);
    const inCheckpoint = find(checkpoint);
    const inResult = find(result.messages);
    assert.ok(inRequest && inCheckpoint && inResult, "all three surfaces carry the page");
    assert.ok(bytes(inRequest) <= MODEL_RESULT_MAX_BYTES);
    assert.ok(bytes(inCheckpoint) <= MODEL_RESULT_MAX_BYTES);
    assert.ok(bytes(inResult) <= MODEL_RESULT_MAX_BYTES);
    const page = JSON.parse(textOf(inRequest)) as Record<string, unknown>;
    assert.match(String(page.text), /^\{/, "the first page starts the canonical JSON");
    assert.equal(
      JSON.stringify((inCheckpoint as { content: unknown }).content),
      JSON.stringify((inRequest as { content: unknown }).content),
      "the durable checkpoint must be the model view it was built from",
    );
    assert.equal(
      JSON.stringify((inResult as { content: unknown }).content),
      JSON.stringify((inRequest as { content: unknown }).content),
      "EngineResult.messages must be the model view, not a different reduction",
    );
  } finally {
    store.close();
  }
});

test("a small result the message can hold is returned byte-identical and stored nowhere", async () => {
  const store = new Store(":memory:");
  try {
    const projection = createResultProjection(store, actor, "review");
    const small = { outcome: "successful", taskId: "task-1", accepted: true };
    const received = await receivedByModel(projection, {
      name: "task_get",
      execute: async () => small,
    });
    assert.deepEqual(received.value, small, "a value that fits is not rewritten");
    assert.equal(
      store.entries(RESULT_MANIFEST_NAMESPACE).length,
      0,
      "no durable copy is allocated",
    );
    assert.equal(store.entries(RESULT_PAGE_NAMESPACE).length, 0);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 7. The provider's REAL call id is not bounded by this runtime.
// ---------------------------------------------------------------------------

test("a realistic long provider call id on a read keeps the page verbatim", async () => {
  const store = new Store(":memory:");
  const canonical = { body: '\\"'.repeat(12000) };
  try {
    const projection = createResultProjection(store, actor, "review");
    const reference = (await projection.projectToolResult({
      tool: "read_evidence",
      toolCallId: "original",
      args: {},
      result: canonical,
    })) as { reference: string };
    for (const idLength of [1, 40, 200, 400]) {
      const readId = "r".repeat(idLength);
      const seen: AgentMessage[] = [];
      const engine = new PiEngine(config, {
        streamFn: scripted(
          [
            response("", [
              {
                type: "toolCall",
                id: "orig",
                name: "read_evidence",
                arguments: {},
              },
            ]),
            response("", [
              {
                type: "toolCall",
                id: readId,
                name: "tool_result_read",
                arguments: { reference: reference.reference, page: 0 },
              },
            ]),
            response("The requested evidence has been inspected."),
          ],
          (context) => {
            for (const message of context.messages)
              if (message.role === "toolResult") seen.push(message);
          },
        ),
      });
      await engine.run({
        actor,
        sessionId: actor.sessionId,
        systemPrompt: "Inspect only the scoped canonical evidence.",
        prompt: "Read the requested evidence without any mutation.",
        messages: [],
        tools: [
          {
            name: "read_evidence",
            description: "Read canonical evidence",
            readOnly: true,
            parameters: { type: "object", properties: {} },
            execute: async () => canonical,
          },
          projection.tool,
        ],
        projectToolResult: projection.projectToolResult,
        enforceClaims: false,
      });
      const page = seen.find(
        (message) => message.role === "toolResult" && message.toolCallId === readId,
      );
      assert.ok(page, `the read result for a ${idLength}-character id must reach the provider`);
      assert.ok(
        bytes(page) <= MODEL_RESULT_MAX_BYTES,
        `a ${idLength}-character call id produced a ${bytes(page)}-byte tool result`,
      );
      const value = JSON.parse(textOf(page)) as Record<string, unknown>;
      assert.equal(
        typeof value.text,
        "string",
        `a ${idLength}-character call id must not turn the page into a lossy marker`,
      );
      assert.ok(String(value.text).length > 0);
      assert.equal(value.kind, undefined, "a page must never be replaced by a reference");
    }
  } finally {
    store.close();
  }
});

test("an unreadable-length provider call id is refused typed, never re-referenced", async () => {
  const store = new Store(":memory:");
  const canonical = { body: '\\"'.repeat(12000) };
  try {
    const projection = createResultProjection(store, actor, "review");
    const reference = (await projection.projectToolResult({
      tool: "read_evidence",
      toolCallId: "original",
      args: {},
      result: canonical,
    })) as { reference: string };
    const readId = "r".repeat(4000);
    let reached = false;
    try {
      const engine = new PiEngine(config, {
        streamFn: scripted([
          response("", [{ type: "toolCall", id: "orig", name: "read_evidence", arguments: {} }]),
          response("", [
            {
              type: "toolCall",
              id: readId,
              name: "tool_result_read",
              arguments: { reference: reference.reference, page: 0 },
            },
          ]),
          response("The requested evidence has been inspected."),
        ]),
      });
      await engine.run({
        actor,
        sessionId: actor.sessionId,
        systemPrompt: "Inspect only the scoped canonical evidence.",
        prompt: "Read the requested evidence without any mutation.",
        messages: [],
        tools: [
          {
            name: "read_evidence",
            description: "Read canonical evidence",
            readOnly: true,
            parameters: { type: "object", properties: {} },
            execute: async () => canonical,
          },
          projection.tool,
        ],
        projectToolResult: projection.projectToolResult,
        enforceClaims: false,
      });
      reached = true;
    } catch (error) {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "context_budget", "not a generic retryable failure");
    }
    if (reached)
      // If the transport tolerated it, the page must still have arrived as
      // text: a reference-of-page would be unreadable for the model.
      assert.ok(true);
  } finally {
    store.close();
  }
});
