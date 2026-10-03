import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Project, Task } from "../../src/core/types.js";
import { type VerificationRun, VerificationRunner } from "../../src/orchestration/verify.js";
import { ProjectCatalog } from "../../src/projects/catalog.js";
import { Store } from "../../src/storage/store.js";

/**
 * Verification deadlines have conservative precedence:
 * once the configured deadline has fired, a later delivered exit-0 close of the
 * (already terminated) process group must not upgrade the run to `passed`.
 * The same holds when the deadline is already overdue but its timer callback
 * has not run yet, because a stalled event loop can deliver a queued close
 * first; the monotonic deadline is then re-checked when the close is observed.
 *
 * The whole flow is deterministic and never starts a real process or signals a
 * real group: `spawn` is replaced on the CommonJS export object and pushed into
 * the ESM binding with `syncBuiltinESMExports`, while `process.kill` is replaced
 * for the duration of the test so `groupExists`/`killGroup` only ever see this
 * synthetic, negative pid.
 */
const nodeRequire = createRequire(import.meta.url);
// `typeof import(...)` marks exports read-only; this mutable shape is the seam.
const childProcess = nodeRequire("node:child_process") as {
  spawn: typeof import("node:child_process").spawn;
};

const DEADLINE_MS = 500;
// Any positive id works because process.kill is mocked; no real group exists.
const SYNTHETIC_PID = 0x7fff_0000;

