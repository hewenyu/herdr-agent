import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { canonical, stableId } from "../../src/core/ids.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { Task } from "../../src/core/types.js";
import { ApprovalEffectError } from "../../src/herdr/approval-error.js";
import { nativeMenu } from "../../src/herdr/native-menu.js";
import { automaticApprovalFixture as fixture } from "./automatic-approval-helpers.js";
import { deferred, message } from "./helpers.js";

test("Jev confirms changed native text through the existing approval nonce without pi or cards", async () => {
  const h = await fixture();
  try {
    h.screen.text = `user@host project % claude --add-dir ${h.directory}\n\nA completely redesigned folder gate\n❯ Trust once\n  Leave\nEnter to select`;
    assert.equal(await h.handle(), "handled");
    assert.deepEqual(h.writes, ["enter"]);
    assert.equal(h.platform.cards.length, 0);
    const decision = h.store.list<{
      state: string;
      selection: { source: string };
      approvalNonce: string;
    }>("automatic_approval_decisions")[0];
    assert.equal(decision?.state, "executed");
    assert.equal(decision?.selection.source, "jev");
    assert.equal(
      h.store.get<{ consumed: boolean }>("approvals", decision?.approvalNonce ?? "")?.consumed,
      true,
    );
    assert.equal(await h.handle(), "manual");
    assert.deepEqual(h.writes, ["enter"], "recreated controller cannot repeat the effect");
  } finally {
    await h.close();
  }
});

test("pi selects the Claude trust target; its incorrect cursor explanation cannot press Enter on No", async () => {
  const h = await fixture();
  try {
    h.screen.text = await readFile(
      new URL("../fixtures/native/claude-directory-trust.txt", import.meta.url),
      "utf8",
    );
    h.choose("option:2", 0.39);
    h.engine.handler = async (input) => {
      await input.tools[0]?.execute(
        {
          candidateId: nativeMenu(h.screen.text)?.options[1]?.id,
          reason: "当前已选中 Yes，直接确认",
        },
        input.actor,
      );
      return { text: "Selected", messages: [] };
    };
    (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
      await guard.beforeWrite?.();
      h.writes.push(key);
      if (key === "down")
        h.screen.text = h.screen.text.replace(
          " ❯ No, exit\n   Yes, I trust this folder",
          "   No, exit\n ❯ Yes, I trust this folder",
        );
      else h.screen.agent.status = "working";
    };
    assert.equal(await h.handle(), "handled");
    assert.deepEqual(h.writes, ["down"]);
    assert.match(h.screen.text, /❯ Yes, I trust this folder/);
    assert.equal(await h.handle(), "handled");
    assert.deepEqual(h.writes, ["down", "enter"]);
    const decisions = h.store.list<{ selection: { source: string }; action: { key: string } }>(
      "automatic_approval_decisions",
    );
    assert.ok(decisions.every((entry) => entry.selection.source === "pi"));
    assert.deepEqual(decisions.map((entry) => entry.action.key).sort(), ["down", "enter"]);
  } finally {
    await h.close();
  }
});

test("approval authorization uses bound user text rather than requirements invented by pi", async () => {
  const h = await fixture();
  try {
    h.task.requirements = "模型错误摘要：不要自动确认。";
    h.task.userRequest = {
      source: "feishu",
      ownerId: h.task.ownerId,
      sessionId: "s1",
      chatId: h.actor.chatId,
      messageId: "m1",
      eventId: "e1",
      text: "请在项目中完成这项功能。",
    };
    h.task.requestContext = [
      {
        ...h.task.userRequest,
        messageId: "earlier-user",
        text: "沿用之前要求：只设计，不开发业务代码。",
      },
    ];
    h.app.tasks.records.save(h.task);
    assert.equal(await h.handle(), "handled");
    const state = h.requests[0]?.state as { userInput: Record<string, unknown> };
    assert.equal(state.userInput.source, "user_request");
    assert.equal(state.userInput.request, h.task.userRequest.text);
    assert.deepEqual(state.userInput.context, [
      { messageId: "earlier-user", text: "沿用之前要求：只设计，不开发业务代码。" },
    ]);
    assert.equal(JSON.stringify(state).includes("模型错误摘要"), false);
  } finally {
    await h.close();
  }
});

