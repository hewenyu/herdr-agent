import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { status } from "../../src/cli/status.js";
import { acquireLock } from "../../src/storage/lock.js";

test("status does not create missing state and ignores an invalid configuration without SQLite", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "myrix-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDir = join(directory, "state");
  const output: string[] = [];
  const options = {
    stdout: (line: string) => output.push(line),
    run: async () => assert.fail("no process needs inspection"),
  };
  assert.equal(await status({ stateDir, json: true }, options), 0);
  assert.equal(JSON.parse(output[0] ?? "").state, "unlocked");
  assert.deepEqual(await readdir(directory), []);
  await mkdir(stateDir);
  await writeFile(join(stateDir, "config.toml"), "invalid = [");
  await writeFile(join(stateDir, "herdr-agent.pid"), "9999999\n");
  await status({ stateDir, json: true }, options);
  assert.equal(JSON.parse(output[1] ?? "").state, "unlocked");
  assert.deepEqual((await readdir(stateDir)).sort(), ["config.toml", "herdr-agent.pid"]);
  assert.equal(await readFile(join(stateDir, "herdr-agent.pid"), "utf8"), "9999999\n");
});

test("locked status shows bounded process identity and guidance without argv, environment or signals", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "myrix-status-pid-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const lock = acquireLock(stateDir);
  try {
    const output: string[] = [];
    await status(
      { stateDir },
      {
        platform: "linux",
        stdout: (line) => output.push(line),
        run: async (file, args) => {
          assert.equal(file, "/bin/ps");
          assert.deepEqual(args, ["-p", String(process.pid), "-o", "pid=,ppid=,comm="]);
          return `${process.pid} 1 /opt/myrix/bin/herdr-agent\n`;
        },
      },
    );
    assert.match(output[0] ?? "", /状态锁被持有/);
    assert.match(output[0] ?? "", /\/opt\/myrix\/bin\/herdr-agent/);
    assert.match(output[0] ?? "", /Ctrl\+C/);
    assert.match(output[0] ?? "", /不代表运行中实例的版本/);
    assert.doesNotMatch(output[0] ?? "", /kickstart|bootout/);
    assert.throws(() => acquireLock(stateDir), { code: "already_running" });
  } finally {
    lock.release();
  }
});

function job(pid: number, stateDir: string): string {
  return `gui/501/com.hewenyu.herdr-agent = {\n arguments = {\n /opt/npm/bin/myrix\n serve\n --state-dir\n ${stateDir}\n }\n pid = ${pid}\n environment = {\n FEISHU_APP_SECRET => must-not-print\n }\n}`;
}

for (const wrapper of [false, true])
  test(`launchd guidance requires a matching live holder and selected state directory (npm wrapper=${wrapper})`, async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "myrix-status-launchd-"));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const lock = acquireLock(stateDir);
    const jobPid = wrapper ? process.pid + 1 : process.pid;
    try {
      let output = "";
      await status(
        { stateDir, json: true },
        {
          platform: "darwin",
          uid: 501,
          stdout: (line) => {
            output = line;
          },
          run: async (file, args) => {
            if (file === "/bin/launchctl") {
              assert.deepEqual(args, ["print", "gui/501/com.hewenyu.herdr-agent"]);
              return job(jobPid, stateDir);
            }
            assert.equal(file, "/bin/ps");
            return `${process.pid} ${wrapper ? jobPid : 1} /opt/npm/native/herdr-agent\n`;
          },
        },
      );
      const report = JSON.parse(output);
      assert.equal(report.launchd.matched, true);
      assert.ok(report.installedVersion);
      assert.match(report.guidance.join("\n"), /launchctl bootout/);
      assert.match(report.guidance.join("\n"), /launchctl kickstart -k/);
      assert.match(report.guidance.join("\n"), /npm 升级不会自动/);
      assert.doesNotMatch(output, /must-not-print|FEISHU_APP_SECRET/);
    } finally {
      lock.release();
    }
  });

for (const mismatch of ["state", "relative-state", "pid", "process-unavailable"] as const)
  test(`launchd stop/restart guidance is withheld for ${mismatch}`, async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "myrix-status-mismatch-"));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const lock = acquireLock(stateDir);
    try {
      let output = "";
      await status(
        { stateDir, json: true },
        {
          platform: "darwin",
          uid: 501,
          stdout: (line) => {
            output = line;
          },
          run: async (file) => {
            if (file === "/bin/launchctl")
              return job(
                mismatch === "pid" ? process.pid + 1 : process.pid,
                mismatch === "state"
                  ? join(stateDir, "other")
                  : mismatch === "relative-state"
                    ? relative(process.cwd(), stateDir)
                    : stateDir,
              );
            if (mismatch === "process-unavailable") throw new Error("process unavailable");
            return `${process.pid} 1 /opt/myrix/herdr-agent\n`;
          },
        },
      );
      const report = JSON.parse(output);
      assert.equal(report.launchd.matched, false);
      assert.doesNotMatch(report.guidance.join("\n"), /kickstart|bootout/);
      assert.match(report.guidance.join("\n"), /只读检查：launchctl print/);
    } finally {
      lock.release();
    }
  });
