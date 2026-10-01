import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { KeyedMutex } from "../../src/core/mutex.js";
import type { Task } from "../../src/core/types.js";
import { workflowState } from "../../src/orchestration/state.js";
import type { VerificationRun, VerificationRunner } from "../../src/orchestration/verify.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { Engine, logger } from "../app/helpers.js";
import { chooseLeaderAction, leaderEventPrompt } from "../app/leader-helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

const execute = promisify(execFile);

async function fixture(version: 2 | 3 = 3, kind: Task["kind"] = "discussion") {
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
    kind,
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
    if (await chooseLeaderAction(input)) return { text: "", messages: [] };
    if (input.tools[0]?.name === "orchestration_choice") {
      const ids: string[] = JSON.parse(leaderEventPrompt(input)).candidates.map(
        (candidate: { id: string }) => candidate.id,
      );
      await input.tools[0].execute(
        { candidateId: ids.includes("use_template") ? "use_template" : ids[0] },
        input.actor,
      );
      return { text: "", messages: [] };
    }
    await input.tools[0]?.execute(
      { template: kind, instructions: {}, deliveryRequirements: [] },
      input.actor,
    );
    return { text: "", messages: [] };
  };
  const replies: string[] = [];
  const controller = new AbortController();
  const options = {
    store: h.store,
    config: h.config,
    projects: h.catalog,
    engine,
    logger,
    signal: controller.signal,
    tasks: () => h.service,
    tools: () => [],
    retryDelayMs: 0,
    onReply: async (_task: Task, text: string) => {
      replies.push(text);
    },
  };
  const state = () => h.store.get<WorkflowState>(WORKFLOWS, task.id);
  const events = () => h.store.list<OrchestrationEvent>("task_orchestration_events");
  return {
    ...h,
    task,
    source,
    controller,
    options,
    state,
    events,
    replies,
    modelCalls: () => modelCalls,
  };
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

interface VerificationInternals {
  revision(task: Task, includeWorkflow?: boolean): string;
  workflow: {
    admission: KeyedMutex;
    verification: VerificationRunner;
    assertWorkspace(task: Task, event: OrchestrationEvent): Task;
  };
}

