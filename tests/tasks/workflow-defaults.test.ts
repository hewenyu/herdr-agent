import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import test from "node:test";
import type { Task } from "../../src/core/types.js";
import { actor, discussion, setup } from "./helpers.js";

for (const key of ["", "fixture-only"]) {
  test(`AI-enabled automatic tasks default to workflow regardless of Jev key: key=${Boolean(key)}`, async () => {
    const h = setup();
    try {
      h.config.ai.enabled = true;
      assert.ok(h.config.jev);
      h.config.jev.apiKey = key;
      const implicit = await h.service.create(actor, discussion);
      assert.equal(implicit.orchestration?.mode, "workflow");
      assert.equal(implicit.promptVersion, 3);
      assert.ok(implicit.boardDirectory && existsSync(implicit.boardDirectory));
      const stale = await h.service.create(
        { ...actor, messageId: "stale-model" },
        { ...discussion, orchestration: { mode: "model" } },
      );
      assert.equal(stale.orchestration?.mode, "workflow");
      assert.equal(stale.promptVersion, 3);
      assert.ok(stale.boardDirectory && existsSync(stale.boardDirectory));
    } finally {
      h.close();
    }
  });
}

test("AI disabled still creates tasks without automatic orchestration", async () => {
  const h = setup();
  try {
    h.config.ai.enabled = false;
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-only";
    const task = await h.service.create(actor, discussion);
    assert.equal(task.orchestration, undefined);
    assert.equal(task.promptVersion, undefined);
    await assert.rejects(
      h.service.create(
        { ...actor, messageId: "explicit-model" },
        { ...discussion, orchestration: { mode: "model" } },
      ),
      { code: "ai_disabled" },
    );
  } finally {
    h.close();
  }
});

test("a persisted model task is never migrated or duplicated on creation retry", async () => {
  const h = setup();
  try {
    h.config.ai.enabled = true;
    const input = { ...discussion, orchestration: { mode: "model" as const } };
    const created = await h.service.create(actor, input);
    // Simulate a task persisted by an earlier release that kept explicit model.
    const persisted = h.store.get<Task>("tasks", created.id);
    assert.ok(persisted);
    persisted.orchestration = { mode: "model" };
    h.store.set("tasks", persisted.id, persisted);
    const retry = await h.service.create(actor, input);
    assert.equal(retry.id, created.id);
    assert.equal(retry.orchestration?.mode, "model");
    assert.equal(h.service.list(actor).length, 1);
    const fresh = await h.service.create({ ...actor, messageId: "next-task" }, input);
    assert.notEqual(fresh.id, created.id);
    assert.equal(fresh.orchestration?.mode, "workflow");
    assert.equal(fresh.promptVersion, 3);
    assert.equal(h.service.get(actor, created.id).orchestration?.mode, "model");
  } finally {
    h.close();
  }
});

test("durable task identity is computed from the original model input", async () => {
  const h = setup();
  try {
    h.config.ai.enabled = true;
    const model = await h.service.create(actor, {
      ...discussion,
      orchestration: { mode: "model" },
    });
    const workflow = await h.service.create(actor, {
      ...discussion,
      orchestration: { mode: "workflow" },
    });
    assert.equal(model.orchestration?.mode, "workflow");
    assert.notEqual(model.id, workflow.id);
    assert.equal(h.service.list(actor).length, 2);
  } finally {
    h.close();
  }
});

test("explicit manual control is retained and new round_robin is rejected without a Jev key", async () => {
  const h = setup();
  try {
    h.config.ai.enabled = true;
    const manual = await h.service.create(actor, {
      ...discussion,
      orchestration: { mode: "manual" },
    });
    assert.equal(manual.orchestration?.mode, "manual");
    assert.equal(manual.promptVersion, undefined);
    const manualDiscussion = await h.service.create(
      { ...actor, messageId: "manual-discussion" },
      { ...discussion, discussion: { mode: "manual" } },
    );
    assert.equal(manualDiscussion.orchestration, undefined);
    assert.equal(manualDiscussion.discussion.mode, "manual");
    await assert.rejects(
      h.service.create(
        { ...actor, messageId: "rotating" },
        { ...discussion, discussion: { mode: "round_robin" } },
      ),
      { code: "discussion_mode_deprecated" },
    );
  } finally {
    h.close();
  }
});

test("normalizing stale model input validates its workflow template before project side effects", async () => {
  const h = setup();
  try {
    h.config.ai.enabled = true;
    const before = readdirSync(h.directory).sort();
    const catalog = h.catalog.snapshot();
    await assert.rejects(
      h.service.create(actor, {
        ...discussion,
        project: "should-not-exist",
        newProject: true,
        orchestration: { mode: "model", template: "bugfix" },
      }),
      { code: "workflow_template", outcome: "not_executed" },
    );
    assert.deepEqual(h.catalog.snapshot(), catalog);
    assert.deepEqual(readdirSync(h.directory).sort(), before);
    assert.equal(h.store.list("tasks").length, 0);
    assert.equal(h.store.list("operations").length, 0);
  } finally {
    h.close();
  }
});
