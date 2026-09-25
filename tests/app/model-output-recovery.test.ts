import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import { stableId } from "../../src/core/ids.js";
import { deferred, setup } from "./helpers.js";

test("unknown intermediate chat delivery does not stop model handoff or replay the notification", async () => {
  const h = setup();
  let stage = 0;
  let uncertainAttempts = 0;
  const sendText = h.platform.sendText.bind(h.platform);
  h.platform.sendText = async (...args) => {
    if (args[1]?.includes("中间产物")) {
      uncertainAttempts++;
      throw new OperationError(
        "delivery_uncertain",
        "intermediate reply acknowledgement lost",
        "unknown",
      );
    }
    return sendText(...args);
  };
  h.engine.handler = async (input) => {
    if (!input.sessionId.startsWith("orchestration:"))
      return { text: '{"notify":false,"text":""}', messages: [] };
    const state = JSON.parse(input.prompt);
    const send = input.tools.find((tool) => tool.name === "participant_send");
    const decide = input.tools.find((tool) => tool.name === "orchestration_decide");
    assert.ok(send && decide);
    if (stage < 2) {
      if (stage === 1)
        assert.ok(
          state.authoritativeOutputs.some(
            (output: { entry: { text: string } }) => output.entry.text === "中间产物",
          ),
        );
      await send.execute(
        {
          participantId: state.participants[stage].id,
          text: stage ? "复核并完整交付" : "执行第一阶段",
        },
        input.actor,
      );
      await decide.execute({ action: "continue", reason: "继续已授权协作" }, input.actor);
    } else {
      const final = state.authoritativeOutputs.find(
        (output: { entry: { text: string } }) => output.entry.text === "最终交付",
      );
      assert.ok(final);
      await decide.execute(
        { action: "deliver", reason: "参与者已给出最终交付", outputId: final.entry.id },
        input.actor,
      );
    }
    stage++;
    return { text: "", messages: [] };
  };
  try {
    const task = await h.app.tasks.create(
      { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "goal" },
      {
        kind: "development",
        title: "不中断协作",
        requirements: "执行后复核交付",
        project: "project",
        participants: [{ kind: "codex" }, { kind: "claude" }],
        orchestration: { mode: "model" },
        createGroup: false,
        createRemoteTask: false,
      },
    );
    await h.app.tick();
    h.herdr.finish(h.herdr.sends[0]?.pane as string, "中间产物");
    await h.app.tick();
    assert.equal(stage, 2);
    assert.equal(
      h.herdr.sends.length,
      2,
      "the second native participant runs despite lost notification ACK",
    );
    assert.equal(h.store.list("task_settled_outputs").length, 1);
    h.herdr.finish(h.herdr.sends[1]?.pane as string, "最终交付");
    await h.app.tick();
    await h.app.tick();
    assert.equal(stage, 3);
    assert.equal(uncertainAttempts, 1);
    assert.equal(
      h.store.list("pending_outputs").length,
      1,
      "unknown original receipt remains for cleanup protection",
    );
    assert.equal(h.store.list("task_outputs").length, 2);
    assert.ok(h.platform.texts.some((message) => message.text.includes("最终交付")));
    await h.app.tasks.action(
      { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "complete" },
      task.id,
      "complete",
    );
    await h.app.tasks.reconcile(task.id);
    assert.equal(h.herdr.closes, 0, "unconfirmed output retains the cleanup barrier");
    assert.equal(uncertainAttempts, 1);
  } finally {
    await h.close();
  }
});

test("confirmed output receipt repairs the capture-notification crash gap without sending again", async () => {
  const h = setup();
  h.engine.handler = async () => ({ text: '{"notify":false,"text":""}', messages: [] });
  const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "crash-gap" };
  try {
    const task = await h.app.tasks.create(actor, {
      kind: "discussion",
      title: "回复落盘恢复",
      requirements: "确认已送达输出不重发",
      participants: [{ kind: "codex" }],
      createGroup: false,
      createRemoteTask: false,
    });
    await h.app.tasks.reconcile(task.id);
    const participant = h.app.tasks.records.participants(task)[0];
    assert.ok(participant?.execution);
    h.herdr.finish(participant.execution.paneId, "已经送达的原生结果");
    const entry = await h.herdr.sampleLastReply(participant.execution);
    assert.ok(entry);
    const key = stableId(participant.id, participant.execution.sessionId ?? "", entry.id);
    const outputId = `output:${task.id}:${participant.id}:${key}`;
    const text = `${participant.name} (${participant.kind})：\n${entry.text}`;
    await h.app.outbox.send("entry", text, outputId);
    h.store.set("pending_outputs", key, {
      taskId: task.id,
      participantId: participant.id,
      entry,
      delivery: "sending",
    });
    const messagesBefore = h.platform.texts.length;
    await h.app.tasks.reconcile(task.id);
    await h.app.tasks.reconcile(task.id);
    assert.equal(h.platform.texts.length, messagesBefore);
    assert.equal(h.store.get("pending_outputs", key), undefined);
    assert.ok(h.store.get("task_outputs", key));
    const session = h.app.sessions.forTask("owner", task.id);
    assert.ok(
      h.app.sessions
        .history("owner", session.id)
        .some((message) => message.text === text && message.delivery === "delivered"),
    );
  } finally {
    await h.close();
  }
});

