import assert from "node:assert/strict";
import test from "node:test";
import { stableId } from "../../src/core/ids.js";
import type { StoredMessage, Task } from "../../src/core/types.js";
import {
  reportInputsChanged,
  revisionHash,
  revisionInputs,
} from "../../src/orchestration/revision.js";
import { Store } from "../../src/storage/store.js";

const task = {
  id: "task",
  ownerId: "owner",
  requirements: "原始要求",
  promptVersion: 3,
  orchestration: { mode: "workflow" },
} as Task;
function message(id: string, deliveryIds?: string[]): StoredMessage {
  return { id, taskId: task.id, deliveryIds, role: "user", source: "user" } as StoredMessage;
}
function provenance(store: Store, id: string, usage?: "read" | "control" | "input") {
  store.set("task_user_revisions", id, {
    taskId: task.id,
    source: { ownerId: "owner", messageId: id },
    usage,
  });
}

test("legacy messages without delivery IDs retain the historical hash and do not crash revision collection", () => {
  const store = new Store(":memory:");
  try {
    provenance(store, "known-control", "control");
    const messages = [message("legacy-no-delivery"), message("control", ["known-control"])];
    assert.equal(
      revisionHash(revisionInputs(store, task, messages)),
      stableId(task.requirements, "legacy-no-delivery"),
    );
    assert.equal(
      revisionHash(revisionInputs(store, { ...task, promptVersion: 2 }, messages)),
      stableId(task.requirements, "legacy-no-delivery", "control"),
    );
  } finally {
    store.close();
  }
});

test("adding input provenance to an already frozen message cannot invent a report revision", () => {
  const store = new Store(":memory:");
  try {
    const messages = [message("old-source", ["old-message"])];
    provenance(store, "old-message");
    const before = revisionInputs(store, task, messages);
    const revision = revisionHash(before);
    const evidence = { version: 1 as const, revision, inputs: before };
    provenance(store, "old-message", "input");
    const current = revisionInputs(store, task, messages);
    assert.equal(revisionHash(current), revision);
    assert.equal(reportInputsChanged(evidence, revision, current), false);
  } finally {
    store.close();
  }
});

test("a frozen passive turn becoming an actual input remains a report-relevant change", () => {
  const store = new Store(":memory:");
  try {
    const messages = [message("mixed-source", ["mixed-message"])];
    provenance(store, "mixed-message", "read");
    const before = revisionInputs(store, task, messages);
    const revision = revisionHash(before);
    provenance(store, "mixed-message", "input");
    assert.equal(
      reportInputsChanged(
        { version: 1, revision, inputs: before },
        revision,
        revisionInputs(store, task, messages),
      ),
      true,
    );
  } finally {
    store.close();
  }
});

test("unclassified historical chat and plan phase changes cannot alone retire a frozen report", () => {
  const store = new Store(":memory:");
  try {
    const before = revisionInputs(store, task, []);
    const revision = revisionHash(before);
    const current = revisionInputs(store, task, [message("question", ["unclassified"])]);
    current.workflow = ["2", "planning"];
    const evidence = { version: 1 as const, revision, inputs: before };
    assert.notEqual(revisionHash(current), revision);
    assert.equal(reportInputsChanged(evidence, revision, current), false);
    assert.equal(
      reportInputsChanged(undefined, revision, { ...current, requirements: "新要求" }),
      false,
    );
    assert.equal(
      reportInputsChanged(evidence, revision, { ...current, requirements: "新要求" }),
      true,
    );
    assert.equal(
      reportInputsChanged(evidence, revision, { ...current, resumes: ["resume-request"] }),
      true,
    );
    assert.equal(
      reportInputsChanged(evidence, revision, { ...current, mutations: ["participant-add"] }),
      true,
    );
    assert.equal(
      reportInputsChanged({ ...evidence, revision: "forged" }, revision, {
        ...current,
        requirements: "新要求",
      }),
      false,
    );
  } finally {
    store.close();
  }
});
