/**
 * Pure unit tests for the long verification startup fixture builder.
 *
 * These tests evaluate the emitted Node program with `node:vm` and stub `require("node:fs")`,
 * `process` and the timer functions. They never spawn a process and never run `/bin/sh`, so they
 * show only that the emitted command and program are shaped as intended: they cannot prove that a
 * shell executes anything, that stderr receives the shell builtin stage, that the marker is
 * created, or that any timed-out run did or did not produce evidence. Whether these breadcrumbs
 * explain the observed startup failure is undetermined; they are observations, not a cause. The
 * existing integration test exercises the real shell and interpreter later.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  buildVerificationStartupFixture,
  nodeStage,
  releasePollMs,
  shellStage,
} from "./verification-startup-fixture.js";

const paths = {
  node: "/usr/bin/node",
  marker: "/work/verification-started",
  release: "/work/release",
};

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/** Reverses the builder's single-quote quoting, so an operand can be compared literally. */
function unquote(quoted: string): string {
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), `operand is not quoted: ${quoted}`);
  return quoted.slice(1, -1).replaceAll("'\\''", "'");
}

/** Splits the command into the shell-stage prefix and the exec line that follows the redirect. */
function splitCommand(command: string): { prefix: string; execLine: string } {
  const parts = command.split(" >&2 || :; exec ");
  assert.equal(parts.length, 2, "exactly one stderr redirect must introduce the exec");
  return { prefix: parts[0] as string, execLine: parts[1] as string };
}

/** Recovers the node path and script operand from a line shaped as `'<node>' -e '<script>'`. */
function execOperands(execLine: string): { node: string; script: string } {
  const match = /^('(?:[^']|'\\'')*') -e ('(?:[^']|'\\'')*')$/.exec(execLine);
  assert.ok(match, `exec line is not two quoted operands: ${execLine}`);
  return { node: unquote(match[1] as string), script: unquote(match[2] as string) };
}

interface Scenario {
  cwd?: string;
  markerFails?: boolean;
  stderrFails?: boolean;
  releasePresent?: (path: string) => boolean;
}

interface Observation {
  events: string[];
  stderr: string[];
  intervals: number[];
  exitCodes: number[];
  timers: Map<number, () => void>;
}

const observation = (): Observation => ({
  events: [],
  stderr: [],
  intervals: [],
  exitCodes: [],
  timers: new Map(),
});

/** Evaluates the emitted program against a fake fs/process/timer surface, recording observations. */
function evaluate(script: string, scenario: Scenario = {}, run = observation()): Observation {
  const cwd = scenario.cwd ?? "/work/child";
  const present = scenario.releasePresent ?? (() => false);
  let nextTimer = 1;
  const fs = {
    writeSync(fd: number, text: string) {
      run.events.push(`writeSync:${fd}`);
      if (scenario.stderrFails) throw new Error("diagnostic write failed");
      if (fd === 2) run.stderr.push(text);
    },
    writeFileSync(path: string, data: string) {
      run.events.push(`marker:${JSON.stringify([path, data])}`);
      if (scenario.markerFails) throw new Error("marker write failed");
    },
    existsSync(path: string) {
      run.events.push(`exists:${JSON.stringify(path)}`);
      return present(path);
    },
  };
  runInNewContext(script, {
    require(name: string) {
      run.events.push(`require:${name}`);
      return fs;
    },
    process: {
      cwd: () => cwd,
      exit(code: number) {
        run.events.push(`exit:${code}`);
        run.exitCodes.push(code);
      },
    },
    setInterval(callback: () => void, ms: number) {
      run.events.push(`setInterval:${ms}`);
      run.intervals.push(ms);
      run.timers.set(nextTimer, callback);
      return nextTimer++;
    },
    clearInterval(id: number) {
      run.events.push(`clearInterval:${id}`);
      run.timers.delete(id);
    },
  });
  return run;
}

/** Returns the marker's [path, data] pair, asserting the program writes exactly one marker. */
function markerBytes(run: Observation): unknown {
  const recorded = run.events.filter((event) => event.startsWith("marker:"));
  assert.equal(recorded.length, 1, "the emitted program must write exactly one marker");
  return JSON.parse((recorded[0] as string).slice("marker:".length));
}

test("the command writes one shell builtin stage to stderr immediately before exec", () => {
  const { command, script } = buildVerificationStartupFixture(paths);
  assert.equal(occurrences(command, "printf"), 1, "one shell-stage breadcrumb only");
  assert.equal(occurrences(command, ">&2"), 1, "the stage is redirected to stderr only");
  assert.equal(occurrences(command, ">&1"), 0, "the stage must never go to stdout");
  assert.equal(command.includes("\n"), false, "the command stays a single shell line");
  const { prefix, execLine } = splitCommand(command);
  assert.equal(prefix, `printf '%s\\n' '${shellStage}'`, "the builtin writes fixed text to stderr");
  assert.equal(prefix.includes("<"), false, "no input redirection may precede the stage");
  assert.deepEqual(execOperands(execLine), { node: paths.node, script });
});