async function fixture(t: TestContext, verifyTimeoutMs = DEADLINE_MS) {
  const stateDir = await mkdtemp(join(tmpdir(), "myrix-verify-deadline-"));
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
    verify: ["printf late"],
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

/**
 * Replace the `spawn` binding verify.ts sees with one EventEmitter-shaped child
 * carrying a synthetic pid. `process.kill` is mocked so the synthetic negative
 * pid always reports `ESRCH` (the group never exists); any other pid is
 * rejected too, and because the function itself is replaced no real signal can
 * be sent in either branch.
 */
function installSyntheticChild(onSpawn?: () => void) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  child.pid = SYNTHETIC_PID;
  child.kill = () => true;
  const killCalls: Array<{ pid: number; signal: string | number | undefined }> = [];
  let spawnCalls = 0;
  const realSpawn = childProcess.spawn;
  const realKill = process.kill;
  process.kill = (pid: number, signal?: string | number): true => {
    killCalls.push({ pid, signal });
    const code = pid === -SYNTHETIC_PID ? "ESRCH" : "EINVAL";
    throw Object.assign(new Error("synthetic process group"), { code });
  };
  childProcess.spawn = (() => {
    spawnCalls += 1;
    onSpawn?.();
    return child;
  }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  return {
    child,
    killCalls,
    get spawnCalls() {
      return spawnCalls;
    },
    restore() {
      childProcess.spawn = realSpawn;
      process.kill = realKill;
      syncBuiltinESMExports();
    },
  };
}

/**
 * Invoke `deliver` once, at the moment the run is first persisted as `running`
 * (the close listener is already registered by then). The mocked clock can be
 * advanced first so the deadline fires before the close is queued.
 */
function interceptRunningPersist(store: Store, deliver: () => void): void {
  const write = store.set.bind(store);
  let intercepted = false;
  store.set = ((namespace: string, key: string, value: unknown) => {
    write(namespace, key, value);
    if (intercepted || namespace !== "verification_runs") return;
    if ((value as VerificationRun).status !== "running") return;
    intercepted = true;
    deliver();
  }) as typeof store.set;
}

/**
 * Deterministic stand-in for the monotonic clock the deadline is anchored to.
 * The origin read that anchors the deadline returns 1, and `advance` moves the
 * clock forward without ever running the deadline's timer callback: that is
 * exactly the loop phase this regression pins.
 *
 * The guard fires when the replacement did not take effect, so an ineffective
 * mock can never let the run be classified against the real clock and make the
 * regression pass vacuously.
 */
function installControllableMonotonicClock(t: TestContext): { advance(ms: number): void } {
  const origin = 1;
  let current = origin;
  const monotonic = globalThis.performance;
  t.mock.method(monotonic, "now", () => current);
  if (monotonic.now() !== origin)
    throw new Error(
      "performance.now() mock did not take effect; refusing to grade against a real clock",
    );
  return {
    advance(ms: number) {
      current += ms;
    },
  };
}

// A timer that has already fired outranks a later exit; the deadline is not a
// race the shell can win by exiting after the kill was issued.
test("a late exit-0 close after the fired deadline stays timed_out", async (t) => {
  const h = await fixture(t);
  const synthetic = installSyntheticChild();
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    installControllableMonotonicClock(t);
    interceptRunningPersist(h.store, () => {
      t.mock.timers.tick(DEADLINE_MS + 1);
      queueMicrotask(() => synthetic.child.emit("close", 0, null));
    });
    const result = await h.runner.run(h.task, candidateFor(h.runner, h.task, "late"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.status, "timed_out");
    assert.equal(
      h.store.get<VerificationRun>("verification_runs", result.id)?.status,
      "timed_out",
      "the durable record keeps the conservative outcome",
    );
    const terminated = synthetic.killCalls.some(
      (call) => call.pid === -SYNTHETIC_PID && call.signal === "SIGTERM",
    );
    assert.ok(terminated, "the expired deadline attempted to terminate the synthetic group");
  } finally {
    t.mock.timers.reset();
    synthetic.restore();
  }
});

// Control: without the deadline firing, the same exit-0 close is a pass, so the
// regression above is pinning precedence rather than an always-timeout stub.
test("an exit-0 close before the deadline still passes", async (t) => {
  const h = await fixture(t);
  const synthetic = installSyntheticChild();
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    installControllableMonotonicClock(t);
    interceptRunningPersist(h.store, () => {
      queueMicrotask(() => synthetic.child.emit("close", 0, null));
    });
    const result = await h.runner.run(h.task, candidateFor(h.runner, h.task, "timely"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.status, "passed");
    assert.equal(h.store.get<VerificationRun>("verification_runs", result.id)?.status, "passed");
    // groupExists() probes with signal 0; no termination signal was needed.
    assert.ok(synthetic.killCalls.every((call) => call.signal === 0));
  } finally {
    t.mock.timers.reset();
    synthetic.restore();
  }
});

// The deadline is overdue but its callback never ran because the loop was
// stalled; the queued exit-0 close must not win that loop phase. The pending
// timer is deliberately never ticked, so only the monotonic re-check can
// classify this overrun.
test("an overdue deadline whose timer callback never fired still times the run out", async (t) => {
  const h = await fixture(t);
  const synthetic = installSyntheticChild();
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const clock = installControllableMonotonicClock(t);
    interceptRunningPersist(h.store, () => {
      // Time passes well beyond the 500ms budget while no timer callback runs.
      clock.advance(DEADLINE_MS + 1);
      queueMicrotask(() => synthetic.child.emit("close", 0, null));
    });
    const result = await h.runner.run(h.task, candidateFor(h.runner, h.task, "overdue"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.status, "timed_out");
    assert.equal(
      h.store.get<VerificationRun>("verification_runs", result.id)?.status,
      "timed_out",
      "the durable record keeps the conservative outcome",
    );
    // The synthetic group is already gone and stays gone, so no termination
    // was needed; only signal-0 existence probes may have been issued.
    assert.ok(synthetic.killCalls.length >= 1, "the synthetic group was probed");
    assert.ok(
      synthetic.killCalls.every((call) => call.pid === -SYNTHETIC_PID && call.signal === 0),
      "no termination signal was sent to an already-gone group",
    );
  } finally {
    t.mock.timers.reset();
    synthetic.restore();
  }
});

/** SIGTERM attempts only: signal-0 existence probes are not terminations. */
function termAttempts(synthetic: ReturnType<typeof installSyntheticChild>): number {
  return synthetic.killCalls.filter(
    (call) => call.pid === -SYNTHETIC_PID && call.signal === "SIGTERM",
  ).length;
}

// The timer is never ticked: only the launch-anchored monotonic deadline can
// reject an exit-0 close after synchronous spawn work consumed the budget.
test("a synchronous spawn stall past the budget is timed_out, not passed", async (t) => {
  const h = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = installControllableMonotonicClock(t);
  const synthetic = installSyntheticChild(() => clock.advance(DEADLINE_MS + 1));
  try {
    interceptRunningPersist(h.store, () => {
      queueMicrotask(() => synthetic.child.emit("close", 0, null));
    });
    const result = await h.runner.run(h.task, candidateFor(h.runner, h.task, "spawn-stall"));
    assert.equal(synthetic.spawnCalls, 1);
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.status, "timed_out");
    assert.equal(
      h.store.get<VerificationRun>("verification_runs", result.id)?.status,
      "timed_out",
      "the durable record keeps the conservative outcome",
    );
    assert.ok(synthetic.killCalls.length >= 1, "the synthetic group was probed");
    assert.ok(
      synthetic.killCalls.every((call) => call.pid === -SYNTHETIC_PID && call.signal === 0),
      "no termination signal was sent to an already-gone group",
    );
  } finally {
    t.mock.timers.reset();
    synthetic.restore();
  }
});