test("real logger retains actual input and failure phase without leaking selector or cause prose", async () => {
  const h = await fixture();
  try {
    h.choose("option:1", 0.39);
    h.engine.handler = async (input) => {
      await input.tools[0]?.execute(
        {
          candidateId: nativeMenu(h.screen.text)?.options[0]?.id,
          reason: "private-selector-details",
        },
        input.actor,
      );
      return { text: "Selected", messages: [] };
    };
    h.failWrite(
      new ApprovalEffectError(
        "input_unconfirmed",
        "private-native-details",
        "identity",
        "input_effect_unknown",
        new OperationError("agent_not_found", "private-cause-details"),
      ),
    );
    assert.equal(await h.handle(), "manual");
    const logs = h.logLines.map((line) => JSON.parse(line));
    const selected = logs.find((entry) => entry.event === "approval.automatic_selected");
    const failed = logs.find((entry) => entry.event === "approval.automatic_failed");
    assert.equal(selected?.source, "pi");
    assert.equal(selected?.jevConfidence, 0.39);
    assert.equal(selected?.pressed, "enter");
    assert.equal(failed?.pressed, "enter");
    assert.equal(failed?.failurePhase, "identity");
    assert.equal(failed?.causeCode, "agent_not_found");
    assert.equal(failed?.readbackReason, "input_effect_unknown");
    assert.ok(!h.logLines.join("\n").includes("private-"));
  } finally {
    await h.close();
  }
});

test("explicit y/n can advance to a different native control through shared approval readback", async () => {
  const h = await fixture();
  try {
    h.screen.text = "Read project? [y/N]";
    (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
      await guard.beforeWrite?.();
      h.writes.push(key);
      if (key === "y") h.screen.text = "Permission\n❯ Allow once\n  Cancel\nEnter to confirm";
      else h.screen.agent.status = "working";
    };
    assert.equal(await h.handle(), "handled");
    assert.equal(await h.handle(), "handled");
    assert.deepEqual(h.writes, ["y", "enter"]);
  } finally {
    await h.close();
  }
});

test("changed question or countdown on the same y/n control cannot prove an input effect", async () => {
  const h = await fixture();
  try {
    h.screen.text = "Read project, 10 seconds left? [y/N]";
    (h.herdr as HerdrPort).answer = async (_ref, key) => {
      h.writes.push(key);
      h.screen.text = "Read project, 9 seconds left? [y/N]";
    };
    assert.equal(await h.handle(), "manual");
    assert.equal(await h.handle(), "manual");
    assert.deepEqual(h.writes, ["y"]);
    const decision = h.store.list<{ state: string; error: string }>(
      "automatic_approval_decisions",
    )[0];
    assert.equal(decision?.state, "uncertain");
    assert.equal(decision?.error, "approval_refresh_required");
  } finally {
    await h.close();
  }
});

test("unrecognized menus and model-generated raw keys cannot write native input", async () => {
  const h = await fixture();
  try {
    h.choose("key:enter");
    h.engine.handler = async () => ({ text: "Press Enter", messages: [] });
    assert.equal(await h.handle(), "pending");
    assert.deepEqual(h.writes, []);
    h.screen.text = "Sign in\nEnter the unknown password to continue:";
    h.screen.agent.stateSeq = "unrecognized";
    assert.equal(await h.handle(), "manual");
    assert.deepEqual(h.writes, []);
  } finally {
    await h.close();
  }
});

test("upgrading a v1 raw-key decision preserves its waiting-user budget and never replays it", async () => {
  const h = await fixture();
  try {
    h.choose("wait_user");
    assert.equal(await h.handle(), "manual");
    const entry = h.store.entries<{
      id: string;
      approvalNonce: string;
      inputRevision: string;
      userRevision: string;
      observation: { userInput: Record<string, unknown> };
      candidates: unknown[];
    }>("automatic_approval_decisions")[0];
    assert.ok(entry);
    const [id, decision] = entry;
    const legacyInput = {
      ...Object.fromEntries(
        Object.entries(decision.observation.userInput).filter(([key]) => key !== "source"),
      ),
      requirements: h.task.requirements,
      boardDirectory: h.task.boardDirectory,
    };
    assert.equal(decision.userRevision, stableId(canonical(legacyInput)));
    const legacyId = stableId("native-approval-v1", decision.approvalNonce, decision.inputRevision);
    h.store.delete("automatic_approval_decisions", id);
    h.store.set("automatic_approval_decisions", legacyId, {
      ...decision,
      id: legacyId,
      observation: { ...decision.observation, userInput: legacyInput },
      candidates: [
        { id: "key:enter", description: "Confirm" },
        { id: "wait_user", description: "Wait" },
      ],
    });
    h.choose("option:1");
    assert.equal(await h.handle(), "manual");
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.writes, []);
  } finally {
    await h.close();
  }
});