test("command operands survive quoting with spaces, quotes, newlines and metacharacters", () => {
  const weird = {
    node: "/opt/no de'x$\"/bin\node",
    marker: '/work/it\'s a\n"marker"$X',
    release: "/work/re`lease`\\tail\n",
  };
  const built = buildVerificationStartupFixture(weird);
  assert.deepEqual(execOperands(splitCommand(built.command).execLine), {
    node: weird.node,
    script: built.script,
  });
  // Every literal quote carried by either operand must appear escaped, so no quote can end an
  // operand early; the surrounding quoting delimiters themselves are not counted here.
  const literalQuotes = occurrences(weird.node, "'") + occurrences(built.script, "'");
  assert.equal(occurrences(built.command, "'\\''"), literalQuotes, "each quote is escaped");
  assert.equal(built.script.includes(JSON.stringify(weird.marker)), true);
  assert.equal(built.script.includes(JSON.stringify(weird.release)), true);
});

test("the program reports one Node stage after fs loads and before the marker", () => {
  const { script } = buildVerificationStartupFixture(paths);
  const run = evaluate(script, { cwd: "/work/child" });
  assert.deepEqual(run.events, [
    "require:node:fs",
    "writeSync:2",
    `marker:${JSON.stringify([paths.marker, "/work/child"])}`,
    `setInterval:${releasePollMs}`,
  ]);
  assert.deepEqual(run.stderr, [`${nodeStage}\n`], "exactly one bounded Node-stage breadcrumb");
  assert.equal(occurrences(script, nodeStage), 1);
});

test("the marker receives process.cwd() bytes verbatim, without a trailing newline", () => {
  const cases: Array<[string, string]> = [
    ["/plain/marker", "/plain/cwd"],
    ["/work/quote'marker", "/cwd/with space"],
    ["/work/line\nbreak", "/cwd/line\nbreak"],
    ["/工作/标记", "/工作/目录"],
    ['/work/"double" $VAR `cmd` \\slash', "/cwd/换行\n$HOME`id`"],
  ];
  for (const [marker, cwd] of cases) {
    const { script } = buildVerificationStartupFixture({ ...paths, marker });
    const run = evaluate(script, { cwd });
    assert.deepEqual(markerBytes(run), [marker, cwd]);
    assert.equal(cwd.endsWith("\n"), false, "the cwd fixture itself carries no trailing newline");
    assert.deepEqual(run.stderr, [`${nodeStage}\n`]);
  }
});

test("the poll keeps a fixed 10ms delay and repeated misses stay silent", () => {
  const { script } = buildVerificationStartupFixture(paths);
  const run = evaluate(script, { releasePresent: () => false });
  assert.deepEqual(run.intervals, [10]);
  assert.equal(releasePollMs, 10);
  const poll = run.timers.get(1);
  assert.ok(poll);
  for (let attempt = 0; attempt < 3; attempt++) poll();
  assert.deepEqual(run.exitCodes, [], "an absent release never exits");
  assert.equal(run.timers.size, 1, "the same timer keeps polling");
  assert.equal(run.events.filter((event) => event.startsWith("writeSync")).length, 1);
  assert.deepEqual(run.stderr, [`${nodeStage}\n`], "polling logs nothing per attempt");
});

test("a present release clears the same timer then exits zero once", () => {
  const { script } = buildVerificationStartupFixture(paths);
  const run = evaluate(script, { releasePresent: (path) => path === paths.release });
  const poll = run.timers.get(1);
  assert.ok(poll);
  poll();
  assert.deepEqual(run.events.slice(-2), ["clearInterval:1", "exit:0"]);
  assert.deepEqual(run.exitCodes, [0]);
  assert.equal(run.timers.size, 0, "the registered timer itself is cleared");
  assert.deepEqual(run.stderr, [`${nodeStage}\n`]);
  assert.deepEqual(
    run.events.filter((event) => event.startsWith("exists:")),
    [`exists:${JSON.stringify(paths.release)}`],
  );
});

test("a failing marker write leaves the Node stage observed and registers no poll", () => {
  const { script } = buildVerificationStartupFixture(paths);
  const run = observation();
  assert.throws(
    () => evaluate(script, { markerFails: true }, run),
    (error: unknown) => (error as Error).message === "marker write failed",
  );
  assert.deepEqual(run.events, [
    "require:node:fs",
    "writeSync:2",
    `marker:${JSON.stringify([paths.marker, "/work/child"])}`,
  ]);
  assert.deepEqual(run.stderr, [`${nodeStage}\n`], "the Node stage precedes the marker failure");
  assert.deepEqual(run.intervals, [], "no poll is registered after a marker failure");
  assert.equal(run.timers.size, 0);
});

test("a failed diagnostic write preserves the marker, poll and genuine marker failures", () => {
  const { script } = buildVerificationStartupFixture(paths);
  const run = evaluate(script, {
    stderrFails: true,
    releasePresent: (path) => path === paths.release,
  });
  assert.deepEqual(run.stderr, []);
  assert.deepEqual(markerBytes(run), [paths.marker, "/work/child"]);
  assert.deepEqual(run.intervals, [10]);
  const poll = run.timers.get(1);
  assert.ok(poll);
  poll();
  assert.deepEqual(run.events.slice(-2), ["clearInterval:1", "exit:0"]);
  assert.equal(run.timers.size, 0);
  assert.deepEqual(run.exitCodes, [0]);

  const failed = observation();
  assert.throws(
    () => evaluate(script, { stderrFails: true, markerFails: true }, failed),
    /marker write failed/,
  );
  assert.deepEqual(failed.intervals, []);
});

test("building the fixture is deterministic and spawns nothing", () => {
  const first = buildVerificationStartupFixture(paths);
  const second = buildVerificationStartupFixture(paths);
  assert.deepEqual(first, second);
  assert.equal(typeof first.command, "string");
  assert.equal(typeof second.script, "string");
});
