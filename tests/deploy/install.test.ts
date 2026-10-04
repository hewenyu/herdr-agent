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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { defaultPackageName, launcher } from "../../scripts/npm/config.js";

// A successful install runs several fresh-Node preflight/status probes and
// requires three consecutive stable readiness checks. Cold executable startup
// and scheduling contention can push this healthy fixture past the old 10s cap
// (warm runs take about 3s). Keep a finite 30s success-fixture allowance; this is
// not a bound on the sum of the installer's separate per-stage deadlines.
// Failure cases retain their original 10s / 15s / 40s budgets and boundedness
// assertions; do not widen them to make readiness or rollback failures pass.
const INSTALL_SUCCESS_TIMEOUT_MS = 30_000;

const probeFixture = `
const fs = require("node:fs");
const path = require("node:path");
const root = path.dirname(process.env.MYRIX_TEST_LAUNCH_LOG);
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log(JSON.stringify({ version: "0.3.15-test" }));
} else if (args[0] === "status") {
  if (process.env.MYRIX_TEST_STATUS_MODE === "unsupported") process.exit(2);
  const plist = path.join(process.env.HOME, "Library/LaunchAgents/com.hewenyu.myrix.plist");
  if (!fs.existsSync(plist) ||
      (process.env.MYRIX_TEST_WAIT_FOR_BOOTSTRAP && !fs.existsSync(path.join(root, "replacement-started")))) {
    console.log(JSON.stringify({ state: "unlocked" }));
  } else {
    const mode = process.env.MYRIX_TEST_STATUS_MODE;
    if (mode === "exited") process.exit(1);
    const counter = path.join(root, "startup-probes");
    const sequence = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0) + 1;
    fs.writeFileSync(counter, String(sequence));
    const executable = fs.readFileSync(plist, "utf8").split("<key>ProgramArguments</key>")[1].split("<string>")[1].split("</string>")[0];
    const pid = mode === "flapping" ? sequence + 1000 : 1001;
    console.log(JSON.stringify({
      state: mode === "unlocked" ? "unlocked" : "locked",
      stateDir: args[args.indexOf("--state-dir") + 1],
      pid,
      process: { pid: mode === "wrong-pid" ? 9999 : pid },
      launchd: {
        target: "gui/" + process.getuid() + "/com.hewenyu.myrix",
        pid: 1000,
        executable,
        matched: mode !== "unmatched",
      },
      feishu: { authorized: false },
    }));
  }
} else process.exit(2);
`;