test("successful confirmation observes another menu at the same stateSeq", async () => {
  const h = await fixture();
  try {
    (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
      await guard.beforeWrite?.();
      h.writes.push(key);
      h.screen.text = `Different permission step ${h.writes.length}\n❯ Allow step ${h.writes.length}\n  Cancel\nEnter to select`;
    };
    assert.equal(await h.handle(), "handled");
    assert.equal(await h.handle(), "handled");
    assert.deepEqual(h.writes, ["enter", "enter"]);
    assert.equal(h.store.list("automatic_approval_decisions").length, 2);
  } finally {
    await h.close();
  }
});

test("no-selection retries keep backoff and attempt budget across controller reconstruction", async () => {
  const h = await fixture();
  try {
    h.choose("option:1", 0.3);
    h.engine.handler = async () => ({ text: "已确认", messages: [] });
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(await h.handle(), attempt === 3 ? "manual" : "pending");
      assert.equal(h.requests.length, attempt);
      const entry = h.store.entries<{ attempts: number; retryAt?: string }>(
        "automatic_approval_decisions",
      )[0];
      assert.ok(entry);
      const [id, decision] = entry;
      assert.equal(decision.attempts, attempt);
      assert.equal(await h.handle(), attempt === 3 ? "manual" : "pending");
      assert.equal(h.requests.length, attempt);
      if (attempt < 3)
        h.store.set("automatic_approval_decisions", id, {
          ...decision,
          retryAt: "2000-01-01T00:00:00.000Z",
        });
    }
    assert.deepEqual(h.writes, []);
  } finally {
    await h.close();
  }
});

for (const legacy of [false, true]) {
  for (const state of ["executing", "uncertain"]) {
    test(`a ${legacy ? "legacy" : "current"} ${state} effect freezes automatic writes on a later menu`, async () => {
      const h = await fixture();
      try {
        h.choose("wait_user");
        await h.handle();
        const entry = h.store.entries<Record<string, unknown>>("automatic_approval_decisions")[0];
        assert.ok(entry);
        const [id, decision] = entry;
        if (legacy) delete decision.generation;
        h.store.set("automatic_approval_decisions", id, { ...decision, state });
        h.screen.agent.stateSeq = "100";
        h.screen.text = h.screen.text.replace("v999", "v1000");
        h.choose("option:1");
        assert.equal(await h.handle(), "manual");
        assert.equal(h.requests.length, 1);
        assert.deepEqual(h.writes, []);
      } finally {
        await h.close();
      }
    });
  }
}

for (const menu of [
  "Permission\n> 1. Allow once\n  2. Cancel\nEnter to select",
  "Permission\n❯ Allow once\n  Cancel\nEnter to select",
  "Permission: allow once? [y/N]",
  "Permission\n> 1. Allow once (expires in {clock}s)\n  2. Cancel\nEnter to select",
  "Permission\n❯ Allow once (expires in {clock}s)\n  Cancel\nEnter to select",
]) {
  for (const failure of ["stale_guard", "no_selection"] as const) {
    test(`${failure} keeps cooldown and budget across volatile screens and nonces: ${menu.split("\n")[0]}`, async (t) => {
      const h = await fixture();
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      try {
        let clock = 0;
        const changeScreen = () => {
          h.screen.text = `Clock/spinner/log ${++clock}\n${menu.replace("{clock}", String(60 - clock))}`;
          h.screen.agent.stateSeq = String(clock);
        };
        changeScreen();
        if (failure === "stale_guard") {
          (h.herdr as HerdrPort).answer = async () => {
            changeScreen();
            throw new OperationError("stale_guard", "screen changed before write");
          };
        } else {
          h.choose("option:1", 0.3);
          h.engine.handler = async () => ({ text: "No tool selection", messages: [] });
        }
        for (let attempt = 1; attempt <= 3; attempt++) {
          assert.equal(
            await h.handle(),
            failure === "stale_guard" || attempt === 3 ? "manual" : "pending",
          );
          assert.equal(h.requests.length, attempt);
          changeScreen();
          assert.equal(await h.handle(), attempt === 3 ? "manual" : "pending");
          assert.equal(h.requests.length, attempt, "new nonce cannot skip persistent cooldown");
          t.mock.timers.tick(30_001);
        }
        for (let observation = 0; observation < 4; observation++) {
          changeScreen();
          assert.equal(await h.handle(), "manual");
        }
        assert.equal(h.requests.length, 3, "reconstructed controllers cannot replenish attempts");
        assert.deepEqual(h.writes, []);
        const decisions = h.store.list<{
          attempts: number;
          retryIdentity: string;
          approvalNonce: string;
        }>("automatic_approval_decisions");
        assert.deepEqual(decisions.map((d) => d.attempts).sort(), [1, 2, 3]);
        assert.equal(new Set(decisions.map((d) => d.approvalNonce)).size, 3);
        assert.equal(new Set(decisions.map((d) => d.retryIdentity)).size, 1);
      } finally {
        await h.close();
      }
    });
  }
}

