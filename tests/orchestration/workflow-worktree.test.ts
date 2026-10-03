import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { link, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import type { KeyedMutex } from "../../src/core/mutex.js";
import type { Logger } from "../../src/core/ports.js";
import type { Task } from "../../src/core/types.js";
import { workflowState } from "../../src/orchestration/state.js";
import type { VerificationRun, VerificationRunner } from "../../src/orchestration/verify.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import type { Store } from "../../src/storage/store.js";
import { Engine, logger } from "../app/helpers.js";
import { chooseLeaderAction, leaderEventPrompt } from "../app/leader-helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";
import { logTailFixture } from "./verification-log-fixture.js";
import {
  defaultLogTailIo,
  logTailFlags,
  selectVerificationLogTails,
  verificationLogTails,
} from "./verification-log-tail.js";

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

// Failure-only observations, not execution proof: a shell pid does not establish
// Node initialization, and missing/unknown records do not establish nonexecution.
function startupDiagnostics(
  original: Logger,
  readLogTails?: (rows: readonly unknown[]) => ReturnType<typeof selectVerificationLogTails>,
) {
  const codes: string[] = [];
  const scalar = (value: unknown): string | number | boolean | null => {
    if (value === null) return null;
    if (typeof value === "string") return value.slice(0, 96);
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      return value;
    return value === undefined ? "<missing>" : "<non-scalar>";
  };
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const pick = (value: unknown, keys: string[]) =>
    object(value)
      ? Object.fromEntries(keys.map((key) => [key, scalar(value[key])]))
      : { invalidShape: true };
  const wrapped: Logger = {
    info: (message, fields) => original.info(message, fields),
    warn: (message, fields) => original.warn(message, fields),
    error(message, fields) {
      // Capture must not prevent forwarding, even if diagnostic fields throw.
      try {
        codes.push(String(scalar(fields?.code)));
      } catch {
        codes.push("<unreadable>");
      }
      if (codes.length > 8) codes.shift();
      original.error(message, fields);
    },
  };
  return {
    logger: wrapped,
    message(store: Pick<Store, "get" | "list">, taskId: string): string {
      try {
        const snapshot: Record<string, unknown> = {};
        let runRows: unknown[] = [];
        const section = (name: string, read: () => unknown) => {
          try {
            snapshot[name] = read();
          } catch {
            snapshot[name] = "<unreadable>";
          }
        };
        section("task", () => pick(store.get("tasks", taskId), ["worktreeReady", "status"]));
        section("runs", () => {
          const rows = store.list("verification_runs");
          runRows = rows.slice(0, 6);
          return {
            total: rows.length,
            first: runRows.map((row) =>
              pick(row, [
                "status",
                "pid",
                "startedAt",
                "finishedAt",
                "exitCode",
                "signal",
                "exitConfirmed",
                "error",
              ]),
            ),
          };
        });
        section("events", () => {
          const rows = store.list("task_orchestration_events");
          return {
            total: rows.length,
            first: rows.slice(0, 4).map((row) => ({
              ...pick(row, ["state", "attempts"]),
              errorCode: scalar(object(row) && object(row.error) ? row.error.code : undefined),
            })),
          };
        });
        if (readLogTails) section("logTails", () => readLogTails(runRows) ?? { selected: 0 });
        snapshot.loggedErrorCodes = codes.slice();
        return `\n[startup diagnostic; observations only] ${JSON.stringify(snapshot)}`;
      } catch {
        return "\n[startup diagnostic unavailable]";
      }
    },
  };
}

test("startup diagnostics preserve logger forwarding and contain capture failures", () => {
  const calls: unknown[][] = [];
  let throwing = false;
  let reason: unknown;
  const original: Logger = Object.freeze({
    info(...args: Parameters<Logger["info"]>) {
      calls.push([this, "info", ...args]);
    },
    warn(...args: Parameters<Logger["warn"]>) {
      calls.push([this, "warn", ...args]);
    },
    error(...args: Parameters<Logger["error"]>) {
      calls.push([this, "error", ...args]);
      if (throwing) throw reason;
    },
  });
  const diagnostic = startupDiagnostics(original);
  const fields = { code: "example" };
  for (const level of ["info", "warn", "error"] as const) {
    diagnostic.logger[level]("message", fields);
    assert.deepEqual(calls.at(-1), [original, level, "message", fields]);
  }
  const hostile = Object.defineProperty({}, "code", {
    get() {
      throw new Error("capture");
    },
  });
  diagnostic.logger.error("still forwarded", hostile);
  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1)?.[3], hostile);
  throwing = true;
  for (reason of [undefined, null, false, 0, "", new Error("original")]) {
    let caught = false;
    try {
      diagnostic.logger.error("original failure");
    } catch (error) {
      caught = true;
      assert.equal(error, reason);
    }
    assert.equal(caught, true);
  }
  assert.equal(calls.length, 10);
});