const plutilFixture = `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "-lint") process.exit(0);
if (args[0] !== "-extract" || args[2] !== "raw" || args[3] !== "-o" || args[4] !== "-") process.exit(1);
try {
  let value = JSON.parse(fs.readFileSync(args[5], "utf8"));
  for (const key of args[1].split(".")) value = value[key];
  if (value === undefined || value === null || typeof value === "object") process.exit(1);
  process.stdout.write(String(value) + "\\n");
} catch { process.exit(1); }
`;

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// Use SIGKILL when the test's outer watchdog expires: the installer's EXIT
// rollback can delay shutdown after the default SIGTERM. This does not change
// the production probe/readiness deadlines or prove why an earlier run stalled.
// A killed run still fails the exit-status assertions, with its output retained.
function runInstaller(
  f: { script: string; env: NodeJS.ProcessEnv },
  timeout: number,
  env: NodeJS.ProcessEnv = f.env,
): SpawnSyncReturns<string> {
  return spawnSync("/bin/bash", [f.script, "--bridge-only"], {
    env,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
}

// Preserve both output streams and watchdog/spawn metadata in assertion failures.
function installerDiagnostics(result: SpawnSyncReturns<string>): string {
  const error = result.error as NodeJS.ErrnoException | undefined;
  return [
    `status=${String(result.status)}`,
    `signal=${String(result.signal)}`,
    `error=${error ? `${error.name}: ${error.message} (code=${String(error.code)})` : "none"}`,
    `stdout:\n${result.stdout ?? ""}`,
    `stderr:\n${result.stderr ?? ""}`,
  ].join("\n");
}

// Each successful readiness probe extracts eight fields, for up to thirty
// attempts. Avoid starting a fresh Node VM for every extraction on Darwin,
// which ships the same plutil used in production. Other platforms retain the
// portable Node JSON extractor; the rejected-plist case still forces lint failure.
function plutilBody(failLint = false): string {
  if (process.platform === "darwin")
    return [
      "#!/bin/sh",
      failLint ? 'if [ "$1" = "-lint" ]; then exit 1; fi' : "",
      'exec /usr/bin/plutil "$@"',
      "",
    ]
      .filter(Boolean)
      .join("\n");
  return `#!${process.execPath}\n${failLint ? 'if (process.argv[2] === "-lint") process.exit(1);\n' : ""}${plutilFixture}`;
}

function fixture(stateName = ".herdr-agent") {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "myrix-launchd-test-")));
  cpSync(resolve("deploy"), join(directory, "deploy"), { recursive: true });
  const home = join(directory, "home");
  const tools = join(directory, "mock-tools");
  const npmBin = join(directory, "npm-bin");
  const nodeBin = join(directory, "selected-node", "bin");
  const state = join(home, stateName);
  for (const path of [home, tools, npmBin, nodeBin, join(state, "bin")])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(state, ".env"), "FEISHU_APP_ID=test\nFEISHU_APP_SECRET=test\n", {
    mode: 0o600,
  });
  writeFileSync(join(state, "config.toml"), '[feishu]\nallowed_open_ids = ["test"]\n');
  const old = join(state, "bin", "herdr-agent");
  executable(old, `#!${process.execPath}\n${probeFixture}`);
  executable(join(nodeBin, "node"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  for (const [name, body] of Object.entries({
    uname: "echo Darwin",
    sw_vers: "echo 14.0",
    stat: "echo 600",
    dscl: "echo 'UserShell: /bin/sh'",
    sleep: "exit 0",
    launchctl:
      'printf \'%s\\n\' "$*" >> "$MYRIX_TEST_LAUNCH_LOG"\ncase "$1" in print) exit 1;; print-disabled) echo "{}";; esac',
  }))
    executable(join(tools, name), `#!/bin/sh\n${body}\n`);
  executable(join(tools, "plutil"), plutilBody());
  // Keep already-disabled unqualified delays in-process for the Bash fixture.
  // Other shells retain the PATH fallback; explicit /bin/sleep probe watchdogs
  // remain real. No extra interpreter is needed just to return success.
  const bashEnv = join(directory, "fixture-bash-env.sh");
  writeFileSync(bashEnv, "sleep() { :; }\n");
  const log = join(directory, "launchctl.log");
  return {
    directory,
    script: join(directory, "deploy", "install.sh"),
    home,
    nodeBin,
    npmBin,
    old,
    state,
    tools,
    log,
    bashEnv,
    env: {
      ...process.env,
      HOME: home,
      MYRIX_BIN: "",
      HERDR_AGENT_BIN: "",
      MYRIX_TEST_LAUNCH_LOG: log,
      BASH_ENV: bashEnv,
      PATH: [tools, npmBin, nodeBin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    },
  };
}

function canonicalFixture(
  options: {
    installed?: boolean;
    loaded?: boolean;
    disabled?: boolean;
    legacy?: boolean;
    legacyLoaded?: boolean;
    failure?: "bootstrap" | "readiness" | "install" | "legacy-disable" | "stuck-replacement";
  } = {},
) {
  const f = fixture();
  const agents = join(f.home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const canonical = join(agents, "com.hewenyu.myrix.plist");
  const legacy = join(agents, "com.hewenyu.herdr-agent.plist");
  if (options.installed !== false) writeFileSync(canonical, "original canonical configuration");
  if (options.loaded) writeFileSync(join(f.directory, "canonical-loaded"), "original");
  if (options.legacy) writeFileSync(legacy, "original legacy configuration");
  if (options.legacyLoaded) writeFileSync(join(f.directory, "legacy-loaded"), "original");
  executable(
    join(f.tools, "launchctl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$MYRIX_TEST_LAUNCH_LOG"
root=$(dirname "$MYRIX_TEST_LAUNCH_LOG")
case "$1" in
  print-disabled) printf '{\\n "com.hewenyu.myrix" => ${options.disabled ?? false},\\n "com.hewenyu.herdr-agent" => true,\\n}\\n' ;;
  print) case "$2" in */com.hewenyu.myrix) test -f "$root/canonical-loaded";; *) test -f "$root/legacy-loaded";; esac ;;
  disable) if [ "${options.failure}" = legacy-disable ]; then case "$2" in */com.hewenyu.herdr-agent) exit 5;; esac; fi ;;
  bootout) case "$2" in
    */com.hewenyu.myrix)
      if [ "${options.failure}" != stuck-replacement ] || [ ! -f "$root/replacement-started" ]; then rm -f "$root/canonical-loaded"; fi ;;
    *) rm -f "$root/legacy-loaded";;
  esac ;;
  bootstrap) case "$3" in
    */com.hewenyu.myrix.plist)
      if test -f "$root/legacy-loaded" || test -f "$root/canonical-loaded"; then touch "$root/overlap"; exit 9; fi
      if grep -q 'original canonical configuration' "$3"; then
        echo original > "$root/canonical-loaded"
      else
        touch "$root/replacement-started"
        echo replacement > "$root/canonical-loaded"
        case "${options.failure}" in bootstrap|stuck-replacement) exit 5;; esac
      fi ;;
    *)
      if test -f "$root/canonical-loaded" || test -f "$root/legacy-loaded"; then touch "$root/overlap"; exit 9; fi
      touch "$root/legacy-loaded" ;;
  esac ;;
