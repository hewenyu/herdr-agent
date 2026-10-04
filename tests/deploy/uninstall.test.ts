import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Every run below is fully mocked: launchctl, uname and sleep are scripts in the
// copied fixture and HOME points at a temporary directory, so nothing here reads
// or changes real launchd state. The budget stays at the install suite's failure
// allowance because no scenario starts a real process; the stuck cases prove the
// bootout wait did not grow past unload_job's 5s bound by counting sleep calls.
const UNINSTALL_TIMEOUT_MS = 10_000;
// unload_job's bound is `i > 50`: at most 50 sleeps and 51 load probes before
// it warns and returns. A stuck label additionally gets exactly one verification
// probe in the uninstall path, so its total stays 52 — proof the wait was not
// widened and that the verification ran once, before any deletion.
const UNLOAD_SLEEP_BOUND = 50;

type LabelState = "absent" | "loaded" | "stuck";
type LegacyState = LabelState | "installed";

type Scenario = {
  bridge?: LabelState;
  legacy?: LegacyState;
  server?: LabelState;
  stateName?: string;
};

// A stuck label ignores bootout but stays loaded; every other label disappears
// from `print` once booted out, which is what unload_job polls for.
const launchctlMock = `#!/bin/sh
printf '%s\\n' "$*" >> "$MYRIX_TEST_LAUNCH_LOG"
root=$(dirname "$MYRIX_TEST_LAUNCH_LOG")
case "$1" in
  print)
    case "$2" in
      */com.hewenyu.myrix) if [ -f "$root/bridge-loaded" ]; then exit 0; else exit 1; fi ;;
      */com.hewenyu.herdr-agent) if [ -f "$root/legacy-loaded" ]; then exit 0; else exit 1; fi ;;
      */com.hewenyu.herdr-server) if [ -f "$root/server-loaded" ]; then exit 0; else exit 1; fi ;;
      *) exit 1 ;;
    esac ;;
  print-disabled) printf '{}\\n' ;;
  bootout)
    case "$2" in
      */com.hewenyu.myrix) if [ ! -f "$root/bridge-stuck" ]; then rm -f "$root/bridge-loaded"; fi ;;
      */com.hewenyu.herdr-agent) if [ ! -f "$root/legacy-stuck" ]; then rm -f "$root/legacy-loaded"; fi ;;
      */com.hewenyu.herdr-server) if [ ! -f "$root/server-stuck" ]; then rm -f "$root/server-loaded"; fi ;;
    esac ;;
  disable) : ;;
esac
exit 0
`;

// A no-op sleep that records its calls, so a widened bootout wait is visible.
const sleepMock = `root=$(dirname "$MYRIX_TEST_LAUNCH_LOG")
printf '%s\\n' "$*" >> "$root/sleep.log"`;