test("startup diagnostics bound scalar output and omit full payloads", () => {
  const diagnostic = startupDiagnostics(logger);
  for (let index = 0; index < 20; index++)
    diagnostic.logger.error("secret message", { code: `code-${index}`, token: "secret token" });
  const long = "x".repeat(10_000);
  const rows: Record<string, unknown[]> = {
    verification_runs: Array.from({ length: 20 }, () => ({
      status: "unknown",
      pid: 123,
      startedAt: "observed",
      exitConfirmed: false,
      exitCode: 0,
      signal: long,
      error: {
        toString() {
          throw new Error("do not coerce");
        },
      },
      command: "secret command",
    })),
    task_orchestration_events: Array.from({ length: 20 }, () => ({
      state: "pending",
      attempts: 0,
      error: { code: long, message: "secret event" },
    })),
  };
  const store: Pick<Store, "get" | "list"> = {
    get: <T>() => ({ worktreeReady: false, status: "active", credentials: "secret" }) as T,
    list: <T>(namespace: string) => rows[namespace] as T[],
  };
  assert.ok(rows.verification_runs);
  rows.verification_runs[1] = { status: "timed_out", exitCode: null };
  const message = diagnostic.message(store, "task");
  const snapshot = JSON.parse(message.slice(message.indexOf("{")));
  assert.deepEqual(snapshot.task, { worktreeReady: false, status: "active" });
  assert.equal(snapshot.runs.total, 20);
  assert.equal(snapshot.runs.first.length, 6);
  assert.equal(snapshot.runs.first[0].exitConfirmed, false);
  assert.equal(snapshot.runs.first[0].exitCode, 0);
  assert.equal(snapshot.runs.first[1].exitCode, null);
  assert.equal(snapshot.runs.first[1].signal, "<missing>");
  assert.equal(snapshot.runs.first[0].signal.length, 96);
  assert.equal(snapshot.runs.first[0].error, "<non-scalar>");
  assert.equal(snapshot.events.first.length, 4);
  assert.equal(snapshot.events.first[0].errorCode.length, 96);
  assert.deepEqual(
    snapshot.loggedErrorCodes,
    Array.from({ length: 8 }, (_, i) => `code-${i + 12}`),
  );
  assert.doesNotMatch(message, /secret/);
  assert.ok(message.length < 5000);
});

test("startup diagnostics isolate unreadable sections without masking absent records", () => {
  const diagnostic = startupDiagnostics(logger);
  const store: Pick<Store, "get" | "list"> = {
    get() {
      throw new Error("private read failure");
    },
    list: <T>(namespace: string) => {
      if (namespace === "verification_runs") throw undefined;
      return [] as T[];
    },
  };
  const message = diagnostic.message(store, "task");
  const snapshot = JSON.parse(message.slice(message.indexOf("{")));
  assert.equal(snapshot.task, "<unreadable>");
  assert.equal(snapshot.runs, "<unreadable>");
  assert.deepEqual(snapshot.events, { total: 0, first: [] });
  assert.doesNotMatch(message, /private read failure/);
});

