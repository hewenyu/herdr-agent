import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExecutionRef } from "../../src/core/types.js";
import { HerdrRuntime } from "../../src/herdr/runtime.js";
import { directoryTrustKeys, parseOptions, showsStartupMenu } from "../../src/herdr/screen.js";

// Captured E39 native Claude screen. No owner/session/path data remains in it.
const claude = readFileSync(
  new URL("../fixtures/native/claude-e39-ask-user-question.txt", import.meta.url),
  "utf8",
);
const expected = [
  { key: "1", label: "红色" },
  { key: "2", label: "蓝色" },
  { key: "3", label: "Type something." },
  { key: "4", label: "Chat about this" },
];

for (const selected of [1, 2, 3, 4]) {
  test(`E39 current Claude choice ${selected} excludes numbered prompt history`, () => {
    const native = claude
      .replace("❯ 1. 红色", "  1. 红色")
      .replace(
        `  ${selected}. ${expected[selected - 1]?.label}`,
        `❯ ${selected}. ${expected[selected - 1]?.label}`,
      );
    assert.deepEqual(parseOptions(native), expected);
    assert.equal(directoryTrustKeys("claude", native, "/tmp"), undefined);
  });
}

test("older complete menus and duplicate history keys cannot replace current labels", () => {
  const history = [
    "Old question",
    "❯ 1. Old yes",
    "  2. Old no",
    "Enter to select · Esc to cancel",
    "Previous user requirements:",
    "1. Never change files",
    "2. Wait for approval",
    "4. Do not finish",
  ].join("\n");
  assert.deepEqual(parseOptions(`${history}\n${claude}`), expected);
});

test("wrapped labels and indented numbered descriptions never become independent choices", () => {
  const native = claude.replace(
    "     下一步采用蓝色。",
    "     下一步采用蓝色。这是一段很长的描述，\n     窄终端上继续换行。\n     3. 描述中的编号不是按钮。",
  );
  assert.deepEqual(parseOptions(native), expected);
});

test("plain history, incomplete menus and a later unnumbered selection use manual fallback", () => {
  for (const text of [
    "1. First\n2. Second\nEsc to cancel",
    "❯ 1. Copied prose\n  2. More prose",
    "❯ 2. Only tail visible\n  3. No\nEnter to select · Esc to cancel",
    "❯ 1. Yes\n  3. No\nEnter to select · Esc to cancel",
    `${claude}\n❯ Yes, I trust this folder\nEnter to confirm · Esc to cancel`,
    `${claude}\n› Ask Codex to do anything`,
  ])
    assert.deepEqual(parseOptions(text), [], text);
});

test("Codex ordinary approval and startup preserve real ordered options with selected second item", () => {
  const native =
    "Old text\n1. Not an option\nDo you want to proceed?\n  1. Yes, proceed (y)\n› 2. No, and tell Codex what to do differently (esc)\nPress enter to continue";
  assert.deepEqual(parseOptions(native), [
    { key: "1", label: "Yes, proceed (y)" },
    { key: "2", label: "No, and tell Codex what to do differently (esc)" },
  ]);
  assert.equal(directoryTrustKeys("codex", native, "/tmp"), undefined);
  const startup =
    "Update available!\n  1. Update now\n› 2. Skip\n  3. Skip until next version\nPress enter to continue";
  assert.equal(showsStartupMenu(startup), true);
  assert.deepEqual(
    parseOptions(startup).map((choice) => choice.key),
    ["1", "2", "3"],
  );
  assert.equal(directoryTrustKeys("codex", startup, "/tmp"), undefined);
});

test("runtime keeps unrecognized live menus navigable and never trusts truncated choices", async () => {
  const ref: ExecutionRef = { paneId: "w1:p1", workspaceId: "w1", kind: "claude", cwd: "/tmp" };
  const runtime = new HerdrRuntime({ socket: "/not-used" });
  let truncated = false;
  runtime.client.transport.call = async (method) => {
    if (method === "agent.get")
      return {
        agent: {
          pane_id: ref.paneId,
          workspace_id: ref.workspaceId,
          agent: ref.kind,
          cwd: ref.cwd,
          agent_status: "blocked",
          state_change_seq: 1,
          interactive_ready: true,
          launch_pending: false,
        },
      };
    if (method === "agent.read")
      return {
        read: {
          text: "Previous output\n1. Historic one\n2. Historic two\n❯ Allow\n  Deny\nEnter to select · Esc to cancel",
          truncated,
        },
      };
    throw new Error(`Unexpected write: ${method}`);
  };
  assert.deepEqual(
    (await runtime.screen(ref)).options.map((choice) => choice.key),
    ["up", "down", "enter"],
  );
  truncated = true;
  assert.deepEqual((await runtime.screen(ref)).options, []);
});
