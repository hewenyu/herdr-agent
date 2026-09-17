import assert from "node:assert/strict";
import { test } from "node:test";
import {
  environmentNames,
  type HostProbe,
  inspectHost,
  paneWidths,
} from "../../src/cli/host-checks.js";
import { FakeHerdr } from "../tasks/helpers.js";

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
test("pane width distinguishes empty, narrow and wide content", async () => {
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
  assert.equal((await paneWidths(herdr, signal)).status, "unknown");
  text = "x".repeat(53);
  assert.equal((await paneWidths(herdr, signal)).status, "fail");
  text = "界".repeat(40);
  assert.equal((await paneWidths(herdr, signal)).status, "pass");
});
