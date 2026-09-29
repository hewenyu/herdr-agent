import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { logger, setup } from "./helpers.js";

const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "create" };
const reason = "Jev 需要更多依据判断计划，也未请求 pi 协助。";

async function harness(platformEnabled = true) {
  const h = setup(true, platformEnabled);
  const task = await h.app.tasks.create(
    platformEnabled ? actor : { ...actor, chatId: "web:owner", source: "web" },
    {
      kind: "discussion",
      title: "等待依据",
      requirements: "比较两种设计方案",
      project: "project",
      participants: [{ kind: "codex" }, { kind: "claude" }],
      orchestration: { mode: "workflow" },
      createGroup: platformEnabled,
      createRemoteTask: platformEnabled,
    },
  );
  await h.app.tasks.reconcile(task.id);
  assert.equal(task.promptVersion, 3);
  const state = workflowState(h.store, task, "revision");
  const wait = (fingerprint: string | undefined, explanation = reason) => {
    state.assistanceWait = fingerprint
      ? { eventId: "decision", fingerprint, reason: explanation }
      : undefined;
    h.store.set(WORKFLOWS, task.id, state);
  };
  const notices = () => h.platform.texts.filter((message) => message.text.includes("判断依据"));
  const restart = () =>
    new Application({
      config: h.config,
      store: h.store,
      engine: h.engine,
      herdr: h.herdr,
      platform: platformEnabled ? h.platform : undefined,
      logger,
    });
  return { ...h, task, state, wait, notices, restart };
}

test("workflow evidence waits notify once across silent progress, repeated reconciliation and restart", async () => {
  const h = await harness();
  let restarted: Application | undefined;
  try {
    assert.equal(h.notices().length, 0, "ordinary progress stays silent");
    h.config.ui.notifyCooldownMs = 60_000;
    h.store.set("notice_progress_last", h.task.id, { at: Date.now() });
    h.wait("same-evidence");
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.notices().length, 1, "an actionable wait bypasses progress cooldown");
    assert.match(h.notices()[0]?.text ?? "", /请在本任务会话补充相关要求、材料或检查结果/);
    assert.equal(h.notices()[0]?.chat, h.app.tasks.get(actor, h.task.id).chatId);
    const firstKey = h.notices()[0]?.key;

    h.wait("same-evidence", "同一依据下的另一种原因表述");
    await h.app.tasks.reconcile(h.task.id);
    const participant = h.app.tasks.records.participants(h.task)[0];
    const native = participant?.execution && h.herdr.agents.get(participant.execution.paneId);
    assert.ok(native);
    native.status = "working";
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.notices().length, 1, "runtime status and reason text do not duplicate a wait");

    await h.app.shutdown();
    restarted = h.restart();
    await restarted.tasks.reconcile(h.task.id);
    await restarted.tasks.reconcile(h.task.id);
    assert.equal(h.notices().length, 1);
    h.wait(undefined);
    await restarted.tasks.reconcile(h.task.id);
    assert.equal(h.notices().length, 1);
    h.wait("new-evidence");
    await restarted.tasks.reconcile(h.task.id);
    assert.equal(h.notices().length, 2, "a new evidence fingerprint can request input again");
    assert.notEqual(h.notices()[1]?.key, firstKey);
    assert.equal(h.engine.calls.length, 0, "lifecycle waits never start a background pi turn");
    const session = restarted.sessions.forTask(actor.ownerId, h.task.id);
    const history = restarted.sessions
      .history(actor.ownerId, session.id)
      .filter((entry) => entry.text.includes("判断依据"));
    assert.equal(history.length, 2);
    assert.ok(
      history.every((entry) => entry.source === "lifecycle" && entry.delivery === "delivered"),
    );
    assert.equal(
      h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.assistanceWait?.fingerprint,
      "new-evidence",
    );
    assert.throws(() => restarted?.tasks.get({ ...actor, ownerId: "foreign" }, h.task.id));
  } finally {
    await restarted?.shutdown();
    await h.close();
  }
});

test("a delivered evidence wait recovers missing local notice markers without a second platform send", async () => {
  const h = await harness();
  let restarted: Application | undefined;
  const record = h.app.sessions.recordExternal.bind(h.app.sessions);
  try {
    h.wait("delivery-checkpoint");
    h.app.sessions.recordExternal = (...args) => {
      if (args[1].text.includes("判断依据")) throw new Error("crash after platform delivery");
      return record(...args);
    };
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.notices().length, 1);
    await h.app.shutdown();
    restarted = h.restart();
    await restarted.tasks.reconcile(h.task.id);
    await restarted.tasks.reconcile(h.task.id);
    assert.equal(h.notices().length, 1);
    const session = restarted.sessions.forTask(actor.ownerId, h.task.id);
    assert.equal(
      restarted.sessions
        .history(actor.ownerId, session.id)
        .filter((entry) => entry.text.includes("判断依据")).length,
      1,
    );
    assert.equal(h.engine.calls.length, 0);
  } finally {
    h.app.sessions.recordExternal = record;
    await restarted?.shutdown();
    await h.close();
  }
});

test("Web-only evidence waits appear once in the bound owner history and await UI acknowledgement", async () => {
  const h = await harness(false);
  try {
    h.wait("web-evidence");
    await h.app.tasks.reconcile(h.task.id);
    await h.app.tasks.reconcile(h.task.id);
    const session = h.app.sessions.forTask(actor.ownerId, h.task.id);
    const notices = h.app.sessions
      .history(actor.ownerId, session.id)
      .filter((entry) => entry.text.includes("判断依据"));
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.delivery, "prepared");
    assert.equal(h.platform.texts.length, 0);
    assert.equal(h.engine.calls.length, 0);
    assert.throws(() => h.app.sessions.history("foreign", session.id));
  } finally {
    await h.close();
  }
});
