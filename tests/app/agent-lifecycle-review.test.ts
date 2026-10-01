import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import { OperationError } from "../../src/core/errors.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { ActorContext, Participant, Task } from "../../src/core/types.js";
import { directoryTrustKeys } from "../../src/herdr/screen.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { logger, setup } from "./helpers.js";

/** Independent black-box review: no production store, native RPC, or model network. */
async function fixture(jev: boolean) {
  const h = setup();
  assert.ok(h.config.jev);
  h.config.jev.apiKey = jev ? "review-fixture-only" : "";
  h.config.jev.approvalsEnabled = true;
  const template = await readFile(
    new URL("../fixtures/native/codex-folder-access.txt", import.meta.url),
    "utf8",
  );
  const menu = template.replace("/tmp/myrix-approval/project", h.directory);
  const screens = new Map<string, string>();
  const writes: string[] = [];
  let ordinaryWrites = 0;
  let selectorRequests = 0;
  let failTrust = false;
  let beforeTrust: (() => Promise<void>) | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    selectorRequests++;
    throw new Error("A startup trust gate must not require generic selector networking");
  };
  const start = h.herdr.startAgent.bind(h.herdr);
  h.herdr.startAgent = async (...args) => {
    const agent = await start(...args);
    agent.status = "blocked";
    agent.terminalId = `terminal-${agent.paneId}`;
    delete agent.sessionId;
    screens.set(agent.paneId, menu);
    h.herdr.agents.set(agent.paneId, agent);
    return { ...agent };
  };
  h.herdr.screen = async (ref) => ({
    agent: await h.herdr.get(ref.paneId),
    text: screens.get(ref.paneId) ?? "Codex ready",
    question: "",
    options: [],
    source: "visible",
    truncated: false,
  });
  (h.herdr as HerdrPort).trustDirectory = async (ref, directory, guard) => {
    await beforeTrust?.();
    const checked = guard as typeof guard & {
      beforeWrite?: () => Promise<void>;
      assertCurrent?: () => void;
      terminalId?: string;
    };
    await checked.beforeWrite?.();
    checked.assertCurrent?.();
    if (
      checked.terminalId !== undefined &&
      checked.terminalId !== h.herdr.agents.get(ref.paneId)?.terminalId
    )
      throw new OperationError("agent_replaced", "Terminal changed before native trust write");
    assert.equal(directory, h.directory);
    assert.ok(directoryTrustKeys("codex", screens.get(ref.paneId) ?? "", directory));
    writes.push(ref.paneId);
    if (failTrust) throw new OperationError("readback_lost", "Unknown trust effect", "unknown");
    const agent = h.herdr.agents.get(ref.paneId);
    assert.ok(agent);
    agent.status = "idle";
    agent.stateSeq = String(BigInt(agent.stateSeq) + 1n);
    screens.set(ref.paneId, "Codex ready");
  };
  (h.herdr as HerdrPort).answer = async () => {
    ordinaryWrites++;
  };
  h.engine.handler = async (turn) => {
    const confirm = turn.tools.find((tool) => tool.name === "directory_trust_confirm");
    if (confirm) await confirm.execute({}, turn.actor);
    return { text: '{"notify":false,"text":""}', messages: [] };
  };
  let app = h.app;
  const task = (await app.dispatch("task.create", {
    kind: "development",
    title: "Independent lifecycle review",
    requirements: "Inspect the project, without replaying retired executor input.",
    participants: [{ kind: "codex" }],
    orchestration: { mode: "manual" },
  })) as Task;
  const actor: ActorContext = {
    source: "web",
    ownerId: task.ownerId,
    taskId: task.id,
    chatId: `web:${task.ownerId}`,
    sessionId: "lifecycle-review",
    messageId: "lifecycle-review-control",
  };
  const participant = () => {
    const current = h.store.get<Participant>("participants", task.participantIds[0] ?? "");
    assert.ok(current);
    return current;
  };
  return {
    ...h,
    task,
    actor,
    menu,
    screens,
    writes,
    participant,
    get service() {
      return app.tasks;
    },
    ordinaryWrites: () => ordinaryWrites,
    selectorRequests: () => selectorRequests,
    failTrust: (value: boolean) => {
      failTrust = value;
    },
    beforeTrust: (run: () => Promise<void>) => {
      beforeTrust = run;
    },
    async reconcile(count = 3) {
      for (let i = 0; i < count; i++) await app.tasks.reconcile(task.id);
    },
    async restartApplication() {
      await app.shutdown();
      app = new Application({
        config: h.config,
        store: h.store,
        engine: h.engine,
        herdr: h.herdr,
        platform: h.platform,
        logger,
      });
    },
    async close() {
      globalThis.fetch = originalFetch;
      if (app !== h.app) await app.shutdown();
      await h.close();
    },
  };
}

