import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "myrix-launchd-test-"));
  const home = join(directory, "home");
  const tools = join(directory, "mock-tools");
  const npmBin = join(directory, "npm-bin");
  const nodeBin = join(directory, "selected-node", "bin");
  const state = join(home, ".herdr-agent");
  for (const path of [home, tools, npmBin, nodeBin, join(state, "bin")])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(state, ".env"), "FEISHU_APP_ID=test\nFEISHU_APP_SECRET=test\n", {
    mode: 0o600,
  });
  writeFileSync(join(state, "config.toml"), '[feishu]\nallowed_open_ids = ["test"]\n');
  const old = join(state, "bin", "herdr-agent");
  executable(old, "#!/bin/sh\nexit 0\n");
  executable(join(nodeBin, "node"), "#!/bin/sh\nexit 0\n");
  for (const [name, body] of Object.entries({
    uname: "echo Darwin",
    sw_vers: "echo 14.0",
    stat: "echo 600",
    dscl: "echo 'UserShell: /bin/sh'",
    plutil: "exit 0",
    launchctl:
      'printf \'%s\\n\' "$*" >> "$MYRIX_TEST_LAUNCH_LOG"\ncase "$1" in print) exit 1;; esac',
  }))
    executable(join(tools, name), `#!/bin/sh\n${body}\n`);
  const log = join(directory, "launchctl.log");
  return {
    directory,
    home,
    nodeBin,
    npmBin,
    old,
    log,
    env: {
      ...process.env,
      HOME: home,
      HERDR_AGENT_BIN: "",
      MYRIX_TEST_LAUNCH_LOG: log,
      PATH: [tools, npmBin, nodeBin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    },
  };
}

for (const selected of ["npm", "explicit", "legacy"] as const)
  test(`launchd installer selects ${selected} bridge and preserves the selected Node path`, () => {
    const f = fixture();
    try {
      const npmLauncher = join(f.npmBin, "myrix");
      if (selected !== "legacy") {
        const launcher = join(f.directory, "myrix.cjs");
        executable(
          launcher,
          '#!/usr/bin/env node\nthrow new Error("must not execute launcher");\n',
        );
        symlinkSync(launcher, npmLauncher);
      }
      if (selected === "explicit") f.env.HERDR_AGENT_BIN = f.old;
      const result = spawnSync("/bin/bash", [resolve("deploy/install.sh"), "--bridge-only"], {
        env: f.env,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const plist = readFileSync(
        join(f.home, "Library", "LaunchAgents", "com.hewenyu.herdr-agent.plist"),
        "utf8",
      );
      const binary = /<key>ProgramArguments<\/key>\s*<array>\s*<string>(.*?)<\/string>/.exec(
        plist,
      )?.[1];
      assert.equal(binary, selected === "npm" ? npmLauncher : f.old);
      const path = /<key>PATH<\/key>\s*<string>(.*?)<\/string>/.exec(plist)?.[1];
      assert.ok(path?.split(":").includes(f.nodeBin));
      assert.doesNotMatch(plist, /__[A-Z_]+__/);
      const calls = readFileSync(f.log, "utf8");
      assert.match(calls, /bootstrap .*com\.hewenyu\.herdr-agent\.plist/);
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
    const result = spawnSync("/bin/bash", [resolve("deploy/install.sh"), "--bridge-only"], {
      env: f.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const plist = readFileSync(
      join(f.home, "Library", "LaunchAgents", "com.hewenyu.herdr-agent.plist"),
      "utf8",
    );
    const path = /<key>PATH<\/key>\s*<string>(.*?)<\/string>/.exec(plist)?.[1];
    assert.ok(path);
    assert.ok(path.split(":").indexOf(agentBin) < path.split(":").indexOf(f.nodeBin));
    assert.ok(!path.includes(f.npmBin), "unrelated PATH directories are not copied");
    for (const name of ["claude", "codex", "node"]) {
      const resolved = spawnSync("/bin/sh", ["-c", `command -v ${name}`], {
        env: { PATH: path },
        encoding: "utf8",
      });
      assert.equal(resolved.status, 0);
      assert.equal(resolved.stdout.trim(), join(name === "node" ? f.nodeBin : agentBin, name));
    }
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /herdr-server/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
