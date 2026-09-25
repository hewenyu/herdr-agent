import assert from "node:assert/strict";
import test from "node:test";
import { notificationParticipants, type notificationTask } from "../../src/app/notifications.js";
import type { Task } from "../../src/core/types.js";
import { setup } from "./helpers.js";

test("native done without transcript leaves explicit absent-output facts and waiting-turn receipts", async () => {
  const h = setup();
  const events: Array<{
    event: string;
    task: ReturnType<typeof notificationTask>;
    participants: ReturnType<typeof notificationParticipants>;
  }> = [];
  h.config.ui.notifyCooldownMs = 0;
  h.engine.handler = async (turn) => {
    events.push(JSON.parse(turn.prompt));
    return { text: '{"notify":false,"text":""}', messages: [] };
  };
  try {
    const task = (await h.app.dispatch("task.create", {
      kind: "discussion",
      title: "No captured discussion output",
      requirements: "仅讨论",
      participants: [{ kind: "claude" }, { kind: "codex" }],
      discussion: { mode: "round_robin", maxRounds: 1, maxMinutes: 30 },
      createRemoteTask: false,
      keepGroup: true,
    })) as Task;
    await h.app.tasks.reconcile(task.id);
    const participants = h.app.tasks.records.participants(task);
    for (const participant of participants) {
      const agent = h.herdr.agents.get(participant.execution?.paneId ?? "");
      assert.ok(agent);
      agent.status = "done";
      agent.stateSeq = "2";
    }
    await h.app.tasks.reconcile(task.id);
    // An idle native process without its expected final reply remains running,
    // rather than being advertised as ready for user review.
    const current = h.app.tasks.get(
      { ownerId: "owner", chatId: "entry", source: "web", sessionId: "test", messageId: "test" },
      task.id,
    );
    assert.equal(current.status, "running");
    const event = { task: current, participants: notificationParticipants(current.participants) };
    assert.ok(event);
    assert.equal(event.task.discussion.rounds, 0);
    assert.equal(event.task.discussion.maxRounds, 1);
    assert.equal(event.task.discussion.paused, false);
    assert.deepEqual(
      event.participants.map((participant) => ({
        status: participant.status,
        initialSent: participant.initialSent,
        hasOutput: participant.hasOutput,
      })),
      [
        { status: "done", initialSent: true, hasOutput: false },
        { status: "done", initialSent: false, hasOutput: false },
      ],
    );
    const first = participants[0];
    assert.ok(first);
    const withOutput = notificationParticipants([{ ...first, lastOutput: "已采集的观点" }])[0];
    assert.equal(withOutput?.hasOutput, true);
    assert.ok(!("lastOutput" in (withOutput ?? {})), "notices receive output presence, not prose");
    assert.ok(!("delivered" in (withOutput ?? {})), "capturing output is not a delivery receipt");
    const noNativeId = notificationParticipants([{ ...first, execution: undefined }])[0];
    assert.equal(noNativeId?.hasNativeSessionId, false);
    assert.equal(noNativeId?.hasOutput, false);
  } finally {
    await h.close();
  }
});

