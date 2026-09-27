import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Project, Task } from "../../src/core/types.js";
import { type VerificationRun, VerificationRunner } from "../../src/orchestration/verify.js";
import { ProjectCatalog } from "../../src/projects/catalog.js";
import { Store } from "../../src/storage/store.js";

async function fixture(t: TestContext, verify?: string[], verifyTimeoutMs = 10_000) {
  const stateDir = await mkdtemp(join(tmpdir(), "myrix-verifier-"));
  const cwd = join(stateDir, "repository");
  await mkdir(cwd);
  const store = new Store(join(stateDir, "state.db"));
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const project: Project = {
    name: "fixture",
    agent: "codex",
    directories: [cwd],
    verify,
    verifyTimeoutMs,
  };
  const projects = new ProjectCatalog(store, {
    projects: [project],
    defaultProject: project.name,
    bypass: false,
  });
  const options = { store, stateDir, projects };
  const runner = new VerificationRunner(options);
  const task: Task = {
    id: "task-fixture",
    ownerId: "owner",
    sessionId: "session",
    entryChatId: "entry",
    project: project.name,
    kind: "development",
    title: "fixture",
    requirements: "fixture",
    directories: [cwd],
    directoryMode: "shared",
    bypass: false,
    status: "running",
    participantIds: [],
    groupDeleted: false,
    keepGroup: true,
    createGroup: false,
    createRemoteTask: false,
    worktreeReady: false,
    discussion: { mode: "manual", rounds: 0, nextParticipant: 0, paused: false },
    result: "",
    closeRequested: false,
    createdAt: "2026-09-27",
    updatedAt: "2026-09-27",
  };
  return { ...options, cwd, project, runner, task };
}

function candidateFor(runner: VerificationRunner, task: Task, revision: string) {
  const candidate = runner.candidates(task, revision)[0];
  assert.ok(candidate);
  return candidate;
}

test("only configured commands run; cwd, stdout, stderr and nonzero exit are persisted", async (t) => {
  const h = await fixture(t, ["pwd; printf 'out'; printf 'err' >&2; exit 7"]);
  const candidate = candidateFor(h.runner, h.task, "artifact-one");
  const result = await h.runner.run(h.task, candidate);
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 7);
  assert.equal(result.exitConfirmed, true);
  assert.equal(await readFile(result.stdoutPath, "utf8"), `${await realpath(h.cwd)}\nout`);
  assert.equal(await readFile(result.stderrPath, "utf8"), "err");
  assert.equal(result.artifactRevision, "artifact-one");
  assert.ok(result.stdoutPath.startsWith(join(h.stateDir, "tasks", h.task.id)));
  assert.deepEqual(await h.runner.run(h.task, candidate), result);
  await assert.rejects(h.runner.run(h.task, { ...candidate, commandIndex: 99 }), {
    code: "verify_command",
  });
  const project = { ...h.project, verify: ["printf 'changed'"] };
  h.store.set("catalog", "current", { ...h.projects.snapshot(), projects: [project] });
  await assert.rejects(h.runner.run(h.task, { ...candidate, artifactRevision: "artifact-two" }), {
    code: "verify_config_changed",
  });
});

test("missing and empty verification never infer commands; worktree cwd is task-owned", async (t) => {
  for (const verify of [undefined, []]) {
    const h = await fixture(t, verify);
    assert.deepEqual(h.runner.candidates(h.task, "artifact"), []);
    assert.deepEqual(h.runner.list(), []);
  }
  const h = await fixture(t, ["pwd"]);
  const worktree = join(h.stateDir, "worktree");
  await mkdir(worktree);
  h.task.directories = [worktree];
  h.task.sourceDirectories = [h.cwd];
  h.task.directoryMode = "worktree";
  h.task.worktreeReady = true;
  const result = await h.runner.run(h.task, candidateFor(h.runner, h.task, "artifact"));
  assert.equal(result.status, "passed");
  assert.equal((await readFile(result.stdoutPath, "utf8")).trim(), await realpath(worktree));
});

