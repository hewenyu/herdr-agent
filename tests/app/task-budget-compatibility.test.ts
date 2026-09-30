import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationTools } from "../../src/app/tools.js";
import { taskInput } from "../../src/app/validation.js";
import type { Task, TaskCreateInput } from "../../src/core/types.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

const legacyInput = {
  ...discussion,
  orchestration: { mode: "model", maxDecisions: "1", maxMinutes: "240" },
  discussion: { mode: "round_robin", maxRounds: "4", maxMinutes: "30" },
};

test("stored legacy budgets and explicit pause stay readable while new round-robin input is rejected", async () => {
  const h = setup();
  try {
    h.config.ai.enabled = true;
    assert.throws(() => taskInput(legacyInput), { code: "discussion_mode_deprecated" });
    const task = await h.service.create(
      actor,
      taskInput({ ...legacyInput, discussion: { mode: "manual" } }),
    );
    // Seed a stored legacy task: deprecated creation must not prevent reading old budgets.
    task.discussion.mode = "round_robin";
    task.orchestration = { mode: "model", maxDecisions: 1, maxMinutes: 240 };
    task.discussion.maxRounds = 4;
    task.discussion.maxMinutes = 30;
    task.discussion.paused = true;
    task.status = "paused";
    h.service.records.save(task);
    const replay = h.service.records.get(actor, task.id);
    assert.equal(replay.id, task.id);
    assert.equal(replay.status, "paused");
    assert.equal(replay.discussion.paused, true);
    assert.equal(h.store.list<Task>("tasks").length, 1);
    assert.equal(h.service.records.participants(replay).length, 2);
  } finally {
    h.close();
  }
});

test("new tasks neither validate nor persist obsolete execution quotas", async () => {
  const h = setup();
  try {
    h.config.ai.enabled = true;
    const task = await h.service.create(
      actor,
      taskInput({
        ...legacyInput,
        orchestration: { mode: "model", maxDecisions: 0, maxMinutes: -1 },
        discussion: { mode: "manual", maxRounds: 0, maxMinutes: -1 },
      }),
    );
    assert.deepEqual(task.orchestration, { mode: "workflow" });
    assert.equal("maxRounds" in task.discussion, false);
    assert.equal("maxMinutes" in task.discussion, false);
  } finally {
    h.close();
  }
});

test("task creation tool no longer advertises local execution quotas", () => {
  const services = {} as Parameters<typeof applicationTools>[0];
  const tool = applicationTools(services, actor).find((entry) => entry.name === "task_create");
  assert.ok(tool);
  const schema = tool.parameters as {
    properties: Record<string, { properties: Record<string, unknown> }>;
  };
  assert.deepEqual(Object.keys(schema.properties.orchestration?.properties ?? {}), [
    "mode",
    "template",
  ]);
  assert.deepEqual(Object.keys(schema.properties.discussion?.properties ?? {}), ["mode"]);
});

for (const apiKey of [undefined, "configured-jev-key"])
  test(`task_create advertises and defaults to workflow independently of Jev (${apiKey ? "configured" : "absent"})`, async () => {
    const inputs: TaskCreateInput[] = [];
    const services = {
      config: { jev: { apiKey } },
      tasks: {
        create: async (_actor: unknown, input: TaskCreateInput) => {
          inputs.push(input);
          return {};
        },
      },
    } as unknown as Parameters<typeof applicationTools>[0];
    const tool = applicationTools(services, actor).find((entry) => entry.name === "task_create");
    assert.ok(tool);
    const schema = tool.parameters as {
      properties: { orchestration: { properties: { mode: { enum: string[] } } } };
    };
    assert.deepEqual(schema.properties.orchestration.properties.mode.enum, ["manual", "workflow"]);
    await tool.execute({ ...discussion }, actor);
    assert.equal(inputs[0]?.orchestration?.mode, "workflow");
    await tool.execute({ ...discussion, discussion: { mode: "manual" } }, actor);
    assert.equal(inputs[1]?.orchestration, undefined, "explicit manual discussion stays manual");
  });