test("confirmed menu progress starts a fresh retry budget even when an earlier menu returns", async (t) => {
  const h = await fixture();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const first = h.screen.text;
    let calls = 0;
    (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
      await guard.beforeWrite?.();
      if (++calls <= 2) {
        h.screen.text = `Clock ${calls}\n${first}`;
        throw new OperationError("stale_guard", "screen changed before write");
      }
      h.writes.push(key);
      h.screen.text = calls % 2 ? "  Allow once\n❯ Cancel\nEnter to select" : first;
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(await h.handle(), "manual");
      t.mock.timers.tick(30_001);
    }
    for (let step = 0; step < 3; step++) assert.equal(await h.handle(), "handled");
    const executed = h.store
      .list<{ state: string; attempts: number }>("automatic_approval_decisions")
      .filter((d) => d.state === "executed");
    assert.deepEqual(executed.map((d) => d.attempts).sort(), [1, 1, 3]);
    assert.equal(h.requests.length, 5);
    assert.deepEqual(h.writes, ["enter", "up", "enter"]);
  } finally {
    await h.close();
  }
});

test("verified manual confirmation restores selection for a later identical permission", async (t) => {
  const h = await fixture();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const menu = h.screen.text;
    h.choose("option:1", 0.3);
    h.engine.handler = async () => ({ text: "No tool selection", messages: [] });
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(await h.handle(), attempt < 3 ? "pending" : "manual");
      t.mock.timers.tick(30_001);
    }
    assert.equal(await h.handle(), "manual");
    const [decision] = h.store.list<{ approvalNonce: string }>("automatic_approval_decisions");
    assert.ok(decision);
    await h.app.approvals.answer(
      h.task.ownerId,
      h.task.chatId ?? h.actor.chatId,
      decision.approvalNonce,
      "enter",
    );
    assert.equal(h.screen.agent.status, "working");
    h.screen.agent.status = "blocked";
    h.screen.agent.stateSeq = "later-permission-after-work";
    h.screen.text = menu;
    h.choose("option:1");
    assert.equal(await h.handle(), "handled");
    assert.equal(h.requests.length, 4);
    assert.deepEqual(h.writes, ["enter", "enter"]);
  } finally {
    await h.close();
  }
});

test("navigation loops yield to the user across restarts without discussion round limits", async () => {
  const h = await fixture();
  try {
    const first = h.screen.text;
    h.choose("option:2");
    (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
      await guard.beforeWrite?.();
      h.writes.push(key);
      h.screen.text = h.screen.text === first ? "❯ Cancel\n  Allow once\nEnter to select" : first;
    };
    for (let step = 0; step < 4; step++) assert.equal(await h.handle(), "handled");
    assert.equal(await h.handle(), "manual");
    assert.equal(h.requests.length, 4);
    assert.equal(h.writes.length, 4);
    h.screen.agent.stateSeq = "new-permission-after-work";
    assert.equal(await h.handle(), "handled", "a new permission is not an old navigation cycle");
  } finally {
    await h.close();
  }
});

test("manual confirmation while Jev is choosing consumes the shared nonce first", async () => {
  const h = await fixture();
  try {
    h.before(async () => {
      const [approval] = h.store.list<{ nonce: string }>("approvals");
      assert.ok(approval);
      assert.ok(h.task.chatId);
      await h.app.approvals.answer(h.task.ownerId, h.task.chatId, approval.nonce, "enter");
    });
    assert.equal(await h.handle(), "manual");
    assert.deepEqual(h.writes, ["enter"]);
  } finally {
    await h.close();
  }
});

