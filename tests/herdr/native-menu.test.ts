import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { approvalCandidates } from "../../src/app/approval-choice.js";
import { OperationError } from "../../src/core/errors.js";
import type { AgentKind, AgentSnapshot, ExecutionRef } from "../../src/core/types.js";
import { approvalFailureEvidence } from "../../src/herdr/approval-error.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { AgentControl } from "../../src/herdr/control.js";
import { menuState } from "../../src/herdr/menu-state.js";
import { menuAction, nativeMenu } from "../../src/herdr/native-menu.js";
import { screenFingerprint } from "../../src/herdr/screen.js";
import { HerdrTransport } from "../../src/herdr/transport.js";

const codex = await readFile(
  new URL("../fixtures/native/codex-folder-access.txt", import.meta.url),
  "utf8",
);
const claude = await readFile(
  new URL("../fixtures/native/claude-directory-trust.txt", import.meta.url),
  "utf8",
);

test("real Codex numbered trust menu compiles target 1 to Enter, not the numeral", () => {
  const menu = nativeMenu(codex);
  assert.ok(menu);
  assert.equal(menu.options[menu.selected]?.label, "Trust and continue");
  const target = menu.options[0];
  assert.ok(target);
  assert.equal(menuAction(menu, target.id)?.key, "enter");
  assert.deepEqual(
    approvalCandidates(menu).map((candidate) => candidate.description),
    [
      "Trust and continue",
      "Back to Agent Command Center",
      "缺少必要信息或无法确定当前选项含义，保留现场交给用户。",
    ],
  );
  assert.ok(approvalCandidates(menu).every((candidate) => !candidate.id.startsWith("key:")));
});

test("real Claude default No requires navigation and a fresh selected Yes before Enter", () => {
  const before = nativeMenu(claude);
  assert.ok(before);
  assert.equal(before.options[before.selected]?.label, "No, exit");
  const target = before.options[1];
  assert.ok(target);
  assert.equal(menuAction(before, target.id)?.key, "down");
  const after = nativeMenu(
    claude.replace(
      " ❯ No, exit\n   Yes, I trust this folder",
      "   No, exit\n ❯ Yes, I trust this folder",
    ),
  );
  assert.ok(after);
  assert.equal(after.options[after.selected]?.id, target.id);
  assert.equal(menuAction(after, target.id)?.key, "enter");
});

for (const footer of [
  "Enter to select",
  "Confirm with Enter",
  "Use arrows, then Enter",
  "↑/↓ to navigate · Enter to confirm · Esc to cancel",
]) {
  test(`changed wording retains semantic targets with explicit hint: ${footer}`, () => {
    const screen = `Project access — redesigned menu\nRead the project files?\n❯ Permit for this task\n  Leave this workspace\n${footer}`;
    const menu = nativeMenu(screen);
    assert.ok(menu);
    assert.equal(menuAction(menu, menu.options[0]?.id ?? "")?.key, "enter");
    const changed = nativeMenu(
      screen.replace("Permit for this task", "Permit everything permanently"),
    );
    assert.ok(changed);
    assert.equal(menuAction(changed, menu.options[0]?.id ?? ""), undefined);
    const numbered = nativeMenu(`Permission\n❯ 1. Allow once\n  2. Cancel\n${footer}`);
    assert.ok(numbered);
    assert.equal(menuAction(numbered, numbered.options[0]?.id ?? "")?.key, "enter");
  });
}

for (const screen of [
  "Read this project? [y/N]",
  "Read this project? [y/N]\nOnly y or n is accepted; Enter declines access.",
]) {
  test(`explicit shortcut prompt maps Yes/No to advertised y/n: ${screen.split("\n")[0]}`, () => {
    const menu = nativeMenu(screen);
    assert.ok(menu);
    assert.equal(menu.selected, 1);
    assert.equal(menuAction(menu, menu.options[0]?.id ?? "")?.key, "y");
    assert.equal(menuAction(menu, menu.options[1]?.id ?? "")?.key, "n");
  });
}

test("unknown fields, duplicate labels, composers, and missing confirmation hints are not invented options", () => {
  for (const screen of [
    "Sign in\nEnter the 6-digit code:\n______\nEnter to submit · Esc to cancel",
    "Permission\n❯ Allow\n  Allow\nEnter to confirm",
    "Permission\n❯ Allow\n  Cancel\nMaybe press a key",
    "History\n> Ask Codex anything\n  More text\nEnter to confirm",
    "Previous prompt? [y/N]\nNow waiting for a password:",
  ])
    assert.equal(nativeMenu(screen), undefined, screen);
});

test("shortcut readback identity ignores question text, countdown, and default changes", () => {
  assert.equal(
    menuState("Read project, 10 seconds left? [y/N]"),
    menuState("Trust hooks, 9 seconds left? [Y/n]"),
  );
  assert.notEqual(
    menuState("Read project? [y/N]"),
    menuState("Permission\n❯ Allow once\n  Cancel\nEnter to confirm"),
  );
});

