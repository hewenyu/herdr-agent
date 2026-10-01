import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import {
  createResultProjection,
  type StoredResultReference,
} from "../../src/runtime/tool-results.js";
import { Store } from "../../src/storage/store.js";

const actor = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  chatId: "chat",
  messageId: "event",
};
const fields = [
  "id",
  "taskId",
  "participantId",
  "status",
  "state",
  "outcome",
  "code",
  "kind",
  "action",
  "accepted",
  "verified",
  "complete",
  "ok",
  "remoteTaskId",
  "chatId",
  "groupDeleted",
  "replyId",
  "messageId",
];
const facts = (text: string) => ({
  ...Object.fromEntries(fields.map((key) => [key, text])),
  error: { code: text, message: text },
  text: "x".repeat(30000),
});
const project = (result: unknown, isError = false) => ({
  tool: "inspect",
  args: {},
  toolCallId: "call",
  result,
  isError,
});

test("persisted references budget UTF-8 bytes across all optional facts", () => {
  const store = new Store(":memory:");
  try {
    const value = createResultProjection(store, actor, "g").projectToolResult({
      ...project(facts("界".repeat(240))),
      tool: "\u0000".repeat(200),
      toolCallId: "\u0000".repeat(200),
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(value)) <= 16384,
      "string length is not serialized UTF-8 size",
    );
  } finally {
    store.close();
  }
});

test("storage-failure markers still bound escaped canonical facts", () => {
  const store = new Store(":memory:");
  const factory = createResultProjection(store, actor, "g");
  store.close();
  const value = factory.projectToolResult(project(facts("\u0000".repeat(240)))) as {
    persisted?: boolean;
    outcome?: string;
  };
  assert.equal(value.persisted, false);
  assert.equal(value.outcome, "successful");
  assert.ok(
    Buffer.byteLength(JSON.stringify(value)) <= 16384,
    "projection failure must not make the model boundary fail open",
  );
});

test("identical canonical data cannot reuse a contradictory success/error envelope", () => {
  const store = new Store(":memory:");
  try {
    const factory = createResultProjection(store, actor, "g");
    const raw = { text: "x".repeat(30000) };
    const first = factory.projectToolResult(project(raw)) as StoredResultReference;
    assert.equal(first.outcome, "successful");
    const error = factory.projectToolResult(project(raw, true)) as StoredResultReference;
    assert.equal(error.isError, true);
    assert.equal(
      error.outcome,
      "unknown",
      "deduplication must not overwrite canonical error semantics",
    );
  } finally {
    store.close();
  }
});

test("scope tuple separators cannot alias two distinct owner/session identities", async () => {
  const store = new Store(":memory:");
  try {
    const firstActor = { ...actor, ownerId: "owner\u001fb", sessionId: "session" };
    const otherActor = { ...actor, ownerId: "owner", sessionId: "b\u001fsession" };
    const first = createResultProjection(store, firstActor, "g");
    const other = createResultProjection(store, otherActor, "g");
    const value = first.projectToolResult(
      project({ text: "PRIVATE".repeat(5000) }),
    ) as StoredResultReference;
    await assert.rejects(
      Promise.resolve().then(() => other.tool.execute({ reference: value.reference }, otherActor)),
      (error: unknown) => error instanceof OperationError && error.outcome === "not_executed",
    );
  } finally {
    store.close();
  }
});