test("stale screen rejected without an effect can select a fresh observation after cooldown", async (t) => {
  const h = await fixture();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    let first = true;
    (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
      await guard.beforeWrite?.();
      if (first) {
        first = false;
        h.screen.text = "Changed menu\n❯ Confirm\n  Cancel\nEnter to select";
        throw new OperationError("stale_guard", "screen changed");
      }
      h.writes.push(key);
      h.screen.agent.status = "working";
    };
    assert.equal(await h.handle(), "manual");
    assert.equal(await h.handle(), "pending");
    t.mock.timers.tick(30_001);
    assert.equal(await h.handle(), "handled");
    assert.deepEqual(h.writes, ["enter"]);
    assert.equal(h.requests.length, 2);
  } finally {
    await h.close();
  }
});

for (const enabled of [true, false]) {
  test(`application observes an already-notified blocked participant with automatic approvals ${enabled}`, async (t) => {
    const h = await fixture();
    try {
      assert.ok(h.config.jev);
      h.config.jev = { ...h.config.jev, apiKey: "fixture-secret", approvalsEnabled: enabled };
      t.mock.method(globalThis, "fetch", h.fetchImpl);
      h.participant.initialSent = true;
      h.participant.lastNotifiedState = h.screen.agent.stateSeq;
      h.app.tasks.records.saveParticipant(h.participant);
      h.choose("option:2");
      await h.app.tasks.reconcile(h.task.id);
      h.choose("option:2");
      await h.app.tasks.reconcile(h.task.id);
      assert.deepEqual(h.writes, enabled ? ["down", "enter"] : []);
      assert.equal(h.requests.length, enabled ? 2 : 0);
      assert.equal(h.platform.cards.length, enabled ? 0 : 1);
    } finally {
      await h.close();
    }
  });
}

test("unnumbered menu navigation re-reads selection even when stateSeq does not change", async () => {
  const h = await fixture();
  try {
    h.choose("option:2");
    assert.equal(await h.handle(), "handled");
    assert.match(h.screen.text, /❯ Cancel/);
    h.choose("option:2");
    assert.equal(await h.handle(), "handled");
    assert.deepEqual(h.writes, ["down", "enter"]);
    assert.equal(h.store.list("automatic_approval_decisions").length, 2);
  } finally {
    await h.close();
  }
});

test("low-confidence Jev uses pi only on the same candidates; plain text cannot execute", async () => {
  const h = await fixture();
  try {
    h.choose("option:1", 0.4);
    h.engine.handler = async (input) => {
      assert.equal(input.tools[0]?.name, "approval_decide");
      await assert.rejects(
        input.tools[0]?.execute({ candidateId: "shell:rm", reason: "outside" }, input.actor) ??
          Promise.resolve(),
      );
      await input.tools[0]?.execute(
        {
          candidateId: nativeMenu(h.screen.text)?.options[0]?.id,
          reason: "目标是 Allow once，程序核对游标",
        },
        input.actor,
      );
      return { text: "选择完毕", messages: [] };
    };
    assert.equal(await h.handle(), "handled");
    assert.deepEqual(h.writes, ["enter"]);
    assert.equal(
      h.store.list<{ selection: { source: string } }>("automatic_approval_decisions")[0]?.selection
        .source,
      "pi",
    );
  } finally {
    await h.close();
  }
  const textOnly = await fixture();
  try {
    textOnly.choose("option:1", 0.4);
    textOnly.engine.handler = async () => ({ text: "已自动确认", messages: [] });
    assert.equal(await textOnly.handle(), "pending");
    assert.equal(await textOnly.handle(), "pending");
    assert.equal(textOnly.requests.length, 1);
    assert.deepEqual(textOnly.writes, []);
  } finally {
    await textOnly.close();
  }
});

