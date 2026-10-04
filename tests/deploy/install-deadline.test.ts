import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Regression for a late-observation defect in deploy/install.sh: wait_for_bridge
// tests the 30s deadline only at the top of each loop iteration, so one probe
// that consumes its whole remaining budget plus eight field extractions can
// accept stable evidence observed after the deadline. These tests execute only
// the SOURCE FUNCTION extracted from install.sh inside an isolated Bash harness;
// they never source, run, or modify install.sh, and never touch the real CLI.
// This is a fake-clock unit control, not a reproduction of any full installer
// failure, and install.sh still has no total-walltime bound.
//
// Clock seam: every word-boundary SECONDS read in the extracted function is
// rewritten to TEST_CLOCK, because the real Bash SECONDS advances with
// scheduling and would make the before-deadline case flaky. The test asserts
// that production contains a SECONDS read and that none survives the rewrite,
// so the harness fails closed if the clock usage changes shape.

const ACCEPT_MARKER = "ACCEPT myrix is running with a stable process and the selected state lock";

// Only external-looking helpers are mocked, and the mocks perform no filesystem
// writes or deletions: mktemp returns a constant path, rm only counts its call,
// sleep is a no-op, probe_field reports one fixed consistent identity, and
// bridge_probe counts its calls without consuming any probe budget.
const MOCKS = String.raw`
DOMAIN=gui/123
LABEL_BRIDGE=com.hewenyu.myrix
STATE_DIR=/unit-state
bridge_bin=/unit-bin
TEST_CLOCK=0
calls=0
rm_calls=0
clock_fired=0
mktemp() { printf '%s\n' /unit-probe; }
rm() { rm_calls=$((rm_calls + 1)); }
sleep() { :; }
ok() { printf 'ACCEPT %s\n' "$*"; }
probe_field() {
  case "$2" in
    state) printf '%s\n' locked ;;
    stateDir) printf '%s\n' /unit-state ;;
    pid|process.pid) printf '%s\n' 1001 ;;
    launchd.target) printf '%s\n' gui/123/com.hewenyu.myrix ;;
    launchd.matched) printf '%s\n' true ;;
    launchd.pid) printf '%s\n' 1000 ;;
    launchd.executable) printf '%s\n' /unit-bin ;;
    *) return 1 ;;
  esac
}
bridge_probe() { calls=$((calls + 1)); return 0; }
`;

// The DEBUG hook advances TEST_CLOCK opportunistically exactly once, on the
// third successful probe, at the identity comparison that runs after all eight
// field extractions and before both the deadline recheck and the stable-count
// update. Advancing here, never inside the probe, keeps the probe within its own
// passed budget while still dating the observation after the deadline.
const ADVANCE_CLOCK = [
  `if [ "$BASH_COMMAND" = '[ "$state" = "locked" ]' ]`,
  ` && [ "$calls" -eq 3 ] && [ "$clock_fired" -eq 0 ]; then`,
  ` clock_fired=1;`,
  ` TEST_CLOCK=$((deadline + OVERRUN));`,
  String.raw` printf 'CLOCK clock=%s calls=%s\n' "$TEST_CLOCK" "$calls" >&2;`,
  ` trap - DEBUG;`,
  ` fi`,
].join("");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Fail closed: the harness is only valid if install.sh defines exactly one
// wait_for_bridge, and the extracted text is the real production function.
function readWaitForBridge(): string {
  const source = readFileSync(new URL("../../deploy/install.sh", import.meta.url), "utf8");
  const matches = [...source.matchAll(/^wait_for_bridge\(\) \{\n[\s\S]*?^\}/gm)];
  assert.equal(matches.length, 1, "expected exactly one wait_for_bridge definition");
  const match = matches[0];
  assert.ok(match, "wait_for_bridge body not found");
  const body = match[0];
  assert.ok(body, "wait_for_bridge body is empty");
  assert.match(body, /\bSECONDS\b/, "production must read the shell SECONDS clock");
  assert.match(body, /stable process and the selected state lock/);
  return body;
}

const WAIT_FOR_BRIDGE = readWaitForBridge();
const ISOLATED_WAIT_FOR_BRIDGE = WAIT_FOR_BRIDGE.replace(/\bSECONDS\b/g, "TEST_CLOCK");
assert.doesNotMatch(ISOLATED_WAIT_FOR_BRIDGE, /\bSECONDS\b/, "clock seam missed a SECONDS read");

// Bash can classify socket-fed non-interactive -c invocations as remote shells
// and read ~/.bashrc even with a scrubbed environment. Private HOME controls
// reproduce this startup path without inspecting a runner's actual rc files.
// --norc blocks that read; --noprofile also protects against login profiles.
// These flags do NOT suppress BASH_ENV, so the scrubbed environment remains
// necessary. Keep the default stdin shape, exact output checks and 3s cap.
const ISOLATED_BASH_ARGV = ["--noprofile", "--norc"] as const;