class Client extends HerdrClient {
  readonly ref: ExecutionRef;
  agent: AgentSnapshot;
  strokes: string[][] = [];
  onKeys?: (keys: string[]) => void;
  constructor(
    kind: AgentKind,
    public text: string,
  ) {
    super(new HerdrTransport("/never-connect-native-menu-test"));
    this.ref = { paneId: "w1:p1", workspaceId: "w1", kind, cwd: "/tmp" };
    this.agent = {
      ...this.ref,
      status: "blocked",
      terminalId: "term1",
      stateSeq: "1",
      interactiveReady: false,
      launchPending: true,
    };
  }
  override async get() {
    return { ...this.agent };
  }
  override async read() {
    return { text: this.text, truncated: false };
  }
  override async keys(_pane: string, keys: string[]) {
    this.strokes.push(keys);
    this.onKeys?.(keys);
  }
  guard() {
    return {
      stateSeq: this.agent.stateSeq,
      terminalId: "term1",
      cwd: "/tmp",
      literalKey: true,
      screenFingerprint: screenFingerprint(this.text),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
}

test("Codex trust confirmation executes the compiled Enter and proves the menu disappeared", async () => {
  const client = new Client("codex", codex);
  client.onKeys = (keys) => {
    // Native folder access does not accept the displayed ordinal as confirmation.
    if (keys.join() === "enter") {
      client.agent.status = "idle";
      client.text = "Ready";
    }
  };
  const menu = nativeMenu(client.text);
  assert.ok(menu);
  const action = menuAction(menu, menu.options[0]?.id ?? "");
  assert.ok(action);
  await new AgentControl(client).answer(client.ref, action.key, client.guard());
  assert.deepEqual(client.strokes, [["enter"]]);
});

test("Claude trust compiles and confirms Down before it is permitted to compile Enter", async () => {
  const client = new Client("claude", claude);
  client.onKeys = (keys) => {
    if (keys.join() === "down")
      client.text = client.text.replace(
        " ❯ No, exit\n   Yes, I trust this folder",
        "   No, exit\n ❯ Yes, I trust this folder",
      );
    if (keys.join() === "enter") {
      if (/❯ No, exit/.test(client.text)) client.agent.status = "gone";
      else {
        client.agent.status = "idle";
        client.text = "Ready";
      }
    }
  };
  const control = new AgentControl(client);
  for (let step = 0; step < 2; step++) {
    const menu = nativeMenu(client.text);
    assert.ok(menu);
    const action = menuAction(menu, menu.options[1]?.id ?? "");
    assert.ok(action);
    await control.answer(client.ref, action.key, client.guard());
  }
  assert.deepEqual(client.strokes, [["down"], ["enter"]]);
  assert.equal(client.agent.status, "idle");
});

test("navigation to an unexpected row stays uncertain and records its readback reason", async () => {
  const client = new Client("claude", "Question\n❯ First\n  Second\n  Third\nEnter to confirm");
  client.onKeys = () => {
    client.text = "Question\n  First\n  Second\n❯ Third\nEnter to confirm";
  };
  await assert.rejects(
    new AgentControl(client).answer(client.ref, "down", client.guard()),
    (error) => {
      assert.equal((error as OperationError).code, "approval_unconfirmed");
      assert.equal(approvalFailureEvidence(error)?.reason, "navigation_target_unconfirmed");
      return true;
    },
  );
  assert.deepEqual(client.strokes, [["down"]]);
});

test("shortcut confirmation can be proven by a distinct cursor menu, but not a changed countdown", async () => {
  const client = new Client("claude", "Read project, 10 seconds left? [y/N]");
  client.onKeys = () => {
    client.text = "Read project, 9 seconds left? [y/N]";
  };
  await assert.rejects(
    new AgentControl(client).answer(client.ref, "y", client.guard()),
    (error) => {
      assert.equal(approvalFailureEvidence(error)?.reason, "menu_unchanged");
      return true;
    },
  );
  // A separate native execution avoids retrying the uncertain input above.
  const next = new Client("claude", "Read project? [y/N]");
  next.onKeys = () => {
    next.text = "Permission\n❯ Allow once\n  Cancel\nEnter to confirm";
  };
  await new AgentControl(next).answer(next.ref, "y", next.guard());
  assert.deepEqual(next.strokes, [["y"]]);
});

test("post-key identity failure records the stage and safe cause rather than blaming the selector", async () => {
  const client = new Client("claude", claude);
  client.onKeys = () => {
    client.get = async () => {
      throw new OperationError("agent_not_found", "private diagnostic text");
    };
  };
  await assert.rejects(
    new AgentControl(client).answer(client.ref, "enter", client.guard()),
    (error) => {
      assert.equal((error as OperationError).code, "input_unconfirmed");
      assert.deepEqual(approvalFailureEvidence(error), {
        phase: "identity",
        reason: "input_effect_unknown",
        causeCode: "agent_not_found",
      });
      return true;
    },
  );
  assert.deepEqual(client.strokes, [["enter"]]);
});