async function verificationFixture(long = false) {
  const h = await fixture(3, "development");
  const marker = join(h.directory, "verification-started");
  const release = join(h.directory, "verification-release");
  const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, process.cwd()); ${
    long
      ? `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0); } }, 10);`
      : ""
  }`;
  // The short fixture writes its marker with POSIX shell builtins rather than starting an
  // unrelated Node interpreter: `cd -P .` reports the same physical cwd as process.cwd() and
  // `printf` appends no newline, so the existing exact marker assertions stay valid.
  await h.catalog.save({
    ...h.catalog.get("worktree"),
    verify: [
      long
        ? `exec ${shellQuote(process.execPath)} -e ${shellQuote(script)}`
        : `cd -P . && printf '%s' "$PWD" > ${shellQuote(marker)}`,
    ],
    verifyTimeoutMs: 5000,
  });
  await h.service.reconcile(h.task.id);
  const ready = h.service.get(actor, h.task.id);
  const diagnostics = startupDiagnostics(h.options.logger, (rows) =>
    selectVerificationLogTails(h.directory, h.task.id, rows),
  );
  const worker = new TaskOrchestrator({ ...h.options, logger: diagnostics.logger });
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
  return { ...h, ready, worker, internals, marker, release, runs, diagnostics };
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
      const started = existsSync(h.marker);
      assert.equal(
        started,
        true,
        `configured child is executing before workspace changes${
          started ? "" : h.diagnostics.message(h.store, h.task.id)
        }`,
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

test("verification log tails bound bytes and escaped suffixes without claiming completeness", async () => {
  const h = await logTailFixture();
  try {
    assert.equal(h.read()?.stdout.bytes, 21);
    assert.equal(h.read()?.stdout.rendered, "log-head\\nTAIL-MARKER\\n");
    assert.equal(h.read()?.stderr.status, "empty");
    writeFileSync(h.stdoutPath, `HEAD${"x".repeat(508)}TAIL`);
    const tail = h.read()?.stdout;
    assert.equal(tail?.bytes, 512);
    assert.equal(tail?.truncated, true);
    assert.equal(tail?.rendered, `${"x".repeat(508)}TAIL`);
    writeFileSync(h.stdoutPath, Buffer.alloc(2048, 0xff));
    const escaped = h.read()?.stdout;
    assert.equal(escaped?.bytes, 512);
    assert.equal(escaped?.renderTruncated, true);
    assert.equal(escaped?.rendered, "\\xff".repeat(128));
    assert.ok(JSON.stringify(escaped).length < 1200);
    await h.remove(h.stdoutPath);
    assert.equal(h.read()?.stdout.status, "missing");
  } finally {
    await h.close();
  }
});

test("verification log tails refuse ineligible rows and static filesystem escapes", async () => {
  const h = await logTailFixture();
  try {
    for (const row of [
      null,
      undefined,
      [],
      { ...h.row, taskId: "other" },
      { ...h.row, id: "../escape" },
      { ...h.row, id: "A".repeat(64) },
      { ...h.row, exitConfirmed: false },
      { ...h.row, status: "running" },
    ])
      assert.equal(verificationLogTails(h.stateDir, h.taskId, row), undefined);
    let idReads = 0;
    const changing = {
      ...h.row,
      get id() {
        return ++idReads <= 2 ? h.row.id : "../../../../outside";
      },
    };
    const captured = verificationLogTails(h.stateDir, h.taskId, changing);
    assert.equal(idReads, 1, "validate and use the same captured id");
    assert.equal(captured?.stdout.bytes, 21);
    const secret = join(h.root, "secret.log");
    writeFileSync(secret, "SECRET-OUTSIDE");
    const mismatch = verificationLogTails(h.stateDir, h.taskId, { ...h.row, stdoutPath: secret });
    assert.equal(mismatch?.stdout.reason, "path_mismatch");
    await h.remove(h.stdoutPath);
    await symlink(secret, h.stdoutPath);
    assert.equal(h.read()?.stdout.reason, "symlink");
    assert.doesNotMatch(JSON.stringify(h.read()), /SECRET-OUTSIDE/);
    await h.remove(h.stdoutPath);
    await link(secret, h.stdoutPath);
    assert.equal(h.read()?.stdout.reason, "hardlink");
    await h.remove(h.stdoutPath);
    mkdirSync(h.stdoutPath);
    assert.equal(h.read()?.stdout.reason, "nonregular");
    const verification = dirname(h.directory);
    await h.remove(verification);
    await symlink(h.root, verification);
    assert.equal(h.read()?.stdout.reason, "ancestor_symlink");
    assert.equal(logTailFlags("win32"), undefined);
  } finally {
    await h.close();
  }
});

test("verification log tails isolate IO faults validate identity and always attempt close", async () => {
  const h = await logTailFixture();
  try {
    writeFileSync(h.stderrPath, "stderr-survives");
    for (const mode of [
      "getter",
      "fstat",
      "read",
      "inode",
      "count",
      "short",
      "open",
      "close",
    ] as const) {
      let opened = 0,
        closed = 0,
        reads = 0;
      const counts = new Map<number, number>();
      const io: typeof defaultLogTailIo = {
        ...defaultLogTailIo,
        lstat(path) {
          if (mode === "getter" && path === h.stdoutPath)
            throw Object.defineProperty({}, "code", {
              get() {
                throw undefined;
              },
            });
          return defaultLogTailIo.lstat(path);
        },
        open(path, flags, permissions) {
          assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          if (mode === "open") throw 0;
          const fd = defaultLogTailIo.open(path, flags, permissions);
          opened++;
          counts.set(fd, 0);
          return fd;
        },
        fstat(fd) {
          if (mode === "fstat") throw false;
          const stat = defaultLogTailIo.fstat(fd);
          if (mode === "inode") stat.ino += 1;
          return stat;
        },
        read(fd, buffer, offset, length, position) {
          reads++;
          if (mode === "read") throw undefined;
          if (mode === "count") return NaN;
          if (mode === "short" && counts.get(fd)) return 0;
          counts.set(fd, 1);
          return defaultLogTailIo.read(
            fd,
            buffer,
            offset,
            mode === "short" ? Math.min(2, length) : length,
            position,
          );
        },
        close(fd) {
          closed++;
          defaultLogTailIo.close(fd);
          if (mode === "close") throw null;
        },
      };
      const result = h.read(io);
      assert.ok(result);
      assert.equal(closed, opened, mode);
      if (mode === "inode") {
        assert.equal(result.stdout.status, "rejected");
        assert.equal(reads, 0);
      } else if (mode === "short") {
        assert.equal(result.stdout.bytes, 2);
        assert.equal(result.stdout.rendered, "lo");
        assert.equal(result.stdout.truncated, true);
      } else if (mode === "close") assert.equal(result.stderr.rendered, "stderr-survives");
      else assert.equal(result.stdout.status, "unreadable", mode);
      if (mode === "getter") assert.equal(result.stderr.rendered, "stderr-survives");
      if (mode === "count") {
        assert.equal(result.stdout.bytes, 0);
        assert.equal(result.stdout.rendered, "");
      }
      assert.equal(opened, mode === "open" ? 0 : mode === "getter" ? 1 : 2);
    }
  } finally {
    await h.close();
  }
});

test("verification log tails read one displayed run only when formatting failure diagnostics", async () => {
  const h = await logTailFixture();
  try {
    let opened = 0,
      listed = 0,
      called = 0;
    const io = {
      ...defaultLogTailIo,
      open(...args: Parameters<typeof defaultLogTailIo.open>) {
        opened++;
        return defaultLogTailIo.open(...args);
      },
    };
    const throwing = Object.defineProperty({}, "taskId", {
      get() {
        throw false;
      },
    });
    const rows = [undefined, { ...h.row, taskId: "other" }, throwing, h.row, h.row, null, h.row];
    const store: Pick<Store, "get" | "list"> = {
      get: <T>() => ({ worktreeReady: true, status: "review" }) as T,
      list: <T>(namespace: string) => {
        if (namespace !== "verification_runs") return [];
        listed++;
        return rows as T[];
      },
    };
    const diagnostics = startupDiagnostics(logger, (shown) => {
      called++;
      assert.equal(shown.length, 6);
      return selectVerificationLogTails(h.stateDir, h.taskId, shown, io);
    });
    diagnostics.logger.info("no log reads during normal logging");
    assert.equal(called, 0);
    assert.equal(opened, 0);
    const message = diagnostics.message(store, h.taskId);
    const snapshot = JSON.parse(message.slice(message.indexOf("{")));
    assert.equal(called, 1);
    assert.equal(listed, 1);
    assert.equal(opened, 2);
    assert.equal(snapshot.logTails.rowIndex, 3);
    assert.equal(snapshot.runs.total, 7);
    assert.equal(snapshot.logTails.stdout.bytes, 21);
    assert.equal(message.includes(h.root), false);
    assert.equal(
      selectVerificationLogTails(h.stateDir, h.taskId, [...Array(6), h.row], io),
      undefined,
    );
    assert.equal(opened, 2);
    const failed = startupDiagnostics(logger, () => {
      throw new Error("private reader failure");
    });
    const failure = failed.message(store, h.taskId);
    const partial = JSON.parse(failure.slice(failure.indexOf("{")));
    assert.equal(partial.logTails, "<unreadable>");
    assert.equal(partial.task.worktreeReady, true);
    assert.equal(partial.runs.first.length, 6);
    assert.doesNotMatch(failure, /private reader failure/);
  } finally {
    await h.close();
  }
});
