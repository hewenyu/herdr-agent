import assert from "node:assert/strict";
import test from "node:test";
import { type NoticeRejection, noticeDecision } from "../../src/app/notice-decision.js";
import type { notificationParticipants, notificationTask } from "../../src/app/notifications.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type { LifecycleEvidence } from "../../src/runtime/lifecycle-evidence.js";
import type { EngineInput } from "../../src/runtime/types.js";
import { config, response, scripted } from "../runtime/helpers.js";
import { setup } from "./helpers.js";

const facts: LifecycleEvidence = {
  task: {
    id: "task_notice",
    status: "completed",
    closeRequested: true,
    chatId: "test-group",
    groupDeleted: false,
    keepGroup: false,
    groupRetentionSource: "default",
  },
  participants: [{ id: "p1", name: "Codex", kind: "codex", started: true, status: "gone" }],
};
const input: EngineInput = {
  actor: { ownerId: "owner", chatId: "test-group", sessionId: "notice", messageId: "notice" },
  sessionId: "notice",
  prompt: JSON.stringify({ event: "before_group_delete", ...facts }),
  systemPrompt: "Decide whether to notify and write JSON from lifecycle facts.",
  tools: [],
  messages: [],
  enforceClaims: false,
};

test("actual pi rewrites a premature completion notice without sending it or requiring tools", async () => {
  const corrected = "Codex 执行器已关闭；群将在本条通知送达后解散。";
  let calls = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted(
      [
        response(JSON.stringify({ notify: true, text: "已完成收尾，任务群即将解散。" })),
        response(JSON.stringify({ notify: true, text: corrected })),
      ],
      () => calls++,
    ),
  });
  assert.deepEqual(await noticeDecision(engine, input, facts), { notify: true, text: corrected });
  assert.equal(calls, 2);
});

test("a repeated unsupported notice fails before any candidate can be persisted", async () => {
  const text = JSON.stringify({ notify: true, text: "群已解散，全部处理完毕。" });
  const engine = new PiEngine(config, { streamFn: scripted([response(text), response(text)]) });
  await assert.rejects(noticeDecision(engine, input, facts), { code: "notice_fact_missing" });
});

test("model can decline a notice and verified notices need no repair", async () => {
  for (const decision of [
    { notify: false, text: "" },
    { notify: true, text: "任务已确认完成，群即将解散。" },
  ]) {
    const engine = new PiEngine(config, {
      streamFn: scripted([response(JSON.stringify(decision))]),
    });
    assert.deepEqual(await noticeDecision(engine, input, facts), decision);
  }
});

test("rejection callback captures both fact reasons and attempts before the next model call", async () => {
  const rejected: NoticeRejection[] = [];
  const texts = ["已完成收尾，任务群即将解散。", "群已解散，要求已转交给 Claude。"];
  let calls = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted(
      texts.map((text) => response(JSON.stringify({ notify: true, text }))),
      () => {
        assert.equal(rejected.length, calls);
        calls++;
      },
    ),
  });
  await assert.rejects(
    noticeDecision(engine, input, facts, async (rejection) => {
      await Promise.resolve();
      rejected.push(rejection);
    }),
    { code: "notice_fact_missing" },
  );
  assert.deepEqual(rejected, [
    { text: texts[0], attempt: 1, lifecycle: true, provision: false },
    { text: texts[1], attempt: 2, lifecycle: true, provision: true },
  ]);
});

test("successful repair audits only the rejected candidate and accepted or declined text is not audited", async () => {
  const bad = "要求已转交给 Claude。";
  const good = "任务已确认完成，群即将解散。";
  const rejected: NoticeRejection[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response(JSON.stringify({ notify: true, text: bad })),
      response(JSON.stringify({ notify: true, text: good })),
      response(JSON.stringify({ notify: false, text: bad })),
      response(JSON.stringify({ notify: true, text: good })),
    ]),
  });
  const onRejected = (rejection: NoticeRejection) => {
    rejected.push(rejection);
  };
  assert.deepEqual(await noticeDecision(engine, input, facts, onRejected), {
    notify: true,
    text: good,
  });
  assert.deepEqual(await noticeDecision(engine, input, facts, onRejected), {
    notify: false,
    text: bad,
  });
  assert.deepEqual(await noticeDecision(engine, input, facts, onRejected), {
    notify: true,
    text: good,
  });
  assert.deepEqual(rejected, [{ text: bad, attempt: 1, lifecycle: false, provision: true }]);
});

