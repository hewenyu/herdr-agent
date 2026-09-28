import assert from "node:assert/strict";
import test from "node:test";
import { menuState } from "../../src/herdr/menu-state.js";

test("only native choice rows and selection affect menu proof", () => {
  const menu = "Current question\n❯ Allow once\n  Deny\nEnter to confirm";
  const state = menuState(menu);
  assert.ok(state);
  for (const text of [
    `Log tick 2\n${menu}`,
    `${menu}\nElapsed 00:15`,
    menu.replace("Current question", "Spinner updated"),
  ])
    assert.equal(menuState(text), state);
  assert.notEqual(menuState(menu.replace("❯ Allow once\n  Deny", "  Allow once\n❯ Deny")), state);
  assert.equal(menuState("No recoverable choice rows, press a key"), undefined);
});

test("complete numbered menu changes exclude unrelated terminal output", () => {
  const menu = "Question\n❯ 1. Allow once\n  2. Deny\nEnter to select · Esc to cancel";
  const state = menuState(menu);
  assert.ok(state);
  assert.equal(menuState(`Background log changed\n${menu}\nMore logs`), state);
  assert.notEqual(
    menuState(menu.replace("1. Allow once", "1. Approve a different operation")),
    state,
  );
  assert.equal(
    menuState("❯ Allow once\n  Deny\n  Log tick 1"),
    menuState("❯ Allow once\n  Deny\n  Log tick 2"),
  );
});