test("Application notice projection keeps blocked, receipt and discussion facts while history stays queryable", async () => {
  const h = setup();
  const silent = { text: '{"notify":false,"text":""}', messages: [] };
  h.engine.handler = async () => silent;
  h.config.ui.notifyCooldownMs = 0;
  try {
    const created = (await h.app.dispatch("task.create", {
      kind: "discussion",
      title: "当前讨论状态",
      requirements: "HISTORICAL_REQUIREMENTS_ONLY",
      participants: [{ kind: "claude", role: "HISTORICAL_ROLE_ONLY" }, { kind: "codex" }],
      discussion: { mode: "round_robin", maxRounds: 4, maxMinutes: 30 },
      createRemoteTask: false,
      keepGroup: true,
    })) as Task;
    await h.app.tasks.reconcile(created.id);
    const task = h.store.get<Task>("tasks", created.id);
    assert.ok(task);
    task.result = "HISTORICAL_TASK_RESULT_ONLY";
    task.error = "当前任务错误";
    task.syncError = "当前同步错误";
    task.pending = "当前投递尚未确认，不能重发";
    task.discussion.rounds = 1;
    task.discussion.paused = true;
    h.app.tasks.records.save(task);
    const participants = h.app.tasks.records.participants(task);
    const first = participants[0];
    assert.ok(first?.execution);
    first.lastOutput = "HISTORICAL_PARTICIPANT_OUTPUT_ONLY";
    first.error = "当前参与者等待处理";
    first.sessionNote = "原生会话已变化，不能重投";
    h.app.tasks.records.saveParticipant(first);
    const agent = h.herdr.agents.get(first.execution.paneId);
    assert.ok(agent);
    agent.status = "blocked";
    agent.stateSeq = "2";
    let notices = 0;
    const failures: unknown[] = [];
    h.engine.handler = async (turn) => {
      try {
        notices++;
        const event = JSON.parse(turn.prompt) as {
          event: string;
          task: ReturnType<typeof notificationTask>;
          participants: ReturnType<typeof notificationParticipants>;
        };
        assert.equal(event.event, "progress");
        assert.match(turn.systemPrompt, /讨论调度必须遵守discussion\.mode/);
        assert.match(turn.systemPrompt, /manual只自动尝试首位参与者/);
        assert.match(turn.systemPrompt, /已有仍有效的审批卡/);
        assert.match(turn.systemPrompt, /没有群或卡片发布事实时/);
        assert.match(turn.systemPrompt, /welcome和group_ready事件只证明/);
        assert.equal(event.task.status, "attention");
        assert.equal(event.task.error, task.error);
        assert.equal(event.task.syncError, task.syncError);
        assert.equal(event.task.pending, task.pending);
        assert.deepEqual(event.task.discussion, task.discussion);
        assert.equal(event.task.chatId, task.chatId);
        assert.equal(event.task.createGroup, true);
        assert.equal(event.task.createRemoteTask, false);
        assert.equal(event.task.groupDeleted, false);
        assert.equal(event.task.keepGroup, true);
        assert.equal(event.task.closeRequested, false);
        assert.deepEqual(
          event.participants.map((participant) => ({
            status: participant.status,
            started: participant.started,
            initialSent: participant.initialSent,
            hasOutput: participant.hasOutput,
            hasNativeSessionId: participant.hasNativeSessionId,
          })),
          [
            {
              status: "blocked",
              started: true,
              initialSent: true,
              hasOutput: true,
              hasNativeSessionId: true,
            },
            {
              status: "idle",
              started: true,
              initialSent: false,
              hasOutput: false,
              hasNativeSessionId: true,
            },
          ],
        );
        assert.equal(event.participants[0]?.error, first.error);
        assert.equal(event.participants[0]?.sessionNote, first.sessionNote);
        assert.doesNotMatch(turn.prompt, /HISTORICAL_/);
        assert.ok(turn.tools.every((tool) => tool.readOnly));
        const get = turn.tools.find((tool) => tool.name === "task_get");
        assert.ok(get);
        const full = (await get.execute({}, turn.actor)) as Task & {
          participants: typeof participants;
        };
        assert.equal(full.requirements, task.requirements);
        assert.equal(full.result, task.result);
        assert.equal(full.participants[0]?.lastOutput, first.lastOutput);
        assert.equal(full.participants[0]?.role, first.role);
        return silent;
      } catch (error) {
        failures.push(error);
        throw error;
      }
    };
    await h.app.tasks.reconcile(task.id);
    assert.deepEqual(failures, [], "Application must not hide engine assertion failures");
    assert.equal(notices, 1);
    assert.equal(h.store.get<Task>("tasks", task.id)?.result, task.result);
    assert.equal(h.app.tasks.records.participants(task)[0]?.lastOutput, first.lastOutput);
  } finally {
    await h.close();
  }
});
