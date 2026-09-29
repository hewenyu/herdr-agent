import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import test from "node:test";
import { actor, discussion, setup } from "./helpers.js";

test("configured Jev governs new automatic tasks even when stale input explicitly requests model", async () => {
  const h = setup();
  try {
    h.config.ai.enabled = true;
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-only";
    const task = await h.service.create(actor, {
      ...discussion,
      orchestration: { mode: "model" },
      discussion: { mode: "round_robin" },
    });
    assert.equal(task.orchestration?.mode, "workflow");
    assert.equal(task.promptVersion, 3);
    assert.ok(task.boardDirectory && existsSync(task.boardDirectory));
  } finally {
    h.close();
  }
});

test("enabling Jev never migrates or duplicates a previously created model task on retry", async () => {
  const h = setup();
  try {
    h.config.ai.enabled = true;
    const input = { ...discussion, orchestration: { mode: "model" as const } };
    const old = await h.service.create(actor, input);
    assert.equal(old.orchestration?.mode, "model");
    const stored = h.store.get("tasks", old.id);
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-only";
    const retry = await h.service.create(actor, input);
    assert.deepEqual(retry, stored);
    assert.equal(h.service.list(actor).length, 1);
    const fresh = await h.service.create({ ...actor, messageId: "next-task" }, input);
    assert.equal(fresh.orchestration?.mode, "workflow");
    assert.equal(fresh.promptVersion, 3);
    assert.equal(h.service.get(actor, old.id).orchestration?.mode, "model");
  } finally {
    h.close();
  }
});

test("explicit manual and round-robin tasks retain their controls with Jev configured", async () => {
  const h = setup();
  try {
    h.config.ai.enabled = true;
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-only";
    const manual = await h.service.create(actor, {
      ...discussion,
      orchestration: { mode: "manual" },
    });
    assert.equal(manual.orchestration?.mode, "manual");
    const rotating = await h.service.create(actor, {
      ...discussion,
      discussion: { mode: "round_robin" },
    });
    assert.equal(rotating.orchestration, undefined);
    assert.equal(rotating.discussion.mode, "round_robin");
  } finally {
    h.close();
  }
});

test("normalizing stale model input validates its workflow template before project side effects", async () => {
  const h = setup();
  try {
    h.config.ai.enabled = true;
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-only";
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