test("a final selected during an in-flight output retry recovers its delivered receipt without a third send", async () => {
  const h = setup();
  const entered = deferred();
  const collision = deferred();
  const release = deferred();
  const result = "并发恢复后的完整最终交付";
  let stage = 0;
  let attempts = 0;
  let ticking: Promise<void> | undefined;
  const sendText = h.platform.sendText.bind(h.platform);
  h.platform.sendText = async (...args) => {
    if (args[1]?.includes(result)) {
      attempts++;
      if (attempts === 1) throw new OperationError("feishu_http_429", "暂时限流", "not_executed");
      if (attempts === 2) {
        entered.resolve();
        await release.promise;
      }
    }
    return sendText(...args);
  };
  const outboxSend = h.app.outbox.send.bind(h.app.outbox);
  h.app.outbox.send = async (...args) => {
    try {
      return await outboxSend(...args);
    } catch (error) {
      if (
        args[1].includes(result) &&
        error instanceof OperationError &&
        error.code === "delivery_uncertain"
      )
        collision.resolve();
      throw error;
    }
  };
  h.engine.handler = async (input) => {
    if (!input.sessionId.startsWith("orchestration:"))
      return { text: '{"notify":false,"text":""}', messages: [] };
    const state = JSON.parse(input.prompt);
    const send = input.tools.find((tool) => tool.name === "participant_send");
    const decide = input.tools.find((tool) => tool.name === "orchestration_decide");
    assert.ok(send && decide);
    if (stage++ === 0) {
      await send.execute(
        { participantId: state.participants[0].id, text: "执行并给出完整最终结果" },
        input.actor,
      );
      await decide.execute({ action: "continue", reason: "等待实际执行结果" }, input.actor);
    } else {
      await entered.promise;
      const final = state.authoritativeOutputs.find(
        (output: { entry: { text: string } }) => output.entry.text === result,
      );
      assert.ok(final);
      await decide.execute(
        { action: "deliver", reason: "完整结果已经形成", outputId: final.entry.id },
        input.actor,
      );
    }
    return { text: "", messages: [] };
  };
  try {
    const task = await h.app.tasks.create(
      { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "retry-race" },
      {
        kind: "development",
        title: "最终回执并发恢复",
        requirements: "执行后完整交付",
        project: "project",
        participants: [{ kind: "codex" }],
        orchestration: { mode: "model" },
        createGroup: false,
        createRemoteTask: false,
      },
    );
    await h.app.tick();
    h.herdr.finish(h.herdr.sends[0]?.pane as string, result);
    await h.app.tasks.reconcile(task.id);
    assert.equal(attempts, 1, "the initial output received a definite refusal");

    ticking = h.app.tick();
    await collision.promise;
    // Let the failed final notification settle while the scheduler's actual
    // retry is still in flight. Its later ACK must repair this separate event.
    await new Promise((resolve) => setImmediate(resolve));
    const before = h.store
      .list<OrchestrationEvent>("task_orchestration_events")
      .find((event) => event.decision?.action === "deliver");
    assert.equal(before?.notificationState, "uncertain");
    release.resolve();
    await ticking;
    await h.app.tick();
    const after = h.store
      .list<OrchestrationEvent>("task_orchestration_events")
      .find((event) => event.decision?.action === "deliver");
    assert.ok(after);
    assert.equal(after.state, "done");
    assert.equal(after.notificationState, "sent");
    assert.equal(after.notified, true);
    assert.equal(h.store.list("pending_outputs").length, 0);
    assert.equal(attempts, 2, "the confirmed final envelope must never be sent a third time");
    assert.equal(h.platform.texts.filter((message) => message.text.includes(result)).length, 1);
    assert.equal(h.herdr.sends.length, 1, "delivery recovery must never repeat native execution");
  } finally {
    release.resolve();
    if (ticking) await Promise.allSettled([ticking]);
    await h.close();
  }
});
