import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

function runIsolatedWait(overrun: number): SpawnSyncReturns<string> {
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
  return spawnSync("/bin/bash", ["-c", script], {
    env: { PATH: "/usr/bin:/bin" },
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