for (const change of ["pause", "close", "revision", "replace", "disable", "cancel"] as const) {
  test(`scope changes while Jev is choosing cannot execute: ${change}`, async () => {
    const h = await fixture();
    try {
      h.before(() => {
        const task = h.store.get<Task>("tasks", h.task.id);
        assert.ok(task);
        if (change === "pause") task.status = "paused";
        if (change === "close") task.closeRequested = true;
        if (change === "revision")
          h.store.set("task_user_revisions", "new", {
            taskId: task.id,
            source: { ownerId: task.ownerId, text: "用户明确要求等待。" },
            at: new Date().toISOString(),
          });
        h.app.tasks.records.save(task);
        if (change === "replace") {
          assert.ok(h.participant.execution);
          h.app.tasks.records.saveParticipant({
            ...h.participant,
            execution: { ...h.participant.execution, paneId: "another" },
          });
        }
        if (change === "cancel") h.abort.abort();
        if (change === "disable") h.disable();
      });
      assert.equal(await h.handle(), change === "cancel" ? "pending" : "manual");
      assert.deepEqual(h.writes, []);
    } finally {
      await h.close();
    }
  });
}

for (const outcome of ["unknown", "not_executed"] as const) {
  test(`native ${outcome} result is durable and never repeats a key`, async () => {
    const h = await fixture();
    try {
      h.failWrite(new OperationError("write_failed", "fixture", outcome));
      assert.equal(await h.handle(), "manual");
      h.screen.agent.stateSeq = "99";
      h.screen.text = "Another menu on the same native execution";
      if (outcome === "unknown") assert.equal(await h.handle(), "manual");
      assert.equal(h.writes.length, outcome === "unknown" ? 1 : 0);
      assert.equal(h.requests.length, 1);
    } finally {
      await h.close();
    }
  });
}

test("wait_user and incomplete observations make no native write", async () => {
  const h = await fixture();
  try {
    h.screen.truncated = true;
    assert.equal(await h.handle(), "manual");
    assert.equal(h.requests.length, 0);
    h.screen.truncated = false;
    h.choose("wait_user");
    assert.equal(await h.handle(), "manual");
    assert.equal(await h.handle(), "manual");
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.writes, []);
  } finally {
    await h.close();
  }
});

test("an in-flight older card cannot lend its guard to a decision on a different screen", async () => {
  const h = await fixture();
  try {
    assert.ok(h.participant.execution);
    const previous = h.app.approvals.create(
      h.task.ownerId,
      h.task.chatId ?? h.actor.chatId,
      h.participant.execution,
      h.screen,
    );
    h.store.set("approvals", previous.nonce, { ...previous, publication: "sending" });
    h.screen.text = "A different menu while the old card is still publishing";
    assert.equal(await h.handle(), "manual");
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.writes, []);
  } finally {
    await h.close();
  }
});

for (const control of [
  "pause",
  "close",
  "interrupt",
  "remove",
  "add",
  "new-arrangement",
  "stop-service",
  "foreign-pause",
] as const) {
  test(`real queued user control takes priority over a model-selected key: ${control}`, async (t) => {
    const h = await fixture();
    const entered = deferred();
    const release = deferred();
    let reconcile: Promise<void> | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      assert.ok(h.config.jev);
      h.config.jev.apiKey = "fixture-secret";
      t.mock.method(globalThis, "fetch", h.fetchImpl);
      h.before(async () => {
        entered.resolve();
        await release.promise;
      });
      reconcile = h.app.tasks.reconcile(h.task.id);
      await entered.promise;
      const actor = { ...h.actor, messageId: `control:${control}` };
      if (control === "pause" || control === "close")
        pending = h.app.tasks.action(actor, h.task.id, control);
      if (control === "interrupt")
        pending = h.app.tasks.interrupt(actor, h.task.id, h.participant.id);
      if (control === "remove")
        pending = h.app.tasks.removeParticipant(actor, h.task.id, h.participant.id);
      if (control === "add")
        pending = h.app.tasks.addParticipant(actor, h.task.id, {
          kind: "codex",
          role: "先独立复核权限范围",
        });
      if (control === "new-arrangement") {
        // AgentControl refuses prompt pasting while a native menu is blocked.
        h.herdr.sendError = new OperationError("approval_required", "native menu still blocked");
        pending = assert.rejects(
          h.app.tasks.send(
            { ...actor, source: "web" },
            h.task.id,
            h.participant.id,
            "不要确认权限，等待我的安排。",
          ),
          { code: "approval_required" },
        );
      }
      if (control === "stop-service") h.app.tasks.stop();
      if (control === "foreign-pause") {
        await assert.rejects(
          h.app.tasks.action({ ...actor, ownerId: "foreign" }, h.task.id, "pause"),
          { code: "unauthorized" },
        );
        assert.equal(h.app.tasks.approvalsBlocked(h.task.id), false);
      } else assert.equal(h.app.tasks.approvalsBlocked(h.task.id), true);
      release.resolve();
      await reconcile;
      await pending;
      assert.deepEqual(h.writes, control === "foreign-pause" ? ["enter"] : []);
      if (control === "pause") {
        assert.equal(h.store.get<Task>("tasks", h.task.id)?.status, "paused");
        await h.app.tasks.action(
          { ...actor, messageId: "resume-after-pause" },
          h.task.id,
          "resume",
        );
        await h.app.tasks.reconcile(h.task.id);
        assert.deepEqual(
          h.writes,
          ["enter"],
          "explicit resume can choose again after a proven no-effect cancellation",
        );
      }
    } finally {
      release.resolve();
      await Promise.allSettled([reconcile, pending]);
      await h.close();
    }
  });
}