test("Application durably audits rejected cleanup notices without logging, delivering or blocking cleanup", async (t) => {
  const h = setup();
  const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "create" };
  const logs: unknown[][] = [];
  t.mock.method(h.app.logger, "warn", (...args: unknown[]) => logs.push(args));
  try {
    h.engine.handler = async () => ({ text: '{"notify":false,"text":""}', messages: [] });
    const task = await h.app.tasks.create(actor, {
      kind: "discussion",
      title: "拒绝通知审计",
      requirements: "仅验证收尾拒绝通知的本地审计",
      participants: [{ kind: "codex" }],
      keepGroup: false,
    });
    await h.app.tasks.reconcile(task.id);
    const rejectedText = "群已解散，要求已转交给 Claude。";
    h.engine.handler = async () => ({
      text: JSON.stringify({ notify: true, text: rejectedText }),
      messages: [],
    });
    await h.app.tasks.action({ ...actor, messageId: "complete" }, task.id, "complete");
    await h.app.tasks.reconcile(task.id);
    await h.app.tasks.reconcile(task.id);

    type Audit = NoticeRejection & {
      signature: string;
      runId: string;
      taskId: string;
      event: string;
      at: string;
      snapshot: {
        task: ReturnType<typeof notificationTask>;
        participants: ReturnType<typeof notificationParticipants>;
      };
    };
    const audits = h.store.entries<Audit>("notice_rejections");
    assert.equal(audits.length, 4);
    assert.deepEqual(audits.map(([, audit]) => `${audit.event}:${audit.attempt}`).sort(), [
      "before_close:1",
      "before_close:2",
      "before_group_delete:1",
      "before_group_delete:2",
    ]);
    for (const [key, audit] of audits) {
      assert.equal(key, `${audit.signature}:${audit.runId}:${audit.attempt}`);
      assert.match(audit.runId, /^notice_run_/);
      assert.equal(audit.taskId, task.id);
      assert.equal(audit.text, rejectedText);
      assert.equal(audit.lifecycle, true);
      assert.equal(audit.provision, true);
      assert.ok(Number.isFinite(Date.parse(audit.at)));
      assert.equal(audit.snapshot.task.id, task.id);
      assert.equal(audit.snapshot.task.groupDeleted, false);
      assert.equal(audit.snapshot.task.status, "destroying");
      assert.equal(audit.snapshot.participants.length, 1);
      assert.equal(audit.snapshot.participants[0]?.kind, "codex");
      assert.equal(
        audit.snapshot.participants[0]?.status,
        audit.event === "before_close" ? "working" : "gone",
      );
      assert.equal(Object.hasOwn(audit.snapshot.task, "requirements"), false);
      assert.equal(Object.hasOwn(audit.snapshot.task, "directories"), false);
      assert.equal(Object.hasOwn(audit.snapshot, "config"), false);
      assert.equal(h.store.get("notice_decisions", audit.signature), undefined);
      assert.equal(h.store.get("notices_done", audit.signature), undefined);
    }
    for (const table of ["task_close_notice", "task_group_delete_notice"]) {
      assert.deepEqual(h.store.get<{ outcome: unknown }>(table, task.id)?.outcome, {
        status: "unavailable",
        reason: "generation_failed",
        errorCode: "notice_fact_missing",
      });
    }
    const final = h.app.tasks.get(actor, task.id);
    assert.equal(final.status, "destroyed");
    assert.equal(final.groupDeleted, true);
    assert.equal(h.herdr.closes, 1);
    assert.equal(h.platform.deletions, 1);
    assert.equal(h.platform.texts.length, 0);
    assert.equal(h.store.list("outbox").length, 0);
    assert.equal(h.store.list("messages").length, 0);
    assert.equal(logs.length, 2);
    assert.doesNotMatch(JSON.stringify(logs), /群已解散|要求已转交给 Claude/);
  } finally {
    await h.close();
  }
});

test("repeated progress reconciliation preserves each rejected decision run and its attempts", async () => {
  const h = setup();
  const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "progress" };
  let rejectedCalls = 0;
  h.engine.handler = async (input) => {
    if (!input.prompt.includes('"event":"progress"'))
      return { text: '{"notify":false,"text":""}', messages: [] };
    rejectedCalls++;
    return {
      text: JSON.stringify({ notify: true, text: `群已解散。拒绝样本 ${rejectedCalls}。` }),
      messages: [],
    };
  };
  try {
    const task = await h.app.tasks.create(actor, {
      kind: "discussion",
      title: "重复进度通知审计",
      requirements: "检查重复 reconcile 的通知拒绝证据不被覆盖",
      participants: [{ kind: "codex" }],
    });
    type Audit = NoticeRejection & { signature: string; runId: string; event: string };
    await h.app.tasks.reconcile(task.id);
    const firstRun = h.store.entries<Audit>("notice_rejections");
    assert.equal(firstRun.length, 2);
    assert.equal(rejectedCalls, 2);
    assert.equal(new Set(firstRun.map(([, audit]) => audit.runId)).size, 1);
    await h.app.tasks.reconcile(task.id);
    const all = h.store.entries<Audit>("notice_rejections");
    assert.equal(all.length, 4);
    assert.equal(rejectedCalls, 4);
    assert.equal(new Set(all.map(([, audit]) => audit.signature)).size, 1);
    const runs = [...new Set(all.map(([, audit]) => audit.runId))];
    assert.equal(runs.length, 2);
    for (const runId of runs) {
      assert.deepEqual(
        all.filter(([, audit]) => audit.runId === runId).map(([, audit]) => audit.attempt),
        [1, 2],
      );
    }
    for (const [key, audit] of firstRun)
      assert.deepEqual(h.store.get("notice_rejections", key), audit);
    for (const [key, audit] of all) {
      assert.equal(key, `${audit.signature}:${audit.runId}:${audit.attempt}`);
      assert.equal(audit.event, "progress");
      assert.equal(h.store.get("notice_decisions", audit.signature), undefined);
      assert.equal(h.store.get("notices_done", audit.signature), undefined);
    }
    assert.deepEqual(
      all.map(([, audit]) => audit.text).sort(),
      Array.from({ length: 4 }, (_, index) => `群已解散。拒绝样本 ${index + 1}。`),
    );
    assert.equal(h.store.get("notice_progress_last", task.id), undefined);
    assert.equal(h.platform.texts.length, 0);
    assert.equal(h.store.list("outbox").length, 0);
  } finally {
    await h.close();
  }
});