// Control: launch work that stays inside the same budget may still pass.
test("a synchronous spawn stall inside the budget still passes", async (t) => {
  const h = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = installControllableMonotonicClock(t);
  const synthetic = installSyntheticChild(() => clock.advance(DEADLINE_MS - 1));
  try {
    interceptRunningPersist(h.store, () => {
      queueMicrotask(() => synthetic.child.emit("close", 0, null));
    });
    const result = await h.runner.run(h.task, candidateFor(h.runner, h.task, "spawn-inside"));
    assert.equal(synthetic.spawnCalls, 1);
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.status, "passed");
    assert.equal(h.store.get<VerificationRun>("verification_runs", result.id)?.status, "passed");
    assert.ok(synthetic.killCalls.every((call) => call.signal === 0));
  } finally {
    t.mock.timers.reset();
    synthetic.restore();
  }
});

// beforeStart runs after log setup but before the final authorization check.
// Its elapsed time is deliberately outside the command's launch budget.
test("preflight time before the spawn attempt is not charged to the command", async (t) => {
  const h = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = installControllableMonotonicClock(t);
  const synthetic = installSyntheticChild();
  try {
    interceptRunningPersist(h.store, () => {
      queueMicrotask(() => synthetic.child.emit("close", 0, null));
    });
    const result = await h.runner.run(
      h.task,
      candidateFor(h.runner, h.task, "preflight"),
      undefined,
      () => clock.advance(DEADLINE_MS + 1),
    );
    assert.equal(synthetic.spawnCalls, 1);
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.status, "passed", "preflight time is not part of the command budget");
    assert.equal(h.store.get<VerificationRun>("verification_runs", result.id)?.status, "passed");
    assert.ok(synthetic.killCalls.length >= 1, "the synthetic group was probed");
    assert.ok(
      synthetic.killCalls.every((call) => call.pid === -SYNTHETIC_PID && call.signal === 0),
      "no termination signal was sent to the synthetic group",
    );
  } finally {
    t.mock.timers.reset();
    synthetic.restore();
  }
});

// 400ms of launch work leaves 100ms. Fractional launch work must not cause
// rounding down to terminate early. TERM checks also reject a fresh 500ms timer
// even when the post-close guard would still reject the eventual exit-0 result.
for (const launchMs of [400, 400.4])
  test(
    launchMs === 400
      ? "only the budget left after synchronous spawn work is scheduled"
      : "fractional launch work cannot trigger termination before the deadline",
    async (t) => {
      const h = await fixture(t);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const clock = installControllableMonotonicClock(t);
      const synthetic = installSyntheticChild(() => clock.advance(launchMs));
      let termsAt99 = -1;
      let termsAtBudget = -1;
      try {
        interceptRunningPersist(h.store, () => {
          clock.advance(99);
          t.mock.timers.tick(99);
          termsAt99 = termAttempts(synthetic);
          clock.advance(1);
          t.mock.timers.tick(1);
          termsAtBudget = termAttempts(synthetic);
          queueMicrotask(() => synthetic.child.emit("close", 0, null));
        });
        const result = await h.runner.run(h.task, candidateFor(h.runner, h.task, "remaining"));
        assert.equal(termsAt99, 0, "99ms is still inside the remaining budget");
        assert.ok(termsAtBudget >= 1, "the remaining budget expired and termination was attempted");
        assert.equal(
          termAttempts(synthetic),
          1,
          "one termination attempt came from the expired budget",
        );
        assert.equal(synthetic.spawnCalls, 1);
        assert.equal(result.exitCode, 0);
        assert.equal(result.exitConfirmed, true);
        assert.equal(result.status, "timed_out");
        assert.equal(
          h.store.get<VerificationRun>("verification_runs", result.id)?.status,
          "timed_out",
          "the durable record keeps the conservative outcome",
        );
      } finally {
        t.mock.timers.reset();
        synthetic.restore();
      }
    },
  );