test("timeout and cancellation terminate the process group before releasing its directory", async (t) => {
  const command = `exec '${process.execPath.replaceAll("'", "'\\''")}' -e 'setInterval(() => {}, 1000)'`;
  const h = await fixture(t, [command], 100);
  const result = await h.runner.run(h.task, candidateFor(h.runner, h.task, "first"));
  assert.equal(result.status, "timed_out");
  assert.equal(result.exitConfirmed, true);
  assert.equal(result.signal, "SIGTERM");
  assert.deepEqual(h.runner.blockingDirectories(), []);
  const second = await fixture(t, [command]);
  const running = second.runner.run(
    second.task,
    candidateFor(second.runner, second.task, "second"),
  );
  for (
    let attempt = 0;
    attempt < 1000 && !second.runner.list().some((run) => run.status === "running");
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 2));
  const cancelled = await second.runner.cancel(second.task.id);
  assert.equal(cancelled[0]?.status, "cancelled");
  assert.equal((await running).exitConfirmed, true);
});

test("canonical directory conflicts, restart uncertainty and repeated candidates never rerun", async (t) => {
  const h = await fixture(t, ["sleep 0.2; printf x >> runs"]);
  const candidate = candidateFor(h.runner, h.task, "artifact");
  const running = h.runner.run(h.task, candidate);
  assert.equal(
    h.runner.list()[0]?.status,
    "prepared",
    "directory reservation precedes the first async gap",
  );
  assert.equal(h.runner.blockingDirectories().length, 1);
  const repeated = h.runner.run(h.task, candidate);
  assert.equal(running, repeated);
  for (
    let attempt = 0;
    attempt < 100 && !h.runner.list().some((run) => run.status === "running");
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 2));
  const sameProcess = new VerificationRunner(h);
  assert.equal(sameProcess.list()[0]?.status, "running");
  const alias = join(h.stateDir, "alias");
  await symlink(h.cwd, alias);
  const otherTask = { ...h.task, id: "task-other", directories: [alias] };
  await assert.rejects(sameProcess.run(otherTask, candidate), { code: "verify_directory_busy" });
  const result = await running;
  assert.equal(result.status, "passed");
  assert.equal(await readFile(join(h.cwd, "runs"), "utf8"), "x");
  h.store.set("verification_runs", result.id, {
    ...result,
    status: "running",
    exitConfirmed: false,
  });
  const restarted = new VerificationRunner(h);
  const recovered = await restarted.run(h.task, candidate);
  assert.equal(recovered.status, "unknown");
  assert.deepEqual(restarted.blockingDirectories(), [await realpath(h.cwd)]);
  await writeFile(join(h.cwd, "runs"), "unchanged");
  await restarted.run(h.task, candidate);
  await assert.rejects(restarted.run(otherTask, { ...candidate, artifactRevision: "new" }), {
    code: "verify_directory_busy",
  });
  assert.equal(await readFile(join(h.cwd, "runs"), "utf8"), "unchanged");
});