function fixture(scenario: Scenario = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "myrix-uninstall-test-")));
  cpSync(resolve("deploy"), join(directory, "deploy"), { recursive: true });
  const home = join(directory, "home");
  const tools = join(directory, "mock-tools");
  const agents = join(home, "Library", "LaunchAgents");
  const state = join(home, scenario.stateName ?? ".herdr-agent");
  for (const path of [home, tools, agents, join(state, "log")])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(state, "config.toml"), "uninstall leaves this alone\n");
  for (const [name, body] of Object.entries({
    uname: "echo Darwin",
    launchctl: launchctlMock,
    sleep: sleepMock,
  })) {
    const path = join(tools, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const plists = {
    bridge: join(agents, "com.hewenyu.myrix.plist"),
    legacy: join(agents, "com.hewenyu.herdr-agent.plist"),
    server: join(agents, "com.hewenyu.herdr-server.plist"),
  };
  const configuration = {
    bridge: "canonical bridge configuration",
    legacy: "legacy bridge configuration",
    server: "herdr server configuration",
  };
  const markers = {
    bridgeLoaded: join(directory, "bridge-loaded"),
    bridgeStuck: join(directory, "bridge-stuck"),
    legacyLoaded: join(directory, "legacy-loaded"),
    legacyStuck: join(directory, "legacy-stuck"),
    serverLoaded: join(directory, "server-loaded"),
    serverStuck: join(directory, "server-stuck"),
  };
  const loaded = (label: string | undefined) => label === "loaded" || label === "stuck";
  if (scenario.bridge) writeFileSync(plists.bridge, configuration.bridge);
  if (loaded(scenario.bridge)) writeFileSync(markers.bridgeLoaded, "loaded");
  if (scenario.bridge === "stuck") writeFileSync(markers.bridgeStuck, "stuck");
  if (scenario.legacy) writeFileSync(plists.legacy, configuration.legacy);
  if (loaded(scenario.legacy)) writeFileSync(markers.legacyLoaded, "loaded");
  if (scenario.legacy === "stuck") writeFileSync(markers.legacyStuck, "stuck");
  if (scenario.server) writeFileSync(plists.server, configuration.server);
  if (loaded(scenario.server)) writeFileSync(markers.serverLoaded, "loaded");
  if (scenario.server === "stuck") writeFileSync(markers.serverStuck, "stuck");
  const log = join(directory, "launchctl.log");
  return {
    directory,
    script: join(directory, "deploy", "install.sh"),
    home,
    state,
    agents,
    plists,
    configuration,
    markers,
    log,
    env: {
      ...process.env,
      HOME: home,
      MYRIX_BIN: "",
      HERDR_AGENT_BIN: "",
      HERDR_BIN: "",
      MYRIX_TEST_LAUNCH_LOG: log,
      PATH: [tools, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

function runUninstall(f: Fixture, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("/bin/bash", [f.script, ...args], {
    env: f.env,
    encoding: "utf8",
    timeout: UNINSTALL_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

function launchctlCalls(f: Fixture): string[] {
  if (!existsSync(f.log)) return [];
  return readFileSync(f.log, "utf8").trim().split("\n").filter(Boolean);
}

function callsFor(f: Fixture, label: string): string[] {
  return launchctlCalls(f).filter((line) => line.endsWith(label));
}

function pollsFor(f: Fixture, label: string): number {
  return callsFor(f, label).filter((line) => line.startsWith("print ")).length;
}

function sleepCalls(f: Fixture): number {
  const log = join(f.directory, "sleep.log");
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
}

function assertSucceeded(result: SpawnSyncReturns<string>): void {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("a stuck canonical bridge fails without deleting its plist or claiming removal", () => {
  const f = fixture({ bridge: "stuck", legacy: "installed" });
  try {
    const started = Date.now();
    const result = runUninstall(f, ["--bridge-only", "--uninstall"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.ok(Date.now() - started < UNINSTALL_TIMEOUT_MS);
    assert.match(result.stderr, /com\.hewenyu\.myrix is still loaded after bootout/);
    assert.match(result.stderr, /launch definition was left in place/);
    assert.equal(readFileSync(f.plists.bridge, "utf8"), f.configuration.bridge);
    assert.ok(existsSync(f.markers.bridgeLoaded), "the stuck daemon is still loaded");
    // The label was not removed, so neither the per-label success line nor the
    // final "uninstall finished" summary may appear.
    assert.doesNotMatch(result.stdout, /removed/);
    assert.doesNotMatch(result.stdout, /Left in place on purpose/);
    assert.equal(pollsFor(f, "com.hewenyu.myrix"), UNLOAD_SLEEP_BOUND + 2);
    assert.equal(sleepCalls(f), UNLOAD_SLEEP_BOUND);
    assert.equal(
      callsFor(f, "com.hewenyu.myrix").filter((line) => line.startsWith("bootout ")).length,
      1,
    );
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /herdr-agent/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a stuck canonical bridge stops the uninstall before the legacy and server labels", () => {
  const f = fixture({ bridge: "stuck", legacy: "loaded", server: "loaded" });
  try {
    const result = runUninstall(f, ["--uninstall"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(f.plists.bridge, "utf8"), f.configuration.bridge);
    assert.equal(readFileSync(f.plists.legacy, "utf8"), f.configuration.legacy);
    assert.equal(readFileSync(f.plists.server, "utf8"), f.configuration.server);
    assert.ok(existsSync(f.markers.legacyLoaded));
    assert.ok(existsSync(f.markers.serverLoaded));
    assert.equal(pollsFor(f, "com.hewenyu.herdr-agent"), 0);
    assert.equal(pollsFor(f, "com.hewenyu.herdr-server"), 0);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a healthy canonical bridge is unloaded and removed together with the legacy label", () => {
  const f = fixture({ bridge: "loaded", legacy: "loaded", stateName: ".myrix" });
  try {
    const result = runUninstall(f, ["--bridge-only", "--uninstall"]);
    assertSucceeded(result);
    assert.match(result.stdout, /com\.hewenyu\.myrix removed/);
    assert.equal(
      callsFor(f, "com.hewenyu.herdr-agent").filter((line) => line.startsWith("bootout ")).length,
      1,
    );
    assert.equal(existsSync(f.plists.bridge), false);
    assert.equal(existsSync(f.plists.legacy), false);
    assert.equal(existsSync(f.markers.bridgeLoaded), false);
    assert.equal(existsSync(f.markers.legacyLoaded), false);
    assert.equal(sleepCalls(f), 0, "a loaded label that exits promptly is not polled to the bound");
    assert.match(result.stdout, /Left in place on purpose/);
    assert.ok(result.stdout.includes(f.state));
    assert.equal(
      readFileSync(join(f.state, "config.toml"), "utf8"),
      "uninstall leaves this alone\n",
    );
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /herdr-server/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("an already absent canonical label still uninstalls successfully", () => {
  const f = fixture({ legacy: "installed" });
  try {
    const result = runUninstall(f, ["--bridge-only", "--uninstall"]);
    assertSucceeded(result);
    assert.match(result.stdout, /com\.hewenyu\.myrix removed/);
    assert.equal(existsSync(f.plists.bridge), false);
    assert.equal(existsSync(f.plists.legacy), false);
    assert.match(result.stdout, /Left in place on purpose/);
    assert.equal(sleepCalls(f), 0);
    assert.ok(pollsFor(f, "com.hewenyu.myrix") <= 2, "an absent label is not polled to the bound");
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("uninstalling an already clean machine is an idempotent success", () => {
  const f = fixture();
  try {
    const result = runUninstall(f, ["--uninstall"]);
    assertSucceeded(result);
    assert.match(result.stdout, /com\.hewenyu\.myrix removed/);
    assert.match(result.stdout, /com\.hewenyu\.herdr-server removed/);
    assert.deepEqual(readdirSync(f.agents), []);
    assert.match(result.stdout, /Left in place on purpose/);
    assert.equal(
      readFileSync(join(f.state, "config.toml"), "utf8"),
      "uninstall leaves this alone\n",
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("--server-only --uninstall removes the server and leaves both bridge labels alone", () => {
  const f = fixture({ bridge: "loaded", legacy: "loaded", server: "loaded" });
  try {
    const result = runUninstall(f, ["--server-only", "--uninstall"]);
    assertSucceeded(result);
    assert.match(result.stdout, /com\.hewenyu\.herdr-server removed/);
    assert.doesNotMatch(result.stdout, /com\.hewenyu\.myrix removed/);
    assert.equal(existsSync(f.plists.server), false);
    assert.equal(existsSync(f.markers.serverLoaded), false);
    assert.equal(readFileSync(f.plists.bridge, "utf8"), f.configuration.bridge);
    assert.equal(readFileSync(f.plists.legacy, "utf8"), f.configuration.legacy);
    assert.ok(existsSync(f.markers.bridgeLoaded));
    assert.ok(existsSync(f.markers.legacyLoaded));
    assert.doesNotMatch(
      readFileSync(f.log, "utf8"),
      /com\.hewenyu\.myrix|com\.hewenyu\.herdr-agent/,
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("--bridge-only --uninstall keeps the herdr server job and its definition", () => {
  const f = fixture({ bridge: "loaded", server: "loaded" });
  try {
    const result = runUninstall(f, ["--bridge-only", "--uninstall"]);
    assertSucceeded(result);
    assert.match(result.stdout, /com\.hewenyu\.myrix removed/);
    assert.equal(existsSync(f.plists.bridge), false);
    assert.equal(readFileSync(f.plists.server, "utf8"), f.configuration.server);
    assert.ok(existsSync(f.markers.serverLoaded));
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /herdr-server/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a stuck herdr server fails without deleting its plist", () => {
  const f = fixture({ server: "stuck" });
  try {
    const result = runUninstall(f, ["--server-only", "--uninstall"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /com\.hewenyu\.herdr-server is still loaded after bootout/);
    assert.equal(readFileSync(f.plists.server, "utf8"), f.configuration.server);
    assert.doesNotMatch(result.stdout, /removed/);
    assert.doesNotMatch(result.stdout, /Left in place on purpose/);
    assert.equal(sleepCalls(f), UNLOAD_SLEEP_BOUND);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a stuck legacy bridge fails and keeps its definition after the canonical label is removed", () => {
  const f = fixture({ bridge: "loaded", legacy: "stuck" });
  try {
    const result = runUninstall(f, ["--bridge-only", "--uninstall"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /com\.hewenyu\.herdr-agent is still loaded/);
    assert.equal(existsSync(f.plists.bridge), false);
    assert.equal(readFileSync(f.plists.legacy, "utf8"), f.configuration.legacy);
    assert.ok(existsSync(f.markers.legacyLoaded));
    assert.doesNotMatch(result.stdout, /Left in place on purpose/);
    assert.equal(sleepCalls(f), UNLOAD_SLEEP_BOUND);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