for (const event of ["task-complete", "group-dissolved", "normal-update", "unrelated"] as const) {
  for (const admitted of [false, true]) {
    test(`durable remote lifecycle ${event} vetoes automatic input before task-lock admission=${admitted}`, async (t) => {
      const h = await fixture();
      const entered = deferred();
      const release = deferred();
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      let reconcile: Promise<void> | undefined;
      let drain: Promise<void> | undefined;
      let dissolved = false;
      Object.assign(h.platform, {
        getGroupStatus: async () => (dissolved ? "dissolved" : "normal"),
      });
      try {
        assert.ok(h.config.jev && h.task.chatId && h.task.remoteTaskId);
        h.config.jev.apiKey = "fixture-secret";
        t.mock.method(globalThis, "fetch", h.fetchImpl);
        h.before(async () => {
          entered.resolve();
          await release.promise;
        });
        reconcile = h.app.tasks.reconcile(h.task.id);
        await entered.promise;
        if (event === "group-dissolved") {
          dissolved = true;
          await h.app.handlers().groupChanged?.(h.task.chatId);
        } else {
          if (event === "task-complete") {
            const remote = h.platform.tasks.get(h.task.remoteTaskId);
            assert.ok(remote);
            remote.completedAt = String(Date.now());
          }
          await h.app
            .handlers()
            .taskChanged(event === "unrelated" ? "another-task" : h.task.remoteTaskId);
        }
        if (admitted) drain = h.app.inbox.drain();
        release.resolve();
        await reconcile;
        await drain;
        assert.deepEqual(h.writes, event === "unrelated" ? ["enter"] : []);
        if (!admitted) await h.app.inbox.drain();
        if (event === "task-complete" || event === "group-dissolved") {
          const current = h.store.get<Task>("tasks", h.task.id);
          assert.ok(current && ["completed", "destroyed"].includes(current.status));
          assert.equal(h.herdr.closes, 1);
        }
        if (event === "normal-update") {
          await h.app.tasks.reconcile(h.task.id);
          assert.deepEqual(h.writes, [], "harmless ingress cannot skip the existing cooldown");
          t.mock.timers.tick(30_001);
          await h.app.tasks.reconcile(h.task.id);
          assert.deepEqual(
            h.writes,
            ["enter"],
            "a processed harmless update cannot freeze a no-effect choice",
          );
        }
      } finally {
        release.resolve();
        await Promise.allSettled([reconcile, drain]);
        await h.close();
      }
    });
  }
}