for (const jev of [false, true]) {
  test(`review: business pause permits first startup and scoped trust without business input (Jev=${jev})`, async () => {
    const h = await fixture(jev);
    try {
      await h.service.action(h.actor, h.task.id, "pause");
      await h.reconcile();
      assert.equal(h.herdr.creates, 1);
      assert.equal(h.herdr.starts, 1);
      assert.equal(h.writes.length, 1);
      assert.equal(h.ordinaryWrites(), 0);
      assert.equal(h.selectorRequests(), 0);
      assert.equal(h.herdr.sends.length, 0);
      assert.equal(h.participant().initialSent, false);
      const task = h.store.get<Task>("tasks", h.task.id);
      assert.equal(task?.status, "paused");
      assert.equal(task?.discussion.paused, true);
    } finally {
      await h.close();
    }
  });

  test(`review: replacement trusts its new execution despite old success and old initial input (Jev=${jev})`, async () => {
    const h = await fixture(jev);
    try {
      await h.reconcile();
      const previous = h.participant();
      assert.ok(previous.execution);
      assert.equal(previous.initialSent, true);
      assert.equal(h.writes.length, 1);
      const sends = h.herdr.sends.length;
      const history = h.store.entries<OperationReceipt>("operations");
      await h.service.action(h.actor, h.task.id, "pause");
      h.herdr.agents.delete(previous.execution.paneId);
      await h.reconcile(4);
      const current = h.participant();
      assert.ok(current.execution);
      assert.notEqual(current.execution.paneId, previous.execution.paneId);
      assert.equal(h.writes.length, 2);
      assert.equal(h.writes[1], current.execution.paneId);
      assert.equal(h.herdr.sends.length, sends, "repair/trust cannot replay old task input");
      assert.equal(current.initialSent, true, "historical delivery fact remains historical");
      assert.equal(current.recoveryPending, true);
      assert.equal(h.store.get<Task>("tasks", h.task.id)?.status, "paused");
      assert.equal(h.store.get<Task>("tasks", h.task.id)?.discussion.paused, true);
      for (const [id, receipt] of history)
        assert.deepEqual(h.store.get("operations", id), receipt, `old receipt changed: ${id}`);
      assert.equal(h.ordinaryWrites(), 0);
      assert.equal(h.selectorRequests(), 0);
    } finally {
      await h.close();
    }
  });
}

test("review: old unknown business input remains unknown while the replacement finishes startup trust", async () => {
  const h = await fixture(true);
  try {
    await h.reconcile();
    const previous = h.participant();
    assert.ok(previous.execution);
    assert.equal(previous.initialSent, true);
    h.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    await assert.rejects(
      h.service.send(
        { ...h.actor, messageId: "unknown-old-turn" },
        h.task.id,
        previous.id,
        "Old work",
      ),
      (error: unknown) => error instanceof OperationError && error.code === "delivery_unconfirmed",
    );
    const unknown = h.store
      .entries<OperationReceipt>("operations")
      .filter(([, receipt]) => receipt.state === "uncertain");
    assert.ok(unknown.length > 0);
    const sends = h.herdr.sends.length;
    h.herdr.agents.delete(previous.execution.paneId);
    await h.reconcile();
    assert.notEqual(h.participant().execution?.paneId, previous.execution.paneId);
    assert.equal(h.writes.length, 2);
    assert.equal(h.participant().initialSent, true);
    assert.equal(h.participant().recoveryPending, true);
    assert.equal(h.store.get<Task>("tasks", h.task.id)?.discussion.paused, true);
    assert.equal(h.herdr.sends.length, sends);
    assert.equal(h.ordinaryWrites(), 0);
    assert.equal(h.selectorRequests(), 0);
    for (const [id, receipt] of unknown) assert.deepEqual(h.store.get("operations", id), receipt);
  } finally {
    await h.close();
  }
});

test("review: unknown trust cannot escape through service restart, changed stateSeq or Jev enablement", async () => {
  const h = await fixture(false);
  try {
    h.failTrust(true);
    await h.reconcile(1);
    assert.equal(h.writes.length, 1);
    const before = h.store
      .entries<OperationReceipt>("operations")
      .filter(([, receipt]) => receipt.state === "uncertain");
    assert.ok(before.length > 0);
    const current = h.participant();
    assert.ok(current.execution);
    const native = h.herdr.agents.get(current.execution.paneId);
    assert.ok(native);
    native.stateSeq = "999";
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "review-fixture-only";
    h.failTrust(false);
    await h.restartApplication();
    await h.reconcile();
    assert.equal(h.writes.length, 1, "same-execution unknown cannot be retried as a fresh gate");
    assert.equal(h.ordinaryWrites(), 0, "generic approval cannot bypass trust uncertainty");
    assert.equal(h.selectorRequests(), 0);
    assert.equal(h.herdr.sends.length, 0);
    for (const [id, receipt] of before) assert.deepEqual(h.store.get("operations", id), receipt);
  } finally {
    await h.close();
  }
});

test("review: a queued pause vetoes the in-flight trust write but does not permanently stop startup maintenance", async () => {
  const h = await fixture(false);
  try {
    let pause: Promise<unknown> | undefined;
    h.beforeTrust(async () => {
      pause ??= h.service.action(
        { ...h.actor, messageId: "pause-at-trust-boundary" },
        h.task.id,
        "pause",
      );
    });
    await h.reconcile(1);
    assert.ok(pause);
    await pause;
    assert.equal(h.writes.length, 0);
    h.beforeTrust(async () => {});
    await h.reconcile();
    assert.equal(h.writes.length, 1);
    assert.equal(h.store.get<Task>("tasks", h.task.id)?.status, "paused");
    assert.equal(h.store.get<Task>("tasks", h.task.id)?.discussion.paused, true);
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    await h.close();
  }
});

test("review: ownership revoked at the final native effect boundary vetoes startup trust", async () => {
  const h = await fixture(false);
  try {
    h.beforeTrust(async () => {
      h.config.feishu.allowedOpenIds = [];
    });
    await h.reconcile();
    assert.equal(h.writes.length, 0);
    assert.equal(h.herdr.sends.length, 0);
    assert.equal(h.ordinaryWrites(), 0);
  } finally {
    await h.close();
  }
});

test("review: terminal replacement during final native read cannot inherit the trust authorization", async () => {
  const h = await fixture(false);
  try {
    h.beforeTrust(async () => {
      const current = h.participant();
      assert.ok(current.execution);
      const native = h.herdr.agents.get(current.execution.paneId);
      assert.ok(native);
      native.terminalId = "different-terminal-at-effect-boundary";
    });
    await h.reconcile(1);
    assert.equal(h.writes.length, 0);
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    await h.close();
  }
});