function gate() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function verificationFixture(long = false) {
  const h = await fixture(3, "development");
  const marker = join(h.directory, "verification-started");
  const release = join(h.directory, "verification-release");
  const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, process.cwd()); ${
    long
      ? `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0); } }, 10);`
      : ""
  }`;
  await h.catalog.save({
    ...h.catalog.get("worktree"),
    verify: [`exec ${shellQuote(process.execPath)} -e ${shellQuote(script)}`],
    verifyTimeoutMs: 5000,
  });
  await h.service.reconcile(h.task.id);
  const ready = h.service.get(actor, h.task.id);
  const worker = new TaskOrchestrator(h.options);
  const internals = worker as unknown as VerificationInternals;
  const state = workflowState(h.store, ready, internals.revision(ready, false));
  state.planning = "ready";
  state.phase = "validating";
  const revision = await workspaceRevision(ready.directories);
  for (const node of state.plan.nodes) {
    if (["planning", "implementing"].includes(node.phase))
      state.nodes[node.id] = { status: "completed", attempt: 1, artifactRevision: revision };
  }
  h.store.set(WORKFLOWS, ready.id, state);
  const runs = () => h.store.list<VerificationRun>("verification_runs");
  return { ...h, ready, worker, internals, marker, release, runs };
}

for (const boundary of ["admission", "availability"] as const)
  test(`verification rechecks the workspace after waiting for ${boundary}`, async () => {
    const h = await verificationFixture();
    const admission = h.internals.workflow.admission.run.bind(h.internals.workflow.admission);
    const list = h.store.list.bind(h.store);
    const waiting = gate();
    const resume = gate();
    let ticking: Promise<void> | undefined;
    let changed = false;
    try {
      h.internals.workflow.admission.run = async (key, operation) => {
        if (boundary === "admission") {
          waiting.release();
          await resume.wait;
        } else {
          // workspaceAvailable reads participants only after its async realpath checks.
          h.store.list = (namespace) => {
            if (!changed && namespace === "participants") {
              changed = true;
              h.service.records.save({ ...h.ready, worktreeReady: false });
            }
            return list(namespace);
          };
        }
        return admission(key, operation);
      };
      ticking = h.worker.tick();
      if (boundary === "admission") {
        await waiting.wait;
        h.service.records.save({ ...h.ready, directories: [h.source] });
        resume.release();
      }
      await ticking;
      assert.equal(h.runs().length, 0, "stale workspace never reserves or starts a command");
      assert.equal(existsSync(h.marker), false);
      assert.deepEqual(h.state()?.evidence, []);
      const deferred = h.events().find((event) => event.workflow?.candidate.kind === "verify");
      assert.equal(deferred?.error?.code, "orchestration_deferred");
      assert.equal(deferred?.state, "pending");
      assert.equal(deferred?.attempts, 0);
    } finally {
      resume.release();
      await ticking;
      h.internals.workflow.admission.run = admission;
      h.store.list = list;
      h.close();
    }
  });

test("workspace changes during log preparation cancel before spawn and reselect a new run after restore", async () => {
  const h = await verificationFixture();
  const save = h.store.set.bind(h.store);
  let changed = false;
  try {
    h.store.set = (namespace, id, value) => {
      save(namespace, id, value);
      if (
        !changed &&
        namespace === "verification_runs" &&
        (value as VerificationRun).status === "prepared"
      ) {
        changed = true;
        h.service.records.save({ ...h.ready, directories: [h.source] });
      }
    };
    await h.worker.tick();
    const cancelled = h.runs()[0];
    assert.ok(cancelled);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.exitConfirmed, true);
    assert.equal(cancelled.pid, undefined);
    assert.equal(cancelled.error, "cancelled_before_start");
    assert.equal(existsSync(h.marker), false);
    assert.deepEqual(h.state()?.evidence, []);
    assert.deepEqual(h.state()?.issues, []);
    const previous = h.events().find((event) => event.workflow?.candidate.kind === "verify");
    assert.equal(previous?.state, "done");
    h.store.set = save;
    h.service.records.save(h.ready);
    await h.worker.tick();
    const completed = h.runs().find((run) => run.retryOf === cancelled.id);
    assert.ok(completed);
    assert.equal(completed.status, "passed");
    assert.notEqual(completed.id, cancelled.id);
    assert.equal(
      await readFile(h.marker, "utf8"),
      await realpath(h.ready.directories[0] as string),
    );
    assert.deepEqual(
      h.state()?.evidence.map((evidence) => evidence.verificationId),
      [completed.id],
    );
    const selected = h
      .events()
      .find((event) => event.workflow?.candidate.verification?.retryOf === cancelled.id);
    assert.ok(selected);
    assert.notEqual(selected.id, previous?.id);
  } finally {
    h.store.set = save;
    await h.internals.workflow.verification.cancel(h.task.id);
    h.close();
  }
});

for (const change of ["readiness", "directories"] as const)
  test(`running verification cancels on ${change} changes without saving old evidence, then recovers`, async () => {
    const h = await verificationFixture(true);
    let ticking: Promise<void> | undefined;
    try {
      ticking = h.worker.tick();
      for (let attempt = 0; attempt < 1000 && !existsSync(h.marker); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(
        existsSync(h.marker),
        true,
        "configured child is executing before workspace changes",
      );
      h.service.records.save({
        ...h.ready,
        ...(change === "readiness" ? { worktreeReady: false } : { directories: [h.source] }),
      });
      await ticking;
      const cancelled = h.runs()[0];
      assert.ok(cancelled);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.exitConfirmed, true);
      assert.deepEqual(h.internals.workflow.verification.blockingDirectories(), []);
      assert.deepEqual(h.state()?.evidence, []);
      assert.deepEqual(h.state()?.issues, []);
      assert.equal(
        h.events().find((event) => event.workflow?.candidate.kind === "verify")?.state,
        "done",
      );
      const resumed = change === "directories" ? { ...h.ready, directories: [h.source] } : h.ready;
      h.service.records.save(resumed);
      writeFileSync(h.release, "finish next selected run");
      await h.worker.tick();
      const completed = h.runs().find((run) => run.id !== cancelled.id);
      assert.ok(completed);
      assert.equal(completed.status, "passed");
      assert.equal(completed.retryOf, change === "readiness" ? cancelled.id : undefined);
      assert.equal(completed.cwd, await realpath(resumed.directories[0] as string));
      assert.equal(completed.artifactRevision, await workspaceRevision(resumed.directories));
      assert.deepEqual(
        h.state()?.evidence.map((evidence) => evidence.verificationId),
        [completed.id],
      );
      assert.equal(
        h.events().filter((event) => event.workflow?.candidate.kind === "verify").length,
        2,
      );
    } finally {
      await h.internals.workflow.verification.cancel(h.task.id);
      await ticking;
      h.close();
    }
  });

for (const change of ["requirements", "shutdown with directory change"] as const)
  test(`cancelled verification cannot overwrite newer workflow state after ${change}`, async () => {
    const h = await verificationFixture(true);
    let running: Promise<void> | undefined;
    try {
      running = h.worker.tick();
      for (let attempt = 0; attempt < 1000 && !existsSync(h.marker); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(existsSync(h.marker), true);
      h.service.records.save({
        ...h.ready,
        ...(change === "requirements"
          ? { requirements: `${h.ready.requirements}\n用户新增了验收要求。` }
          : { directories: [h.source] }),
      });
      const state = h.state();
      assert.ok(state);
      state.issues.push({
        id: "newer-review",
        description: "新版要求待核查。",
        status: "open",
        blocking: true,
        evidenceRefs: [],
        raisedBy: "user",
        responses: [],
      });
      h.store.set(WORKFLOWS, h.task.id, state);
      if (change === "shutdown with directory change") h.controller.abort();
      await running;
      assert.equal(h.runs()[0]?.status, "cancelled");
      assert.equal(h.runs()[0]?.exitConfirmed, true);
      assert.deepEqual(
        h.state(),
        state,
        "old cancellation must not save its stale workflow snapshot",
      );
      assert.deepEqual(h.state()?.evidence, []);
    } finally {
      h.controller.abort();
      await h.internals.workflow.verification.cancel(h.task.id);
      await running;
      h.close();
    }
  });

test("workspace changes during the final revision read discard an already exited result", async () => {
  const h = await verificationFixture();
  const workflow = h.internals.workflow;
  const run = workflow.verification.run.bind(workflow.verification);
  const guard = workflow.assertWorkspace.bind(workflow);
  let finished = false;
  let changed = false;
  try {
    workflow.verification.run = async (...args) => {
      const result = await run(...args);
      assert.equal(result.status, "passed");
      finished = true;
      return result;
    };
    workflow.assertWorkspace = (...args) => {
      const current = guard(...args);
      if (finished && !changed) {
        changed = true;
        // Runs at the first await of the final workspaceRevision, after its leading guard.
        queueMicrotask(() => h.service.records.save({ ...h.ready, directories: [h.source] }));
      }
      return current;
    };
    await h.worker.tick();
    assert.equal(changed, true);
    assert.equal(h.runs()[0]?.status, "passed", "the process exit remains in audit history");
    assert.deepEqual(h.state()?.evidence, []);
    assert.deepEqual(h.state()?.issues, []);
    assert.equal(
      h.events().find((event) => event.workflow?.candidate.kind === "verify")?.error?.code,
      "orchestration_deferred",
    );
  } finally {
    workflow.verification.run = run;
    workflow.assertWorkspace = guard;
    await workflow.verification.cancel(h.task.id);
    h.close();
  }
});

test("unconfirmed verification exit retains attention and directory blocking despite workspace changes", async () => {
  const h = await verificationFixture();
  const verification = h.internals.workflow.verification;
  const run = verification.run.bind(verification);
  try {
    verification.run = async (...args) => {
      const result = await run(...args);
      const unknown: VerificationRun = {
        ...result,
        status: "unknown",
        exitConfirmed: false,
        error: "runtime_exit_unconfirmed",
      };
      h.store.set("verification_runs", unknown.id, unknown);
      h.service.records.save({ ...h.ready, directories: [h.source] });
      return unknown;
    };
    await h.worker.tick();
    const event = h.events().find((entry) => entry.workflow?.candidate.kind === "verify");
    assert.equal(event?.state, "attention");
    assert.equal(event?.error?.code, "workflow_verify_unknown");
    assert.deepEqual(verification.blockingDirectories(), [
      await realpath(h.ready.directories[0] as string),
    ]);
    assert.deepEqual(h.state()?.evidence, []);
    assert.deepEqual(h.state()?.issues, []);
  } finally {
    verification.run = run;
    await verification.cancel(h.task.id);
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
        engine: {
          contextTokens: h.options.engine.contextTokens,
          summarize: () => h.options.engine.summarize(),
          run: async (input) => {
            const result = await h.options.engine.run(input);
            if (!changed) {
              changed = true;
              h.service.records.save({
                ...ready,
                ...(change === "readiness"
                  ? { worktreeReady: false }
                  : { directories: [h.source] }),
              });
            }
            return result;
          },
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