for (const type of ["task", "group"] as const) {
  for (const failure of ["no_selection", "stale_guard"] as const) {
    test(`processed harmless ${type} events preserve ${failure} cooldown and budget`, async (t) => {
      const h = await fixture();
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      try {
        const id = type === "task" ? h.task.remoteTaskId : h.task.chatId;
        assert.ok(id && h.config.jev);
        h.config.jev.apiKey = "fixture-secret";
        t.mock.method(globalThis, "fetch", h.fetchImpl);
        if (failure === "no_selection") {
          h.choose("option:1", 0.3);
          h.engine.handler = async () => ({ text: "No tool selection", messages: [] });
        } else {
          let calls = 0;
          (h.herdr as HerdrPort).answer = async () => {
            if (++calls <= 3) throw new OperationError("stale_guard", "screen changed");
            h.writes.push("enter");
            h.screen.agent.status = "working";
          };
        }
        let events = 0;
        const notification = async () => {
          // Distinct durable envelopes use the same real lifecycle worker.
          assert.equal(h.app.inbox.enqueue(type, `${id}:notice:${++events}`, { id }), true);
          assert.equal(await h.handle(), "manual", "pending ingress remains a write veto");
          await h.app.inbox.drain();
        };
        for (let attempt = 1; attempt <= 3; attempt++) {
          await h.handle();
          assert.equal(h.requests.length, attempt);
          await notification();
          assert.equal(await h.handle(), attempt < 3 ? "pending" : "manual");
          assert.equal(h.requests.length, attempt, "processed ingress cannot skip cooldown");
          t.mock.timers.tick(30_001);
        }
        for (let event = 0; event < 3; event++) {
          await notification();
          assert.equal(await h.handle(), "manual");
        }
        assert.equal(h.requests.length, 3, "processed ingress cannot replenish attempts");
        assert.deepEqual(h.writes, []);
        const decisions = h.store.list<{ attempts: number; retryIdentity: string }>(
          "automatic_approval_decisions",
        );
        assert.deepEqual(decisions.map((d) => d.attempts).sort(), [1, 2, 3]);
        assert.equal(new Set(decisions.map((d) => d.retryIdentity)).size, 1);
        // An explicit user resume is semantic input and may start another epoch.
        await h.app.tasks.action({ ...h.actor, messageId: "pause-budget" }, h.task.id, "pause");
        await h.app.tasks.action({ ...h.actor, messageId: "resume-budget" }, h.task.id, "resume");
        h.choose("option:1");
        assert.equal(await h.handle(), "handled");
        assert.equal(h.requests.length, 4);
        assert.deepEqual(h.writes, ["enter"]);
      } finally {
        await h.close();
      }
    });
  }
}

test("harmless lifecycle ingress cannot clear successful navigation-loop history", async () => {
  const h = await fixture();
  try {
    assert.ok(h.task.remoteTaskId);
    const first = h.screen.text;
    h.choose("option:2");
    (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
      await guard.beforeWrite?.();
      h.writes.push(key);
      h.screen.text = h.screen.text === first ? "❯ Cancel\n  Allow once\nEnter to select" : first;
    };
    for (let step = 0; step < 4; step++) {
      h.app.inbox.enqueue("task", `loop-notice:${step}`, { id: h.task.remoteTaskId });
      await h.app.inbox.drain();
      assert.equal(await h.handle(), "handled");
    }
    h.app.inbox.enqueue("task", "loop-notice:last", { id: h.task.remoteTaskId });
    await h.app.inbox.drain();
    assert.equal(await h.handle(), "manual");
    assert.equal(h.requests.length, 4);
    assert.equal(h.writes.length, 4);
  } finally {
    await h.close();
  }
});

test("lifecycle ingress processed during selection still invalidates that pending choice", async () => {
  const h = await fixture();
  try {
    assert.ok(h.task.remoteTaskId);
    h.engine.handler = async () => ({ text: "Observed", messages: [] });
    h.before(async () => {
      await h.app.handlers().taskChanged(h.task.remoteTaskId as string);
      await h.app.inbox.drain();
    });
    assert.equal(await h.handle(), "manual");
    assert.deepEqual(h.writes, []);
    assert.equal(h.requests.length, 1);
    assert.equal(
      h.store.list<{ error: string }>("automatic_approval_decisions")[0]?.error,
      "approval_scope_changed",
    );
    assert.ok(h.store.list<{ state: string }>("inbox").every((r) => r.state === "done"));
  } finally {
    await h.close();
  }
});

test("accepted owner message vetoes a choice even before the inbox model interprets it", async () => {
  const h = await fixture();
  try {
    h.before(() =>
      h.app.handlers().message(message("urgent-pause", "先暂停，不要确认权限", h.task.chatId)),
    );
    assert.equal(await h.handle(), "manual");
    assert.deepEqual(h.writes, []);
  } finally {
    await h.close();
  }
});

test("an acknowledged key with only background output cannot reopen an automatic nonce", async () => {
  const h = await fixture();
  try {
    (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
      await guard.beforeWrite?.();
      guard.assertCurrent?.();
      h.writes.push(key);
      h.screen.text = `Log tick ${h.writes.length}\n${h.screen.text}\nElapsed 00:01`;
    };
    assert.equal(await h.handle(), "manual");
    h.screen.agent.stateSeq = "200";
    assert.equal(await h.handle(), "manual");
    assert.deepEqual(h.writes, ["enter"]);
    assert.equal(
      h.store.list<{ state: string }>("automatic_approval_decisions")[0]?.state,
      "uncertain",
    );
  } finally {
    await h.close();
  }
});
