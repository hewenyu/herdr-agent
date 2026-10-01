import assert from "node:assert/strict";
import test from "node:test";
import type { OperationError } from "../../src/core/errors.js";
import type { AgentSnapshot, ExecutionRef } from "../../src/core/types.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { AgentControl } from "../../src/herdr/control.js";
import { menuAction, nativeMenu } from "../../src/herdr/native-menu.js";
import { parseOptions, showsDialog, showsStartupMenu } from "../../src/herdr/screen.js";
import { HerdrTransport } from "../../src/herdr/transport.js";

// Captured Codex 0.158.0 update prompt: the cursor sits on the package-install
// option and herdr still reports idle + interactive_ready with no session.
const updateMenu = [
  "  Update available · 0.158.0 → 0.159.1",
  "  Release notes: https://github.com/openai/codex/releases/latest",
  "",
  "› 1. Update now (runs `npm install -g @openai/codex`)",
  "  2. Skip",
  "  3. Skip until next version",
  "",
  "  enter continue · esc skip",
].join("\n");
const labels = [
  "Update now (runs `npm install -g @openai/codex`)",
  "Skip",
  "Skip until next version",
];
const ref: ExecutionRef = { paneId: "w1:p1", workspaceId: "w1", kind: "codex", cwd: "/tmp" };
const raw = {
  pane_id: ref.paneId,
  workspace_id: ref.workspaceId,
  agent: ref.kind,
  cwd: ref.cwd,
  terminal_id: "terminal-1",
  agent_status: "idle",
  state_change_seq: 7,
  interactive_ready: true,
  launch_pending: false,
};

class ScreenClient extends HerdrClient {
  agent: AgentSnapshot = {
    ...ref,
    status: "idle",
    stateSeq: "7",
    terminalId: "terminal-1",
    interactiveReady: true,
    launchPending: false,
  };
  text = updateMenu;
  truncated = false;
  prompts: string[] = [];
  strokes: string[][] = [];
  constructor() {
    super(new HerdrTransport("/not-used"));
  }
  override async get() {
    return { ...this.agent };
  }
  override async read() {
    return { text: this.text, truncated: this.truncated };
  }
  override async prompt(_pane: string, text: string) {
    this.prompts.push(text);
    return this.agent;
  }
  override async keys(_pane: string, input: string[]) {
    this.strokes.push(input);
  }
}

test("real Codex update screen is a startup menu, not a composer or a trust prompt", () => {
  assert.equal(showsStartupMenu(updateMenu), true);
  assert.equal(showsDialog(updateMenu), true);
  assert.deepEqual(parseOptions(updateMenu), [
    { key: "1", label: labels[0] },
    { key: "2", label: labels[1] },
    { key: "3", label: labels[2] },
  ]);
  const menu = nativeMenu(updateMenu);
  assert.ok(menu);
  assert.equal(menu.selected, 0);
  assert.deepEqual(
    menu.options.map((option) => option.label),
    labels,
  );
});

test("menuAction navigates to Skip before allowing Enter confirmation", () => {
  const menu = nativeMenu(updateMenu);
  assert.ok(menu);
  const [update, skip] = menu.options;
  assert.ok(update && skip);
  assert.equal(menuAction(menu, update.id)?.key, "enter");
  assert.equal(menuAction(menu, skip.id)?.key, "down");
  assert.notEqual(menuAction(menu, skip.id)?.key, "enter");
  // After the cursor readback lands on Skip, Enter is the confirmation.
  const moved = nativeMenu(updateMenu.replace("› 1.", "  1.").replace("  2. Skip", "› 2. Skip"));
  assert.ok(moved);
  assert.equal(moved.selected, 1);
  assert.equal(menuAction(moved, moved.options[1]?.id ?? "")?.key, "enter");
});

test("cursor on the last contiguous option keeps the footer recognized", () => {
  const last = updateMenu
    .replace("› 1.", "  1.")
    .replace("  3. Skip until next version", "› 3. Skip until next version");
  assert.equal(showsStartupMenu(last), true);
  const menu = nativeMenu(last);
  assert.ok(menu);
  assert.equal(menu.options[menu.selected]?.label, labels[2]);
});

test("idle codex with the update menu normalizes to blocked and stays startup scoped", async () => {
  const client = new ScreenClient();
  assert.equal((await client.normalize(raw)).status, "blocked");
  assert.equal(
    (await client.normalize({ ...raw, agent_session: { kind: "id", value: "session-1" } })).status,
    "idle",
  );
  client.truncated = true;
  assert.equal((await client.normalize(raw)).status, "idle");
});

test("task text is refused by the real update menu without any native write", async () => {
  const client = new ScreenClient();
  await assert.rejects(new AgentControl(client).send(ref, "task prompt"), (error) => {
    assert.equal((error as OperationError).code, "approval_required");
    return true;
  });
  assert.deepEqual(client.prompts, []);
  assert.deepEqual(client.strokes, []);
});

test("a normal composer and cursor-less or footer-less screens are not startup menus", () => {
  const composer = [
    "Numbered history that is not a menu",
    "1. First reply",
    "2. Second reply",
    "› Ask Codex anything",
    "  gpt-5.6-sol high · ~/code",
  ].join("\n");
  assert.equal(showsStartupMenu(composer), false);
  assert.equal(showsDialog(composer), false);
  assert.deepEqual(parseOptions(composer), []);
  // The legacy footer still qualifies an old captured startup menu.
  const legacy = `${updateMenu.replace("  enter continue · esc skip", "Press enter to continue")}`;
  assert.equal(showsStartupMenu(legacy), true);
  for (const text of [
    updateMenu.replace("› 1.", "  1."),
    updateMenu.replace("\n\n  enter continue · esc skip", ""),
    `${updateMenu}\n› Ask Codex anything`,
    updateMenu.replace("esc skip", "esc arbitrary"),
  ]) {
    assert.equal(showsStartupMenu(text), false, text);
    assert.equal(showsDialog(text), false, text);
  }
});
