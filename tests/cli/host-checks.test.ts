import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArguments } from "../../src/cli/args.js";
import { dependencies } from "../../src/cli/dependencies.js";
import { doctor } from "../../src/cli/diagnostics.js";
import {
  environmentNames,
  type HostProbe,
  inspectHost,
  paneWidths,
} from "../../src/cli/host-checks.js";
import { FakeHerdr, setup } from "../tasks/helpers.js";

const signal = new AbortController().signal;
function probe(overrides: Partial<HostProbe> = {}): HostProbe {
  return {
    home: "/fake",
    configDir: "/fake/.config/herdr",
    read: async () => "[update]\nmanifest_check=false\n",
    file: async () => true,
    command: async (command) =>
      command === "pgrep" ? "123\n" : "PID TT COMMAND\n123 herdr server PATH=/bin HOME=/fake\n",
    ...overrides,
  };
}
test("doctor probes hooks, pinned manifest and actual server environment without exposing values", async () => {
  const checks = await inspectHost(signal, probe());
  assert.equal(checks.length, 4);
  assert.ok(checks.every((check) => check.status === "pass"));
  assert.match(checks.find((check) => check.name === "codex-hook")?.message ?? "", /信任/);
  const dirty = await inspectHost(
    signal,
    probe({
      command: async (command) =>
        command === "pgrep"
          ? "123"
          : "PATH=/bin CLAUDE_CODE_CHILD_SESSION=supersecret OPENAI_API_KEY=secret",
    }),
  );
  assert.equal(dirty.find((check) => check.name === "server-environment")?.status, "fail");
  assert.ok(!JSON.stringify(dirty).includes("supersecret"));
  assert.ok(!JSON.stringify(dirty).includes("OPENAI_API_KEY"));
});
test("unreadable environment and missing hooks are never reported clean", async () => {
  const checks = await inspectHost(
    signal,
    probe({
      file: async () => {
        throw Object.assign(new Error(), { code: "ENOENT" });
      },
      command: async (command) => (command === "pgrep" ? "123" : "123 env FOO=bar herdr server"),
    }),
  );
  assert.equal(checks.find((check) => check.name === "server-environment")?.status, "unknown");
  assert.equal(checks.find((check) => check.name === "claude-hook")?.status, "fail");
  assert.deepEqual(environmentNames("x --foo=bar CLAUDECODE=secret PATH=/bin"), [
    "CLAUDECODE",
    "PATH",
  ]);
});
test("pane width reports content lower bounds without treating short text as a narrow terminal", async () => {
  const herdr = new FakeHerdr();
  await herdr.createWorkspace("/fake");
  await herdr.startAgent("p1", "claude", "test", { directories: ["/fake"] });
  let text = "";
  herdr.screen = async (ref) => ({
    agent: await herdr.get(ref.paneId),
    text,
    question: "",
    options: [],
  });
  for (const sample of [
    { text: "", status: "unknown" },
    { text: " \n ", status: "unknown" },
    { text: "ready", status: "unknown" },
    { text: "x".repeat(53), status: "unknown" },
    { text: "x".repeat(60), status: "unknown" },
    { text: "x".repeat(61), status: "pass" },
    { text: "界".repeat(30), status: "unknown" },
    { text: "界".repeat(31), status: "pass" },
    { text: "界".repeat(40), status: "pass" },
    { text: "e\u0301".repeat(60), status: "unknown" },
    { text: "e\u0301".repeat(61), status: "pass" },
    { text: `\u001b[31m${"x".repeat(60)}\u001b[0m`, status: "unknown" },
  ]) {
    text = sample.text;
    const result = await paneWidths(herdr, signal);
    assert.equal(result.status, sample.status, JSON.stringify(sample));
    assert.match(result.message, /未读取终端实际列数/);
    assert.ok(!result.message.includes("请在宽窗口"));
    if (result.status === "pass") assert.match(result.message, /下界.*超过 60 列/);
  }
});

test("a wide pane does not hide another pane with insufficient or unreadable content", async () => {
  const herdr = new FakeHerdr();
  for (let i = 1; i <= 2; i++) {
    await herdr.createWorkspace("/fake");
    await herdr.startAgent(`p${i}`, "codex", "test", { directories: ["/fake"] });
  }
  let unreadable = false;
  herdr.screen = async (ref) => {
    if (ref.paneId === "p2" && unreadable) throw new Error("read unavailable");
    return {
      agent: await herdr.get(ref.paneId),
      text: ref.paneId === "p1" ? "界".repeat(40) : "ready",
      question: "",
      options: [],
    };
  };
  assert.equal((await paneWidths(herdr, signal)).status, "unknown");
  unreadable = true;
  const result = await paneWidths(herdr, signal);
  assert.equal(result.status, "unknown");
  assert.match(result.message, /屏幕不可读/);
});

test("no running agents requires no screen read; list failure remains unknown", async () => {
  const herdr = new FakeHerdr();
  herdr.screen = async () => assert.fail("no screen should be read");
  const empty = await paneWidths(herdr, signal);
  assert.equal(empty.status, "pass");
  assert.match(empty.message, /没有运行中的 agent/);
  herdr.list = async () => {
    throw new Error("list unavailable");
  };
  assert.equal((await paneWidths(herdr, signal)).status, "unknown");
});

test("doctor retains unknown in JSON and text while only fail determines its exit code", async () => {
  const h = setup();
  try {
    h.config.feishu.appId = "cli_test";
    h.config.feishu.appSecret = "test";
    await h.herdr.createWorkspace("/fake");
    await h.herdr.startAgent("p1", "codex", "test", { directories: ["/fake"] });
    for (const json of [true, false]) {
      for (const hostFails of [false, true]) {
        const output: string[] = [];
        const deps = dependencies({
          signal,
          stdout: (line) => output.push(line),
          createHerdr: () => h.herdr,
          executable: async () => true,
          checkAuthorization: async () => ({ state: "ready", missingScopes: [] }),
          inspectHost: async () => [
            { name: "test-host", status: hostFails ? "fail" : "pass", message: "test" },
          ],
        });
        const exit = await doctor(
          parseArguments(["doctor", ...(json ? ["--json"] : [])]),
          h.config,
          deps,
        );
        assert.equal(exit, hostFails ? 1 : 0);
        if (json) {
          const result = JSON.parse(output.join("\n"));
          assert.equal(
            result.checks.find((check: { name: string }) => check.name === "pane-width").status,
            "unknown",
          );
        } else assert.match(output.join("\n"), /\[unknown\] pane-width:/);
      }
    }
  } finally {
    h.close();
  }
});