// Does bash read an ambient startup file for this exact spawn shape? The
// fixture HOME is private to this test and contains only a marker that prints to
// stderr, so the probe never executes the real user's rc files.
function ambientStartupLeaks(flags: readonly string[], home: string, marker: string): boolean {
  const result = spawnSync("/bin/bash", [...flags, "-c", ":"], {
    env: { PATH: "/usr/bin:/bin", HOME: home },
    encoding: "utf8",
    timeout: 3_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined, diagnostics(result));
  assert.equal(result.signal, null, diagnostics(result));
  assert.equal(result.status, 0, diagnostics(result));
  assert.equal(result.stdout, "", diagnostics(result));
  return result.stderr.includes(marker);
}

function runIsolatedWait(overrun: number, home?: string): SpawnSyncReturns<string> {
  // Keep the extracted Bash source intact while joining the harness blocks.
  const script = [
    MOCKS,
    `OVERRUN=${overrun}`,
    ISOLATED_WAIT_FOR_BRIDGE,
    "set -T",
    `trap ${shellQuote(ADVANCE_CLOCK)} DEBUG`,
    "wait_for_bridge",
    "result=$?",
    String.raw`printf 'DIAG rm=%s clock_fired=%s calls=%s\n' "$rm_calls" "$clock_fired" "$calls"`,
    String.raw`printf 'RESULT=%s\n' "$result"`,
    "",
  ].join("\n");
  return spawnSync("/bin/bash", [...ISOLATED_BASH_ARGV, "-c", script], {
    env: home === undefined ? { PATH: "/usr/bin:/bin" } : { PATH: "/usr/bin:/bin", HOME: home },
    encoding: "utf8",
    timeout: 3_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
  });
}

function diagnostics(result: SpawnSyncReturns<string>): string {
  const error = result.error as NodeJS.ErrnoException | undefined;
  return [
    `status=${String(result.status)}`,
    `signal=${String(result.signal)}`,
    `error=${error ? `${error.name}: ${error.message}` : "none"}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join("\n");
}

const SCENARIOS = [
  { label: "before the deadline (-1s) still accepts", overrun: -1, accepted: true },
  { label: "exactly at the deadline (0s) rejects", overrun: 0, accepted: false },
  { label: "after the deadline (+1s) rejects", overrun: 1, accepted: false },
] as const;

for (const scenario of SCENARIOS)
  test(`wait_for_bridge ${scenario.label}`, () => {
    const result = runIsolatedWait(scenario.overrun);
    assert.equal(result.error, undefined, diagnostics(result));
    assert.equal(result.signal, null, diagnostics(result));
    assert.equal(result.status, 0, diagnostics(result));
    // The isolated clock hook is the only stderr writer, so exactly one line is
    // both the hook-fired-once proof and the expected-stderr contract.
    assert.equal(
      result.stderr,
      `CLOCK clock=${30 + scenario.overrun} calls=3\n`,
      diagnostics(result),
    );
    // Cleanup ran once and no fourth probe or unexpected output occurred.
    const expected =
      (scenario.accepted ? `${ACCEPT_MARKER}\n` : "") +
      `DIAG rm=1 clock_fired=1 calls=3\nRESULT=${scenario.accepted ? 0 : 1}\n`;
    assert.equal(result.stdout, expected, diagnostics(result));
  });

// Retained controls for the startup isolation above. The fixture HOME is
// test-owned and private: it holds only a marker that prints one line to stderr,
// so no real user rc file is ever executed by these tests.
const AMBIENT_MARKER = "POISON_AMBIENT_STARTUP_FILE";

function withPoisonedHome(marker: string): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-deadline-startup-")));
  for (const name of [".bashrc", ".bash_profile", ".profile", ".bash_login"])
    writeFileSync(join(home, name), `printf '${marker} from ${name}\\n' >&2\n`);
  return home;
}

test("the spawn shape reads ambient startup files, so the isolation flags are load-bearing", () => {
  // Negative control. It proves the threat is real for THIS spawn shape: with
  // the exact stdio/env shape used by the deadline harness but WITHOUT the
  // isolation flags, bash sources the fixture ~/.bashrc. If Node/bash ever stop
  // reading ambient startup files here, the positive assertion below would be
  // vacuous, so this control has to keep leaking and the marker must be the
  // fixture's own.
  const home = withPoisonedHome(AMBIENT_MARKER);
  try {
    assert.equal(
      ambientStartupLeaks([], home, AMBIENT_MARKER),
      true,
      "expected the unisolated spawn shape to read the fixture startup file",
    );
    // --noprofile alone is NOT sufficient: the remote-shell rc read ignores it.
    // This keeps the positive regression honest about which flag does the work.
    assert.equal(
      ambientStartupLeaks(["--noprofile"], home, AMBIENT_MARKER),
      true,
      "--noprofile alone must not be mistaken for rc isolation",
    );
    // And the exact isolation flags the harness uses do suppress the read, so
    // removing them is what makes the positive regression fail.
    assert.equal(
      ambientStartupLeaks(ISOLATED_BASH_ARGV, home, AMBIENT_MARKER),
      false,
      "the isolation flags must stop the ambient startup read",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the isolated deadline harness ignores ambient startup files even with a poisoned HOME", () => {
  // Positive regression: the real extracted harness, spawned by the shared
  // helper, must not read the poisoned fixture HOME's startup files. This fails
  // if only the --noprofile/--norc isolation protection is removed
  // (runIsolatedWait would then print the marker before the CLOCK line), and
  // not by a generic import or timeout failure.
  const home = withPoisonedHome(AMBIENT_MARKER);
  try {
    const result = runIsolatedWait(-1, home);
    assert.equal(result.error, undefined, diagnostics(result));
    assert.equal(result.signal, null, diagnostics(result));
    assert.equal(result.status, 0, diagnostics(result));
    assert.doesNotMatch(result.stderr, new RegExp(AMBIENT_MARKER), diagnostics(result));
    assert.equal(result.stderr, "CLOCK clock=29 calls=3\n", diagnostics(result));
    assert.equal(
      result.stdout,
      `${ACCEPT_MARKER}\nDIAG rm=1 clock_fired=1 calls=3\nRESULT=0\n`,
      diagnostics(result),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
