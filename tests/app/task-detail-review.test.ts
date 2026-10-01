import assert from "node:assert/strict";
import test from "node:test";
import { taskDetailPage } from "../../src/app/task-details.js";
import type { Task } from "../../src/core/types.js";
import { setup } from "./helpers.js";

const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "create" };

async function fixture(
  requirements = "Read the canonical records without executing any work.",
  authenticated = false,
) {
  const h = setup();
  const task = await h.app.tasks.create(actor, {
    kind: "discussion",
    title: "Detail boundary review",
    requirements,
    participants: [{ kind: "claude" }],
    createGroup: false,
    createRemoteTask: false,
    orchestration: { mode: "manual" },
  });
  if (authenticated) {
    const current = h.store.get<Task>("tasks", task.id);
    assert.ok(current);
    h.store.set<Task>("tasks", task.id, {
      ...current,
      userRequest: { ...actor, source: "web", eventId: "request-event", text: requirements },
    });
  }
  const services = { store: h.store, tasks: h.app.tasks };
  return { h, task, services };
}

function event(taskId: string) {
  return {
    id: "detail-event",
    taskId,
    trigger: "ready",
    userRevision: "revision",
    state: "done",
    attempts: 1,
    outputIds: [],
    dispatches: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function readSection(
  services: Parameters<typeof taskDetailPage>[0],
  taskId: string,
  section: string,
) {
  const bodies: string[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await taskDetailPage(services, actor, taskId, {
      section,
      cursor,
      limitBytes: 16_000,
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(page), "utf8") <= 16_000,
      "bound the complete page envelope",
    );
    for (const entry of page.entries) bodies.push(entry.body ?? JSON.stringify(entry.fields ?? {}));
    if (!page.cursor) return bodies.join("");
    assert.notEqual(page.cursor, cursor, "every page must make progress");
    cursor = page.cursor;
  }
  assert.fail("canonical detail did not terminate");
}

test("decision snapshots omitted from task_get remain fully readable on demand", async () => {
  const { h, task, services } = await fixture();
  try {
    h.store.set("task_orchestration_events", "detail-event", event(task.id));
    const original = `${"snapshot-body-".repeat(3000)}CANONICAL_SNAPSHOT_TAIL`;
    h.store.set("workflow_decisions", "detail-event:selection:review", {
      policyVersion: "review",
      state: "completed",
      revision: "revision",
      snapshot: { original },
      snapshotRef: "durable-snapshot",
      candidates: [],
      dispatches: [],
    });
    const readable = await readSection(services, task.id, "decisions");
    assert.ok(
      readable.includes(original),
      "persisted snapshot bodies need a lossless scoped read path, not only an omission flag",
    );
    assert.equal(h.herdr.sends.length, 0);
    assert.equal(h.engine.calls.length, 0);
  } finally {
    await h.close();
  }
});

test("oversized orchestration error fields remain readable instead of being skipped forever", async () => {
  const { h, task, services } = await fixture();
  try {
    const message = `${"N".repeat(30_000)}CANONICAL_ERROR_TAIL`;
    h.store.set("task_orchestration_events", "detail-event", {
      ...event(task.id),
      state: "attention",
      error: { code: "transport", outcome: "unknown", message },
    });
    const readable = await readSection(services, task.id, "orchestration");
    assert.ok(
      readable.includes(message),
      "large non-body fields must also be pageable without losing their canonical tail",
    );
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    await h.close();
  }
});

test("legacy tasks without authenticated request metadata retain their full requirements reader", async () => {
  const original = `${"legacy-requirement-".repeat(3000)}MANDATORY_REQUIREMENT_TAIL`;
  const { h, task, services } = await fixture(original);
  try {
    const readable = await readSection(services, task.id, "requirements");
    assert.ok(
      readable.includes(original),
      "task.requirements is canonical even on historical tasks without source metadata",
    );
  } finally {
    await h.close();
  }
});

test("detail cursors reject a same-length canonical content revision", async () => {
  const { h, task, services } = await fixture("A".repeat(30_000), true);
  try {
    const first = await taskDetailPage(services, actor, task.id, {
      section: "requirements",
      limitBytes: 2000,
    });
    assert.ok(first.cursor);
    const current = h.store.get<Task>("tasks", task.id);
    assert.ok(current?.userRequest);
    h.store.set<Task>("tasks", task.id, {
      ...current,
      requirements: "B".repeat(30_000),
      userRequest: { ...current.userRequest, text: "B".repeat(30_000) },
    });
    await assert.rejects(
      taskDetailPage(services, actor, task.id, {
        section: "requirements",
        limitBytes: 2000,
        cursor: first.cursor,
      }),
      (error: unknown) => (error as { code?: string }).code === "invalid_cursor",
      "a length-only fingerprint must not splice different revisions into one apparent original",
    );
  } finally {
    await h.close();
  }
});

test("the smallest accepted detail budget bounds all metadata or refuses before returning a page", async () => {
  const { h, task, services } = await fixture("mandatory ".repeat(200), true);
  try {
    try {
      const page = await taskDetailPage(services, actor, task.id, {
        section: "requirements",
        limitBytes: 512,
      });
      assert.ok(
        Buffer.byteLength(JSON.stringify(page), "utf8") <= 512,
        "metadata and escaped fields count against limitBytes too",
      );
    } catch (error) {
      assert.equal(
        (error as { code?: string }).code,
        "context_budget",
        "irreducible metadata must fail closed with a typed budget error",
      );
    }
  } finally {
    await h.close();
  }
});
