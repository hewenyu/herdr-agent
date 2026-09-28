import assert from "node:assert/strict";
import test from "node:test";
import { AutomaticApprovals } from "../../src/app/automatic-approvals.js";
import { OperationError } from "../../src/core/errors.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { ActorContext, AgentScreen, Participant, Task } from "../../src/core/types.js";
import { screenFingerprint } from "../../src/herdr/screen.js";
import { deferred, logger, message, setup } from "./helpers.js";

async function fixture() {
  const h = setup();
  const created = (await h.app.dispatch("task.create", {
    kind: "development",
    title: "菜单自动选择",
    requirements: "在项目内实现并验证功能。",
    participants: [{ kind: "claude" }],
    orchestration: { mode: "manual" },
  })) as Task;
  await h.app.tasks.reconcile(created.id);
  const task = h.store.get<Task>("tasks", created.id);
  assert.ok(task);
  const participant = h.app.tasks.records.participants(task)[0] as Participant;
  assert.ok(participant.execution);
  const agent = h.herdr.agents.get(participant.execution.paneId);
  assert.ok(agent);
  agent.status = "blocked";
  agent.terminalId = "native-terminal-1";
  participant.status = "blocked";
  h.app.tasks.records.saveParticipant(participant);
  const screen: AgentScreen = {
    agent: { ...agent },
    text: "Permission dialog v999\n❯ Allow once\n  Cancel\nConfirm with Enter",
    question: "Permission dialog v999",
    source: "visible",
    truncated: false,
    options: [
      { key: "up", label: "上移" },
      { key: "down", label: "下移" },
      { key: "enter", label: "确认当前项" },
    ],
  };
  h.herdr.screen = async () => structuredClone(screen);
  const actor: ActorContext = {
    ownerId: task.ownerId,
    chatId: task.chatId ?? "entry",
    sessionId: "approval",
    taskId: task.id,
    messageId: "blocked",
  };
  const writes: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  let candidate = "key:enter";
  let confidence = 0.98;
  let beforeResponse: (() => void | Promise<void>) | undefined;
  let writeFailure: OperationError | undefined;
  (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
    await guard.beforeWrite?.();
    guard.assertCurrent?.();
    assert.equal(guard?.screenFingerprint, screenFingerprint(screen.text));
    assert.equal(guard?.terminalId, "native-terminal-1");
    if (writeFailure?.outcome === "not_executed") throw writeFailure;
    writes.push(key ?? "");
    if (writeFailure) throw writeFailure;
    if (key === "down")
      screen.text = screen.text.replace("❯ Allow once\n  Cancel", "  Allow once\n❯ Cancel");
    else {
      screen.text = "Agent resumed";
      screen.agent.status = "working";
    }
  };
  h.engine.handler = async () => {
    throw new Error("pi must not run for accepted Jev choice");
  };
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    await beforeResponse?.();
    const ids = Object.keys(body.questions.action.criteria);
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          action: {
            type: "choice",
            choice: candidate,
            confidence,
            probabilities: Object.fromEntries(ids.map((id) => [id, id === candidate ? 1 : 0])),
          },
        },
        usage: { input_tokens: 30, output_tokens: 10 },
      }),
      { status: 200 },
    );
  };
  let enabled = true;
  const abort = new AbortController();
  const controller = () =>
    new AutomaticApprovals({
      store: h.store,
      herdr: h.herdr,
      approvals: h.app.approvals,
      engine: h.engine,
      logger,
      signal: abort.signal,
      config: () => (enabled ? { apiKey: "fixture-secret" } : undefined),
      fetch: fetchImpl,
    });
  return {
    ...h,
    task,
    participant,
    screen,
    actor,
    writes,
    requests,
    controller,
    fetchImpl,
    disable: () => {
      enabled = false;
    },
    abort,
    choose: (value: string, probability = 0.98) => {
      candidate = value;
      confidence = probability;
    },
    before: (run: () => void | Promise<void>) => {
      beforeResponse = run;
    },
    failWrite: (error: OperationError) => {
      writeFailure = error;
    },
    handle: () => controller().handle(task, participant, structuredClone(screen), actor),
  };
}

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

test("successful confirmation observes another menu at the same stateSeq", async () => {
  const h = await fixture();
  try {
    (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
      await guard.beforeWrite?.();
      h.writes.push(key);
      h.screen.text = `Different permission step ${h.writes.length}\n❯ Allow step ${h.writes.length}\n  Cancel`;
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
    h.choose("key:enter", 0.3);
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

test("a crash after effect reservation freezes automatic writes even on a later menu", async () => {
  const h = await fixture();
  try {
    h.choose("wait_user");
    await h.handle();
    const entry = h.store.entries<Record<string, unknown>>("automatic_approval_decisions")[0];
    assert.ok(entry);
    const [id, decision] = entry;
    h.store.set("automatic_approval_decisions", id, { ...decision, state: "executing" });
    h.screen.agent.stateSeq = "100";
    h.screen.text = "Next menu";
    h.choose("key:enter");
    assert.equal(await h.handle(), "manual");
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.writes, []);
  } finally {
    await h.close();
  }
});

test("navigation loops yield to the user across restarts without discussion round limits", async () => {
  const h = await fixture();
  try {
    const first = h.screen.text;
    h.choose("key:down");
    (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
      await guard.beforeWrite?.();
      h.writes.push(key);
      h.screen.text = h.screen.text === first ? "❯ Cancel\n  Allow once" : first;
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

test("stale screen rejected without an effect can select a fresh observation", async () => {
  const h = await fixture();
  try {
    let first = true;
    (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
      await guard.beforeWrite?.();
      if (first) {
        first = false;
        h.screen.text = "Changed menu\n❯ Confirm\n  Cancel";
        throw new OperationError("stale_guard", "screen changed");
      }
      h.writes.push(key);
      h.screen.agent.status = "working";
    };
    assert.equal(await h.handle(), "manual");
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
      h.choose("key:down");
      await h.app.tasks.reconcile(h.task.id);
      h.choose("key:enter");
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
    h.choose("key:down");
    assert.equal(await h.handle(), "handled");
    assert.match(h.screen.text, /❯ Cancel/);
    h.choose("key:enter");
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
    h.choose("key:enter", 0.4);
    h.engine.handler = async (input) => {
      assert.equal(input.tools[0]?.name, "approval_decide");
      await assert.rejects(
        input.tools[0]?.execute({ candidateId: "shell:rm", reason: "outside" }, input.actor) ??
          Promise.resolve(),
      );
      await input.tools[0]?.execute(
        { candidateId: "key:enter", reason: "已核对当前任务与选中项" },
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
    textOnly.choose("key:enter", 0.4);
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
