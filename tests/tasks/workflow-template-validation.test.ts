import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import { applicationTools } from "../../src/app/tools.js";
import { OperationError } from "../../src/core/errors.js";
import type { Task, TaskCreateInput, TaskKind } from "../../src/core/types.js";
import { workflowState } from "../../src/orchestration/state.js";
import type { WorkflowTemplate } from "../../src/orchestration/workflow.js";
import { actor, discussion, setup } from "./helpers.js";

type Harness = ReturnType<typeof setup>;
type Entry = "direct" | "tool";

function create(h: Harness, entry: Entry, input: TaskCreateInput): Promise<Task> {
  if (entry === "direct") return h.service.create(actor, input);
  const tool = applicationTools(
    {
      config: h.config,
      tasks: h.service,
      projects: h.catalog,
      herdr: h.herdr,
      store: h.store,
      sessions: {} as Parameters<typeof applicationTools>[0]["sessions"],
    },
    actor,
  ).find((item) => item.name === "task_create");
  assert.ok(tool);
  return tool.execute({ ...input }, actor).then((result) => {
    const response = result as { accepted: boolean; task: Task };
    assert.equal(response.accepted, true);
    return response.task;
  });
}

const legal: Array<[TaskKind, WorkflowTemplate]> = [
  ["discussion", "discussion"],
  ["development", "development"],
  ["development", "bugfix"],
  ["review", "development"],
  ["review", "bugfix"],
  ["test", "development"],
  ["test", "bugfix"],
];
const illegal: Array<[TaskKind, WorkflowTemplate]> = [
  ["discussion", "development"],
  ["discussion", "bugfix"],
  ["development", "discussion"],
  ["review", "discussion"],
  ["test", "discussion"],
];

for (const entry of ["direct", "tool"] as const) {
  test(`${entry} rejects incompatible workflow templates before creating any resources`, async () => {
    let changes = 0;
    const h = setup({ changed: () => changes++ });
    try {
      h.config.ai.enabled = true;
      const files = readdirSync(h.directory).sort();
      const catalog = h.catalog.snapshot();
      const writes: string[] = [];
      const save = h.store.set.bind(h.store);
      h.store.set = (namespace, key, value) => {
        writes.push(namespace);
        save(namespace, key, value);
      };
      for (const [kind, template] of illegal) {
        await assert.rejects(
          create(h, entry, {
            ...discussion,
            kind,
            project: `rejected-${kind}-${template}`,
            newProject: true,
            orchestration: { mode: "workflow", template },
          }),
          (error: unknown) => {
            assert.ok(error instanceof OperationError);
            assert.equal(error.code, "workflow_template");
            assert.equal(error.outcome, "not_executed");
            assert.ok(error.message.includes(`任务类型 ${kind}`));
            assert.ok(error.message.includes(`工作流模板 ${template}`));
            assert.match(error.message, /只能使用/);
            return true;
          },
        );
      }
      await h.service.tick();
      assert.deepEqual(writes, [], "reject before even a project operation receipt is saved");
      assert.deepEqual(readdirSync(h.directory).sort(), files);
      assert.deepEqual(h.catalog.snapshot(), catalog);
      assert.deepEqual(h.store.list("tasks"), []);
      assert.deepEqual(h.store.list("participants"), []);
      assert.equal(changes, 0);
      assert.equal(h.herdr.creates, 0);
      assert.equal(h.herdr.starts, 0);
      assert.equal(h.herdr.sends.length, 0);
      assert.equal(h.platform.creates, 0);
      assert.equal(h.platform.groups, 0);
    } finally {
      h.close();
    }
  });

  test(`${entry} accepts all compatible workflow kind/template pairs and initializes their plans`, async () => {
    const h = setup();
    try {
      h.config.ai.enabled = true;
      for (const [kind, template] of legal) {
        const task = await create(h, entry, {
          ...discussion,
          kind,
          orchestration: { mode: "workflow", template },
        });
        assert.equal(task.kind, kind);
        assert.deepEqual(task.orchestration, { mode: "workflow", template });
        const state = workflowState(h.store, task, "initial-revision");
        assert.equal(state.plan.template, template);
        assert.equal(state.planning, "needed");
        if (kind === "review" || kind === "test")
          assert.ok(state.plan.nodes.every((node) => node.access === "read"));
      }
    } finally {
      h.close();
    }
  });

  test(`${entry} keeps the template optional for each workflow task kind`, async () => {
    const h = setup();
    try {
      h.config.ai.enabled = true;
      for (const kind of ["discussion", "development", "review", "test"] as const) {
        const task = await create(h, entry, {
          ...discussion,
          kind,
          orchestration: { mode: "workflow" },
        });
        assert.deepEqual(task.orchestration, { mode: "workflow" });
        const state = workflowState(h.store, task, "initial-revision");
        assert.equal(state.plan.template, kind === "discussion" ? "discussion" : "development");
      }
    } finally {
      h.close();
    }
  });
}

test("manual mode ignores a supplied workflow template; stale model input is validated as workflow", async () => {
  const h = setup();
  try {
    h.config.ai.enabled = true;
    const manual = await h.service.create(actor, {
      ...discussion,
      orchestration: { mode: "manual", template: "bugfix" },
    });
    assert.deepEqual(manual.orchestration, { mode: "manual" });
    // With AI enabled, a new explicit model request is normalized to workflow
    // regardless of the Jev key, so its template must be compatible.
    const model = await h.service.create(
      { ...actor, messageId: "stale-model" },
      { ...discussion, orchestration: { mode: "model", template: "discussion" } },
    );
    assert.deepEqual(model.orchestration, { mode: "workflow", template: "discussion" });
    await assert.rejects(
      h.service.create(
        { ...actor, messageId: "stale-model-bugfix" },
        { ...discussion, orchestration: { mode: "model", template: "bugfix" } },
      ),
      { code: "workflow_template" },
    );
  } finally {
    h.close();
  }
});
