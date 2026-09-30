import assert from "node:assert/strict";
import test from "node:test";
import { canonical, stableId } from "../../src/core/ids.js";
import type { Participant, Task } from "../../src/core/types.js";
import { workspaceAvailable } from "../../src/orchestration/workspace.js";
import { Operations } from "../../src/storage/operations.js";
import { Store } from "../../src/storage/store.js";

function fixture() {
  const store = new Store(":memory:");
  const task = {
    id: "new",
    kind: "discussion",
    directories: [process.cwd()],
    participantIds: [],
  } as unknown as Task;
  const old = {
    ...task,
    id: "old",
    status: "destroying",
    discussion: { paused: true },
    participantIds: ["old:p1"],
  } as Task;
  const execution = {
    paneId: "w1:p1",
    workspaceId: "w1",
    cwd: process.cwd(),
    kind: "codex" as const,
    transcriptReceipt: "old-receipt",
  };
  const participant = {
    id: "old:p1",
    taskId: old.id,
    status: "gone",
    execution,
  } as Participant;
  const parameters = { text: "old input" };
  const input = {
    id: "old:send:unknown",
    state: "uncertain",
    fingerprint: stableId(canonical(parameters)),
    updatedAt: "2026-09-29T01:00:00Z",
  };
  const delivery = {
    taskId: old.id,
    participantId: participant.id,
    operationId: input.id,
    execution,
    fingerprint: input.fingerprint,
  };
  const close = {
    id: `${participant.id}:close`,
    state: "done",
    fingerprint: stableId(canonical(execution)),
    updatedAt: "2026-09-29T02:00:00Z",
  };
  store.set("tasks", task.id, task);
  store.set("tasks", old.id, old);
  store.set("participants", participant.id, participant);
  store.set("operations", input.id, input);
  store.set("input_deliveries", input.id, delivery);
  store.set("operations", close.id, close);
  return { store, task, old, participant, input, delivery, close, parameters };
}

test("closed executions release workspace admission without changing unknown input or deduplication facts", async () => {
  const f = fixture();
  try {
    const before = JSON.stringify([
      f.store.entries("operations"),
      f.store.entries("input_deliveries"),
      f.store.entries("tasks"),
    ]);
    assert.equal(await workspaceAvailable(f.store, f.task, "read"), true);
    assert.equal(await workspaceAvailable(f.store, f.task, "write"), true);
    assert.equal(
      JSON.stringify([
        f.store.entries("operations"),
        f.store.entries("input_deliveries"),
        f.store.entries("tasks"),
      ]),
      before,
    );
    await assert.rejects(
      new Operations(f.store).run(f.input.id, f.parameters, async () => {
        assert.fail("An unknown input must never be replayed by the occupancy release");
      }),
      { code: "operation_uncertain" },
    );
    f.store.set("tasks", f.old.id, { ...f.old, status: "destroyed" });
    f.store.set("participants", f.participant.id, { ...f.participant, status: "removed" });
    assert.equal(await workspaceAvailable(f.store, f.task, "write"), true);
  } finally {
    f.store.close();
  }
});

const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ["paused task", (f) => f.store.set("tasks", f.old.id, { ...f.old, status: "paused" })],
  ["live task", (f) => f.store.set("tasks", f.old.id, { ...f.old, status: "review" })],
  ["missing delivery", (f) => f.store.delete("input_deliveries", f.input.id)],
  ["missing close", (f) => f.store.delete("operations", f.close.id)],
  ...["failed", "uncertain", "pending"].map(
    (state): [string, (f: ReturnType<typeof fixture>) => void] => [
      `${state} close`,
      (f) => f.store.set("operations", f.close.id, { ...f.close, state }),
    ],
  ),
  ...["2026-09-29T00:00:00Z", "2026-09-29T01:00:00Z", "invalid"].map(
    (updatedAt): [string, (f: ReturnType<typeof fixture>) => void] => [
      `close time ${updatedAt}`,
      (f) => f.store.set("operations", f.close.id, { ...f.close, updatedAt }),
    ],
  ),
  [
    "wrong close fingerprint",
    (f) => f.store.set("operations", f.close.id, { ...f.close, fingerprint: "different" }),
  ],
  [
    "wrong delivery fingerprint",
    (f) => f.store.set("input_deliveries", f.input.id, { ...f.delivery, fingerprint: "different" }),
  ],
  [
    "foreign delivery",
    (f) => f.store.set("input_deliveries", f.input.id, { ...f.delivery, taskId: "unrelated" }),
  ],
  [
    "replacement execution",
    (f) =>
      f.store.set("participants", f.participant.id, {
        ...f.participant,
        execution: { ...f.participant.execution, transcriptReceipt: "new-receipt" },
      }),
  ],
  [
    "working participant",
    (f) => f.store.set("participants", f.participant.id, { ...f.participant, status: "working" }),
  ],
  ["pending input", (f) => f.store.set("operations", f.input.id, { ...f.input, state: "pending" })],
  [
    "other unknown operation",
    (f) => f.store.set("operations", "old:delete-group", { state: "uncertain" }),
  ],
  [
    "unsettled output",
    (f) =>
      f.store.set("participant_awaiting_output", f.participant.id, { operationId: f.input.id }),
  ],
];

for (const [name, change] of cases) {
  test(`workspace stays reserved with ${name}`, async () => {
    const f = fixture();
    try {
      change(f);
      assert.equal(await workspaceAvailable(f.store, f.task, "write"), false);
    } finally {
      f.store.close();
    }
  });
}