test("cancellation kills stubborn descendants and never labels an early shell exit as passed", async (t) => {
  const command = `exec '${process.execPath.replaceAll("'", "'\\''")}' parent.cjs`;
  const h = await fixture(t, [command], 15_000);
  await writeFile(
    join(h.cwd, "child.cjs"),
    `const fs = require('node:fs');
process.on('SIGTERM', () => {});
setInterval(() => fs.appendFileSync('pulse', '.'), 10);
`,
  );
  await writeFile(
    join(h.cwd, "parent.cjs"),
    `require('node:child_process').spawn(process.execPath, ['child.cjs'], {stdio:'ignore'});
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
  );
  const running = h.runner.run(h.task, candidateFor(h.runner, h.task, "descendants"));
  try {
    for (let attempt = 0; attempt < 2000; attempt++) {
      if (await readFile(join(h.cwd, "pulse"), "utf8").catch(() => "")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await h.runner.cancel(h.task.id);
    const result = await running;
    assert.ok(["cancelled", "unknown"].includes(result.status));
    const output = await readFile(join(h.cwd, "pulse"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await readFile(join(h.cwd, "pulse"), "utf8"), output);
    if (result.status === "unknown") assert.equal(h.runner.blockingDirectories().length, 1);
  } finally {
    await h.runner.cancel(h.task.id);
  }
  const early = await fixture(t, ["sleep 5 & exit 0"]);
  const result = await early.runner.run(
    early.task,
    candidateFor(early.runner, early.task, "early"),
  );
  assert.notEqual(result.status, "passed");
  assert.ok(["failed", "unknown"].includes(result.status));
});

test("safe cancellation creates a new selected run while replay preserves every old identity", async (t) => {
  const h = await fixture(t, ["printf resumed"]);
  const first = candidateFor(h.runner, h.task, "unchanged");
  const cancelled = await h.runner.run(h.task, first, AbortSignal.abort());
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.exitConfirmed, true, "no process was started");
  const second = candidateFor(h.runner, h.task, "unchanged");
  assert.equal(second.retryOf, cancelled.id);
  const again = await h.runner.run(h.task, second, AbortSignal.abort());
  assert.equal(again.status, "cancelled");
  assert.notEqual(again.id, cancelled.id);
  assert.notEqual(again.stdoutPath, cancelled.stdoutPath);
  const restarted = new VerificationRunner(h);
  const third = candidateFor(restarted, h.task, "unchanged");
  assert.equal(third.retryOf, again.id);
  const pending = restarted.run(h.task, third);
  assert.equal(restarted.run(h.task, third), pending, "same selection shares one process");
  const passed = await pending;
  assert.equal(passed.status, "passed");
  assert.equal(await readFile(passed.stdoutPath, "utf8"), "resumed");
  assert.equal(await readFile(cancelled.stdoutPath, "utf8"), "");
  assert.equal(await readFile(again.stdoutPath, "utf8"), "");
  assert.deepEqual(await restarted.run(h.task, first), cancelled);
  assert.deepEqual(await restarted.run(h.task, second), again);
  const recovered = new VerificationRunner(h);
  assert.deepEqual(candidateFor(recovered, h.task, "unchanged"), third);
  assert.deepEqual(await recovered.run(h.task, third), passed);
  assert.equal(recovered.list().length, 3);
});

test("retry selection cannot bypass a terminal or unconfirmed verification outcome", async (t) => {
  const h = await fixture(t, ["printf never-replayed"]);
  const first = candidateFor(h.runner, h.task, "unchanged");
  const cancelled = await h.runner.run(h.task, first, AbortSignal.abort());
  const second = candidateFor(h.runner, h.task, "unchanged");
  const passed = await h.runner.run(h.task, second);
  const terminal: VerificationRun["status"][] = [
    "failed",
    "timed_out",
    "cancelled",
    "unknown",
    "not_started",
  ];
  for (const status of terminal) {
    const saved = { ...passed, status, exitConfirmed: false };
    h.store.set("verification_runs", passed.id, saved);
    assert.deepEqual(h.runner.candidates(h.task, "unchanged"), [], status);
    assert.deepEqual(await h.runner.run(h.task, second), saved);
    await assert.rejects(h.runner.run(h.task, { ...second, retryOf: passed.id }), {
      code: "verify_retry",
    });
  }
  h.store.set("verification_runs", passed.id, passed);
  await assert.rejects(h.runner.run(h.task, { ...second, artifactRevision: "changed" }), {
    code: "verify_retry",
  });
  await assert.rejects(h.runner.run({ ...h.task, id: "other-task" }, second), {
    code: "verify_retry",
  });
  assert.equal(h.runner.list().length, 2);
  assert.deepEqual(await h.runner.run(h.task, first), cancelled);
});
