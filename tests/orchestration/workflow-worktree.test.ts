import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { Task } from "../../src/core/types.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

const execute = promisify(execFile);

async function fixture(version: 2 | 3 = 3) {
  const h = setup();
  h.config.ai.enabled = true;
  assert.ok(h.config.jev);
  h.config.jev.apiKey = "fixture-only";
  const source = join(h.directory, "source");
  mkdirSync(source);
  writeFileSync(join(source, "app.ts"), "// committed source\n");
  await h.catalog.save({ name: "worktree", directories: [source], agent: "codex" });
  await execute("git", ["-C", source, "add", "app.ts"]);
  await execute("git", [
    "-C",
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  const task = await h.service.create(actor, {
    ...discussion,
    project: "worktree",
    directoryMode: "worktree",
    orchestration: { mode: "workflow" },
  });
  task.promptVersion = version;
  h.service.records.save(task);
  const engine = new Engine();
  let modelCalls = 0;
  engine.handler = async (input) => {
    modelCalls++;
    await input.tools[0]?.execute(
      { template: "discussion", instructions: {}, deliveryRequirements: [] },
      input.actor,
    );
    return { text: "", messages: [] };
  };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    modelCalls++;
    const ids = Object.keys(JSON.parse(String(init?.body)).questions.action.criteria);
    const choice = ids.includes("use_template") ? "use_template" : ids[0];
    return Response.json({
      model: "jev-fixture",
      answers: {
        action: {
          type: "choice",
          choice,
          confidence: 0.99,
          probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
        },
      },
      usage: { input_tokens: 10, output_tokens: 1 },
    });
  };
  const replies: string[] = [];
  const options = {
    store: h.store,
    config: h.config,
    projects: h.catalog,
    engine,
    fetch,
    logger,
    signal: new AbortController().signal,
    tasks: () => h.service,
    tools: () => [],
    retryDelayMs: 0,
    onReply: async (_task: Task, text: string) => {
      replies.push(text);
    },
  };
  const state = () => h.store.get<WorkflowState>(WORKFLOWS, task.id);
  const events = () => h.store.list<OrchestrationEvent>("task_orchestration_events");
  return { ...h, task, source, options, state, events, replies, modelCalls: () => modelCalls };
}

for (const [version, recovered] of [
  [3, false],
  [3, true],
  [2, true],
] as const)
  test(`worktree preparation gates planning, source reads and dispatch (v${version}, recovered=${recovered})`, async () => {
    const h = await fixture(version);
    const create = h.catalog.worktree.bind(h.catalog);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let startup: Promise<unknown> | undefined;
    try {
      if (recovered) h.service.records.save({ ...h.task, status: "starting" });
      const worker = new TaskOrchestrator(h.options);
      await worker.tick();
      h.catalog.worktree = async (...args) => {
        entered();
        await held;
        return create(...args);
      };
      startup = h.service.reconcile(h.task.id);
      await waiting;
      await worker.tick();
      await new TaskOrchestrator(h.options).tick();
      assert.equal(h.state(), undefined);
      assert.deepEqual(h.events(), []);
      assert.equal(h.modelCalls(), 0);
      assert.equal(h.herdr.sends.length, 0);
      assert.deepEqual(h.replies, []);
      release();
      await startup;
      const ready = h.service.get(actor, h.task.id);
      assert.equal(ready.worktreeReady, true);
      assert.notDeepEqual(ready.directories, [h.source]);
      const restarted = new TaskOrchestrator(h.options);
      await restarted.tick();
      assert.equal(h.state()?.planning, "ready");
      if (version === 3)
        assert.deepEqual(
          h.state()?.documentSource?.directories,
          await Promise.all(ready.directories.map((path) => realpath(path))),
        );
      else
        assert.equal(h.state()?.documentSource, undefined, "legacy v2 keeps its existing protocol");
      await restarted.tick();
      assert.ok(h.herdr.sends.length > 0);
      assert.ok(h.modelCalls() > 0);
      assert.ok(h.events().every((event) => event.state !== "attention"));
      assert.deepEqual(h.replies, []);
    } finally {
      release();
      await startup;
      h.close();
    }
  });

for (const change of ["readiness", "directories"] as const)
  test(`provision changes during planning defer without freezing a stale ${change} snapshot`, async () => {
    const h = await fixture();
    try {
      await h.service.reconcile(h.task.id);
      const ready = h.service.get(actor, h.task.id);
      let changed = false;
      const worker = new TaskOrchestrator({
        ...h.options,
        fetch: async (url, init) => {
          const result = await h.options.fetch(url, init);
          if (!changed) {
            changed = true;
            h.service.records.save({
              ...ready,
              ...(change === "readiness" ? { worktreeReady: false } : { directories: [h.source] }),
            });
          }
          return result;
        },
      });
      await worker.tick();
      assert.equal(h.state()?.documentSource, undefined);
      assert.equal(h.state()?.planning, "needed");
      assert.equal(h.store.get("workflow_plans", `${h.task.id}:1`), undefined);
      assert.equal(h.herdr.sends.length, 0);
      assert.equal(h.events()[0]?.state, "pending");
      assert.equal(h.events()[0]?.attempts, 0);
      assert.equal(h.events()[0]?.error?.code, "orchestration_deferred");
      assert.deepEqual(h.replies, []);
      h.service.records.save(ready);
      await worker.tick();
      assert.equal(h.state()?.planning, "ready");
      assert.deepEqual(
        h.state()?.documentSource?.directories,
        await Promise.all(ready.directories.map((path) => realpath(path))),
      );
      await worker.tick();
      assert.equal(h.herdr.sends.length, 1);
      assert.ok(h.events().every((event) => event.state !== "attention"));
    } finally {
      h.close();
    }
  });