esac
`,
  );
  if (options.failure === "install") {
    executable(
      join(f.tools, "install"),
      '#!/bin/sh\nif [ "$2" = 644 ]; then exit 7; fi\nexec /usr/bin/install "$@"\n',
    );
  }
  return {
    ...f,
    agents,
    canonical,
    legacy,
    env: {
      ...f.env,
      MYRIX_TEST_WAIT_FOR_BOOTSTRAP: "1",
      MYRIX_TEST_STATUS_MODE: options.failure === "readiness" ? "exited" : "stable",
    },
  };
}

for (const selected of ["npm", "explicit", "alias", "legacy"] as const)
  test(`launchd installer selects ${selected} bridge and preserves the selected Node path`, () => {
    const f = fixture();
    try {
      const npmLauncher = join(f.npmBin, "myrix");
      if (selected !== "legacy") {
        const launcher = join(f.directory, "myrix.cjs");
        executable(launcher, `#!/usr/bin/env node\n${probeFixture}`);
        symlinkSync(launcher, npmLauncher);
      }
      if (selected === "explicit") {
        f.env.MYRIX_BIN = f.old;
        f.env.HERDR_AGENT_BIN = npmLauncher;
      }
      if (selected === "alias") f.env.HERDR_AGENT_BIN = f.old;
      const result = runInstaller(f, INSTALL_SUCCESS_TIMEOUT_MS);
      assert.equal(result.status, 0, installerDiagnostics(result));
      const plist = readFileSync(
        join(f.home, "Library", "LaunchAgents", "com.hewenyu.myrix.plist"),
        "utf8",
      );
      const binary = /<key>ProgramArguments<\/key>\s*<array>\s*<string>(.*?)<\/string>/.exec(
        plist,
      )?.[1];
      assert.equal(binary, selected === "npm" ? npmLauncher : f.old);
      const path = /<key>PATH<\/key>\s*<string>(.*?)<\/string>/.exec(plist)?.[1];
      assert.ok(path?.split(":").includes(f.nodeBin));
      assert.doesNotMatch(plist, /__[A-Z_]+__/);
      assert.equal(existsSync(f.log), true, installerDiagnostics(result));
      const calls = readFileSync(f.log, "utf8");
      assert.match(calls, /bootstrap .*com\.hewenyu\.myrix\.plist/);
      assert.doesNotMatch(calls, /herdr-server/);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

test("adding the selected Node directory never shadows earlier selected executors", () => {
  const f = fixture();
  try {
    const agentBin = join(f.home, ".local", "bin");
    mkdirSync(agentBin, { recursive: true });
    for (const name of ["claude", "codex"]) {
      executable(join(agentBin, name), "#!/bin/sh\necho selected\n");
      executable(join(f.nodeBin, name), "#!/bin/sh\necho obsolete\n");
    }
    f.env.PATH = `${agentBin}:${f.env.PATH}`;
    const result = runInstaller(f, INSTALL_SUCCESS_TIMEOUT_MS);
    assert.equal(result.status, 0, installerDiagnostics(result));
    const plist = readFileSync(
      join(f.home, "Library", "LaunchAgents", "com.hewenyu.myrix.plist"),
      "utf8",
    );
    const path = /<key>PATH<\/key>\s*<string>(.*?)<\/string>/.exec(plist)?.[1];
    assert.ok(path);
    assert.ok(path.split(":").indexOf(agentBin) < path.split(":").indexOf(f.nodeBin));
    assert.ok(!path.includes(f.npmBin), "unrelated PATH directories are not copied");
    for (const name of ["claude", "codex", "node"]) {
      const resolved: SpawnSyncReturns<string> = spawnSync(
        "/bin/sh",
        ["-c", `command -v ${name}`],
        {
          env: { PATH: path },
          encoding: "utf8",
        },
      );
      assert.equal(resolved.status, 0);
      assert.equal(resolved.stdout.trim(), join(name === "node" ? f.nodeBin : agentBin, name));
    }
    assert.equal(existsSync(f.log), true, installerDiagnostics(result));
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /herdr-server/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

// Make a fallback launch observable without a scheduling-sensitive duration assertion.
test("the fixture no-op sleep is implemented in the installer shell, not the PATH fallback", () => {
  const f = fixture();
  try {
    const marker = join(f.directory, "fallback-sleep-ran");
    executable(
      join(f.tools, "sleep"),
      '#!/bin/sh\nprintf ran > "$MYRIX_TEST_SLEEP_MARKER"\nexit 9\n',
    );
    const result = spawnSync(
      "/bin/bash",
      ["-c", 'set -e; sleep 0.5; printf "%s\\n" "delay-elapsed"'],
      {
        env: { ...f.env, MYRIX_TEST_SLEEP_MARKER: marker },
        encoding: "utf8",
        timeout: 5_000,
        killSignal: "SIGKILL",
      },
    );
    assert.equal(result.status, 0, installerDiagnostics(result));
    assert.equal(result.stdout, "delay-elapsed\n", installerDiagnostics(result));
    assert.equal(existsSync(marker), false, installerDiagnostics(result));
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

for (const directories of ["new", "legacy", "both"] as const)
  test(`myrix launchd install preserves ${directories} state directories and retires only the old bridge`, () => {
    const f = fixture(directories === "new" ? ".myrix" : ".herdr-agent");
    try {
      const agents = join(f.home, "Library", "LaunchAgents");
      mkdirSync(agents, { recursive: true });
      const legacyPlist = join(agents, "com.hewenyu.herdr-agent.plist");
      writeFileSync(legacyPlist, "old bridge deployment");
      const database = join(f.state, "state.sqlite");
      writeFileSync(database, "existing task and conversation history");
      if (directories === "both") mkdirSync(join(f.home, ".myrix"));
      const result = runInstaller(f, INSTALL_SUCCESS_TIMEOUT_MS);
      assert.equal(result.status, 0, installerDiagnostics(result));
      const plist = readFileSync(join(agents, "com.hewenyu.myrix.plist"), "utf8");
      assert.match(plist, /<key>Label<\/key>\s*<string>com\.hewenyu\.myrix<\/string>/);
      assert.ok(plist.includes(`<string>${f.state}</string>`));
      assert.ok(plist.includes(`${f.state}/log/myrix.out.log`));
      assert.ok(plist.includes(`${f.state}/log/myrix.err.log`));
      assert.equal(readFileSync(database, "utf8"), "existing task and conversation history");
      assert.equal(existsSync(legacyPlist), false);
      if (directories === "legacy") assert.equal(existsSync(join(f.home, ".myrix")), false);
      assert.equal(existsSync(f.log), true, installerDiagnostics(result));
      const calls = readFileSync(f.log, "utf8").trim().split("\n");
      const disabled = calls.findIndex((line) =>
        /^disable .*com\.hewenyu\.herdr-agent$/.test(line),
      );
      const stopped = calls.findIndex((line) => /^bootout .*com\.hewenyu\.herdr-agent$/.test(line));
      const started = calls.findIndex((line) =>
        /^bootstrap .*com\.hewenyu\.myrix\.plist$/.test(line),
      );
      assert.ok(disabled >= 0 && stopped > disabled && started > stopped);
      assert.ok(calls.every((line) => !line.includes("herdr-server")));
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

for (const legacy of ["plist", "loaded", "absent"] as const)
  test(`failed legacy disable only blocks installation when the old bridge exists (${legacy})`, () => {
    const f = fixture();
    try {
      const agents = join(f.home, "Library", "LaunchAgents");
      mkdirSync(agents, { recursive: true });
      const legacyPlist = join(agents, "com.hewenyu.herdr-agent.plist");
      if (legacy === "plist") writeFileSync(legacyPlist, "old bridge deployment");
      executable(
        join(f.tools, "launchctl"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "$MYRIX_TEST_LAUNCH_LOG"\ncase "$1" in disable) exit 1;; print) exit ${legacy === "loaded" ? 0 : 1};; print-disabled) echo "{}";; esac\n`,
      );
      const result = runInstaller(f, legacy === "absent" ? INSTALL_SUCCESS_TIMEOUT_MS : 10_000);
      assert.equal(result.status, legacy === "absent" ? 0 : 1, installerDiagnostics(result));
      assert.equal(existsSync(legacyPlist), legacy === "plist");
      assert.equal(existsSync(join(agents, "com.hewenyu.myrix.plist")), legacy === "absent");
      assert.equal(existsSync(f.log), true, installerDiagnostics(result));
      if (legacy !== "absent") {
        assert.match(result.stderr, /cannot (disable|migrate) com\.hewenyu\.herdr-agent/);
        assert.doesNotMatch(readFileSync(f.log, "utf8"), /bootstrap/);
      }
      assert.doesNotMatch(readFileSync(f.log, "utf8"), /herdr-server/);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

test("the canonical systemd bridge delegates default state selection to myrix", () => {
  const unit = readFileSync(resolve("deploy/myrix.service"), "utf8");
  assert.match(unit, /^ExecStart=%h\/\.local\/bin\/myrix serve$/m);
  assert.match(unit, /^SyslogIdentifier=myrix$/m);
  assert.match(unit, /disable --now herdr-agent\.service/);
  assert.doesNotMatch(unit, /ExecStart=.*--state-dir/);
  assert.equal(existsSync(resolve("deploy/herdr-agent.service")), false);
});

test("a rejected new plist never disables or unloads the previous bridge", () => {
  const f = fixture();
  try {
    const agents = join(f.home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    const legacyPlist = join(agents, "com.hewenyu.herdr-agent.plist");
    writeFileSync(legacyPlist, "old bridge deployment");
    executable(join(f.tools, "plutil"), plutilBody(true));
    const result = runInstaller(f, 10_000);
    assert.equal(result.status, 1, installerDiagnostics(result));
    assert.match(result.stderr, /com\.hewenyu\.myrix\.plist did not render into a valid plist/);
    assert.equal(readFileSync(legacyPlist, "utf8"), "old bridge deployment");
    assert.equal(existsSync(join(agents, "com.hewenyu.myrix.plist")), false);
    assert.equal(existsSync(f.log), false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

for (const loaded of [false, true])
  for (const disabled of [false, true])
    test(`failed myrix bootstrap restores the old bridge (loaded=${loaded}, disabled=${disabled})`, () => {
      const f = fixture();
      try {
        const agents = join(f.home, "Library", "LaunchAgents");
        mkdirSync(agents, { recursive: true });
        const legacyPlist = join(agents, "com.hewenyu.herdr-agent.plist");
        writeFileSync(legacyPlist, "original bridge configuration");
        if (loaded) writeFileSync(join(f.directory, "old-loaded"), "true");
        executable(
          join(f.tools, "launchctl"),
          `#!/bin/sh
printf '%s\\n' "$*" >> "$MYRIX_TEST_LAUNCH_LOG"
root=$(dirname "$MYRIX_TEST_LAUNCH_LOG")
case "$1" in
  print-disabled) printf '{\\n "com.hewenyu.herdr-agent" => ${disabled},\\n}\\n' ;;
  print) case "$2" in */com.hewenyu.herdr-agent) test -f "$root/old-loaded";; *) exit 1;; esac ;;
  bootout) case "$2" in */com.hewenyu.herdr-agent) rm -f "$root/old-loaded";; esac ;;
  bootstrap) case "$3" in */com.hewenyu.myrix.plist) exit 5;; */com.hewenyu.herdr-agent.plist) touch "$root/old-loaded";; esac ;;
esac
`,
        );
        const result = runInstaller(f, 10_000);
        assert.equal(result.status, 1, installerDiagnostics(result));
        assert.match(result.stderr, /previous bridge definition and service state restored/);
        assert.equal(readFileSync(legacyPlist, "utf8"), "original bridge configuration");
        assert.equal(statSync(legacyPlist).mode & 0o777, 0o600);
        assert.equal(existsSync(join(agents, "com.hewenyu.myrix.plist")), false);
        assert.equal(existsSync(join(f.directory, "old-loaded")), loaded);
        assert.ok(!readdirSync(agents).some((name) => name.startsWith(".myrix-previous-bridge.")));
        assert.equal(existsSync(f.log), true, installerDiagnostics(result));
        const calls = readFileSync(f.log, "utf8").trim().split("\n");
        const oldStarts = calls.filter((line) =>
          /^bootstrap .*com\.hewenyu\.herdr-agent\.plist$/.test(line),
        );
        assert.equal(oldStarts.length, loaded ? 1 : 0);
        const enablement = calls.filter((line) =>
          /^(enable|disable) .*com\.hewenyu\.herdr-agent$/.test(line),
        );
        assert.ok(enablement.at(-1)?.startsWith(disabled ? "disable " : "enable "));
        assert.ok(calls.every((line) => !line.includes("herdr-server")));
      } finally {
        rmSync(f.directory, { recursive: true, force: true });
      }
    });

test("legacy enablement read failure preserves the old service before any mutation", () => {
  const f = fixture();
  try {
    const agents = join(f.home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    const legacyPlist = join(agents, "com.hewenyu.herdr-agent.plist");
    writeFileSync(legacyPlist, "original bridge configuration");
    executable(
      join(f.tools, "launchctl"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$MYRIX_TEST_LAUNCH_LOG"\nexit 1\n',
    );
    const result = runInstaller(f, 10_000);
    assert.equal(result.status, 1, installerDiagnostics(result));
    assert.match(result.stderr, /cannot read the previous bridge enablement/);
    assert.equal(readFileSync(legacyPlist, "utf8"), "original bridge configuration");
    assert.equal(existsSync(join(agents, "com.hewenyu.myrix.plist")), false);
    assert.equal(existsSync(f.log), true, installerDiagnostics(result));
    assert.doesNotMatch(
      readFileSync(f.log, "utf8"),
      /(?:^|\n)(?:disable|enable|bootout|bootstrap) /,
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("failure to install the new plist still restores the preserved old definition", () => {
  const f = fixture();
  try {
    const agents = join(f.home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    const legacyPlist = join(agents, "com.hewenyu.herdr-agent.plist");
    writeFileSync(legacyPlist, "original private configuration", { mode: 0o600 });
    executable(
      join(f.tools, "install"),
      '#!/bin/sh\ncase "$*" in */com.hewenyu.myrix.plist) exit 7;; esac\nexec /usr/bin/install "$@"\n',
    );
    const result = runInstaller(f, 10_000);
    assert.equal(result.status, 7, installerDiagnostics(result));
    assert.match(result.stderr, /previous bridge definition and service state restored/);
    assert.equal(readFileSync(legacyPlist, "utf8"), "original private configuration");
    assert.equal(statSync(legacyPlist).mode & 0o777, 0o600);
    assert.equal(existsSync(join(agents, "com.hewenyu.myrix.plist")), false);
    assert.equal(existsSync(f.log), true, installerDiagnostics(result));
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /bootstrap|herdr-server/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("rollback retains a private old definition without restarting it while the new job remains loaded", () => {
  const f = fixture();
  try {
    const agents = join(f.home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "com.hewenyu.herdr-agent.plist"), "original private configuration");
    writeFileSync(join(f.directory, "old-loaded"), "true");
    executable(join(f.tools, "sleep"), "#!/bin/sh\nexit 0\n");
    executable(
      join(f.tools, "launchctl"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$MYRIX_TEST_LAUNCH_LOG"
root=$(dirname "$MYRIX_TEST_LAUNCH_LOG")
case "$1" in
  print-disabled) echo '{}' ;;
  print) case "$2" in */com.hewenyu.herdr-agent) test -f "$root/old-loaded";; *) test -f "$root/new-loaded";; esac ;;
  bootout) case "$2" in */com.hewenyu.herdr-agent) rm -f "$root/old-loaded";; esac ;;
  bootstrap) case "$3" in */com.hewenyu.myrix.plist) touch "$root/new-loaded"; exit 5;; *) touch "$root/old-loaded";; esac ;;
esac
`,
    );
    const result = runInstaller(f, 10_000);
    assert.equal(result.status, 1, installerDiagnostics(result));
    assert.match(result.stderr, /old service was not restarted to avoid duplicate instances/);
    const backupName = readdirSync(agents).find((name) =>
      name.startsWith(".myrix-previous-bridge."),
    );
    assert.ok(backupName);
    const backup = join(agents, backupName);
    assert.equal(readFileSync(backup, "utf8"), "original private configuration");
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.ok(result.stderr.includes(backup));
    assert.equal(existsSync(join(f.directory, "old-loaded")), false);
    assert.equal(existsSync(f.log), true, installerDiagnostics(result));
    assert.doesNotMatch(
      readFileSync(f.log, "utf8"),
      /bootstrap .*com\.hewenyu\.herdr-agent\.plist|herdr-server/,
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

for (const unavailable of ["native-package", "status-command"] as const)
  test(`entry preflight rejects a missing ${unavailable} before changing the old bridge`, () => {
    const f = fixture();
    try {
      const agents = join(f.home, "Library", "LaunchAgents");
      mkdirSync(agents, { recursive: true });
      const legacyPlist = join(agents, "com.hewenyu.herdr-agent.plist");
      writeFileSync(legacyPlist, "original bridge configuration");
      const env: NodeJS.ProcessEnv = { ...f.env };
      if (unavailable === "native-package") {
        const npmEntry = join(f.npmBin, "myrix");
        executable(npmEntry, launcher(defaultPackageName));
        env.MYRIX_BIN = npmEntry;
      } else env.MYRIX_TEST_STATUS_MODE = "unsupported";
      const result = runInstaller(f, 15_000, env);
      assert.equal(result.status, 1, installerDiagnostics(result));
      assert.match(result.stderr, /cannot (execute version|inspect status)/);
      assert.equal(readFileSync(legacyPlist, "utf8"), "original bridge configuration");
      assert.equal(existsSync(join(agents, "com.hewenyu.myrix.plist")), false);
      assert.equal(existsSync(f.log), false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

test("a nonresponsive executable probe is bounded without changing the old deployment", () => {
  const f = fixture();
  try {
    const agents = join(f.home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    const legacyPlist = join(agents, "com.hewenyu.herdr-agent.plist");
    writeFileSync(legacyPlist, "original bridge configuration");
    executable(
      f.old,
      `#!${process.execPath}\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`,
    );
    const started = Date.now();
    const result = runInstaller(f, 15_000);
    assert.equal(result.status, 1, installerDiagnostics(result));
    assert.ok(Date.now() - started < 15_000);
    assert.match(result.stderr, /cannot execute version/);
    assert.equal(readFileSync(legacyPlist, "utf8"), "original bridge configuration");
    assert.equal(existsSync(join(agents, "com.hewenyu.myrix.plist")), false);
    assert.equal(existsSync(f.log), false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

for (const mode of ["stable", "exited", "unlocked", "wrong-pid", "unmatched", "flapping"] as const)
  test(`successful bootstrap commits the migration only after stable state-lock ownership (${mode})`, () => {
    const f = fixture();
    try {
      const agents = join(f.home, "Library", "LaunchAgents");
      mkdirSync(agents, { recursive: true });
      const legacyPlist = join(agents, "com.hewenyu.herdr-agent.plist");
      writeFileSync(legacyPlist, "original bridge configuration");
      writeFileSync(join(f.directory, "old-loaded"), "true");
      executable(
        join(f.tools, "launchctl"),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$MYRIX_TEST_LAUNCH_LOG"
root=$(dirname "$MYRIX_TEST_LAUNCH_LOG")
case "$1" in
  print-disabled) echo '{}' ;;
  print) case "$2" in */com.hewenyu.herdr-agent) test -f "$root/old-loaded";; *) test -f "$root/new-loaded";; esac ;;
  bootout) case "$2" in */com.hewenyu.herdr-agent) rm -f "$root/old-loaded";; *) rm -f "$root/new-loaded";; esac ;;
  bootstrap) case "$3" in */com.hewenyu.myrix.plist) touch "$root/new-loaded";; *) touch "$root/old-loaded";; esac ;;
esac
`,
      );
      const result = runInstaller(f, 40_000, { ...f.env, MYRIX_TEST_STATUS_MODE: mode });
      assert.equal(result.status, mode === "stable" ? 0 : 1, installerDiagnostics(result));
      assert.equal(existsSync(join(f.directory, "old-loaded")), mode !== "stable");
      assert.equal(existsSync(join(f.directory, "new-loaded")), mode === "stable");
      assert.equal(existsSync(join(agents, "com.hewenyu.myrix.plist")), mode === "stable");
      if (mode === "stable") {
        assert.equal(Number(readFileSync(join(f.directory, "startup-probes"), "utf8")), 3);
        assert.equal(existsSync(legacyPlist), false);
        assert.match(result.stdout, /stable process and the selected state lock/);
      } else {
        assert.match(result.stderr, /did not acquire a stable state lock/);
        assert.match(result.stderr, /previous bridge definition and service state restored/);
        assert.equal(readFileSync(legacyPlist, "utf8"), "original bridge configuration");
      }
      assert.ok(!readdirSync(agents).some((name) => name.startsWith(".myrix-previous-bridge.")));
      assert.equal(existsSync(f.log), true, installerDiagnostics(result));
      assert.doesNotMatch(readFileSync(f.log, "utf8"), /herdr-server/);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

for (const loaded of [false, true])
  for (const disabled of [false, true])
    for (const failure of ["bootstrap", "readiness"] as const)
      test(`canonical ${failure} failure restores its definition and prior state (loaded=${loaded}, disabled=${disabled})`, () => {
        const f = canonicalFixture({ loaded, disabled, failure, legacy: disabled });
        try {
          const result = runInstaller(f, 40_000);
          assert.equal(result.status, 1, installerDiagnostics(result));
          assert.match(result.stderr, /previous bridge definition and service state restored/);
          assert.equal(readFileSync(f.canonical, "utf8"), "original canonical configuration");
          assert.equal(statSync(f.canonical).mode & 0o777, 0o600);
          if (disabled) {
            assert.equal(readFileSync(f.legacy, "utf8"), "original legacy configuration");
            assert.equal(statSync(f.legacy).mode & 0o777, 0o600);
          } else assert.equal(existsSync(f.legacy), false);
          assert.equal(existsSync(join(f.directory, "canonical-loaded")), loaded);
          if (loaded)
            assert.equal(
              readFileSync(join(f.directory, "canonical-loaded"), "utf8").trim(),
              "original",
            );
          assert.equal(existsSync(join(f.directory, "legacy-loaded")), false);
          assert.equal(existsSync(join(f.directory, "overlap")), false);
          assert.ok(
            !readdirSync(f.agents).some((name) => name.startsWith(".myrix-previous-bridge.")),
          );
          assert.equal(existsSync(f.log), true, installerDiagnostics(result));
          const calls = readFileSync(f.log, "utf8").trim().split("\n");
          assert.equal(
            calls.filter((line) => /^bootstrap .*com\.hewenyu\.myrix\.plist$/.test(line)).length,
            loaded ? 2 : 1,
          );
          for (const [label, expectedDisabled] of [
            ["myrix", disabled],
            ["herdr-agent", true],
          ] as const) {
            const preference = calls.filter(
              (line) => /^(enable|disable) /.test(line) && line.endsWith(`/com.hewenyu.${label}`),
            );
            assert.ok(preference.at(-1)?.startsWith(expectedDisabled ? "disable " : "enable "));
          }
          assert.doesNotMatch(calls.join("\n"), /bootstrap .*herdr-agent\.plist|herdr-server/);
        } finally {
          rmSync(f.directory, { recursive: true, force: true });
        }
      });

for (const failure of ["bootstrap", "readiness"] as const)
  test(`fresh ${failure} failure removes the failed job and definition`, () => {
    const f = canonicalFixture({ installed: false, failure, disabled: true });
    try {
      const result = runInstaller(f, 40_000);
      assert.equal(result.status, 1, installerDiagnostics(result));
      assert.equal(existsSync(f.canonical), false);
      assert.equal(existsSync(f.legacy), false);
      assert.equal(existsSync(join(f.directory, "canonical-loaded")), false);
      assert.equal(existsSync(join(f.directory, "legacy-loaded")), false);
      assert.equal(existsSync(join(f.directory, "overlap")), false);
      assert.deepEqual(readdirSync(f.agents), []);
      assert.equal(existsSync(f.log), true, installerDiagnostics(result));
      const calls = readFileSync(f.log, "utf8").trim().split("\n");
      assert.equal(calls.filter((line) => line.startsWith("bootstrap ")).length, 1);
      const preferences = calls.filter((line) =>
        /^(enable|disable) .*com\.hewenyu\.myrix$/.test(line),
      );
      assert.ok(preferences.at(-1)?.startsWith("disable "));
      assert.doesNotMatch(calls.join("\n"), /herdr-server/);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

test("successful canonical upgrade keeps the verified replacement and removes both backups", () => {
  const f = canonicalFixture({ loaded: true, legacy: true });
  try {
    const result = runInstaller(f, INSTALL_SUCCESS_TIMEOUT_MS);
    assert.equal(result.status, 0, installerDiagnostics(result));
    assert.match(readFileSync(f.canonical, "utf8"), /<string>com\.hewenyu\.myrix<\/string>/);
    assert.equal(readFileSync(join(f.directory, "canonical-loaded"), "utf8").trim(), "replacement");
    assert.equal(Number(readFileSync(join(f.directory, "startup-probes"), "utf8")), 3);
    assert.equal(existsSync(f.legacy), false);
    assert.equal(existsSync(join(f.directory, "legacy-loaded")), false);
    assert.equal(existsSync(join(f.directory, "overlap")), false);
    assert.deepEqual(readdirSync(f.agents), ["com.hewenyu.myrix.plist"]);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

for (const failure of ["install", "legacy-disable"] as const)
  test(`${failure} failure preserves an existing canonical bridge before replacement bootstrap`, () => {
    const f = canonicalFixture({ loaded: true, legacy: true, failure });
    try {
      const result = runInstaller(f, 10_000);
      assert.equal(result.status, failure === "install" ? 7 : 1, installerDiagnostics(result));
      assert.equal(readFileSync(f.canonical, "utf8"), "original canonical configuration");
      assert.equal(readFileSync(f.legacy, "utf8"), "original legacy configuration");
      assert.equal(readFileSync(join(f.directory, "canonical-loaded"), "utf8").trim(), "original");
      assert.equal(existsSync(join(f.directory, "replacement-started")), false);
      assert.equal(existsSync(join(f.directory, "overlap")), false);
      if (failure === "legacy-disable") {
        assert.equal(existsSync(f.log), true, installerDiagnostics(result));
        assert.doesNotMatch(readFileSync(f.log, "utf8"), /bootout .*myrix|bootstrap /);
      }
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

for (const conflict of ["missing-plist", "both-loaded"] as const)
  test(`unsafe ${conflict} original state is rejected before either bridge is changed`, () => {
    const f = canonicalFixture({
      installed: conflict !== "missing-plist",
      loaded: true,
      legacy: true,
      legacyLoaded: conflict === "both-loaded",
    });
    try {
      const result = runInstaller(f, 10_000);
      assert.equal(result.status, 1, installerDiagnostics(result));
      assert.match(
        result.stderr,
        conflict === "missing-plist"
          ? /without its original plist/
          : /both bridge labels are loaded/,
      );
      assert.equal(readFileSync(join(f.directory, "canonical-loaded"), "utf8").trim(), "original");
      assert.equal(readFileSync(f.legacy, "utf8"), "original legacy configuration");
      assert.equal(existsSync(f.log), true, installerDiagnostics(result));
      assert.doesNotMatch(
        readFileSync(f.log, "utf8"),
        /(?:^|\n)(?:disable|enable|bootout|bootstrap) /,
      );
      assert.ok(!readdirSync(f.agents).some((name) => name.startsWith(".myrix-previous-bridge.")));
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

test("a stuck replacement retains private backups for both previous labels and restarts neither", () => {
  const f = canonicalFixture({ loaded: true, legacy: true, failure: "stuck-replacement" });
  try {
    const result = runInstaller(f, 10_000);
    assert.equal(result.status, 1, installerDiagnostics(result));
    assert.match(result.stderr, /old service was not restarted to avoid duplicate instances/);
    const backups = readdirSync(f.agents).filter((name) =>
      name.startsWith(".myrix-previous-bridge."),
    );
    assert.equal(backups.length, 2);
    assert.deepEqual(backups.map((name) => readFileSync(join(f.agents, name), "utf8")).sort(), [
      "original canonical configuration",
      "original legacy configuration",
    ]);
    for (const name of backups) {
      assert.equal(statSync(join(f.agents, name)).mode & 0o777, 0o600);
      assert.ok(result.stderr.includes(join(f.agents, name)));
    }
    assert.equal(readFileSync(join(f.directory, "canonical-loaded"), "utf8").trim(), "replacement");
    assert.equal(existsSync(join(f.directory, "legacy-loaded")), false);
    assert.equal(existsSync(join(f.directory, "overlap")), false);
    assert.equal(existsSync(f.log), true, installerDiagnostics(result));
    assert.equal(
      readFileSync(f.log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("bootstrap ")).length,
      1,
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Darwin plutil extracts raw version and status evidence without Node", {
  skip: process.platform !== "darwin",
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "myrix-plutil-test-"));
  try {
    const file = join(directory, "status.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: "0.3.15",
        state: "locked",
        stateDir: "/Users/test/.myrix",
        pid: 1001,
        process: { pid: 1001 },
        launchd: {
          target: "gui/501/com.hewenyu.myrix",
          matched: true,
          pid: 1000,
          executable: "/opt/bin/myrix",
        },
      }),
    );
    for (const [key, value] of Object.entries({
      version: "0.3.15",
      state: "locked",
      stateDir: "/Users/test/.myrix",
      pid: "1001",
      "process.pid": "1001",
      "launchd.target": "gui/501/com.hewenyu.myrix",
      "launchd.matched": "true",
      "launchd.pid": "1000",
      "launchd.executable": "/opt/bin/myrix",
    })) {
      const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", file], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), value);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
