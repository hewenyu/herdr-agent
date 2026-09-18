import assert from "node:assert/strict";
import test from "node:test";
import type { notificationParticipants, notificationTask } from "../../src/app/notifications.js";
import type { Task } from "../../src/core/types.js";
import type { EngineInput } from "../../src/runtime/types.js";
import { message, setup } from "./helpers.js";

const silent = { text: '{"notify":false,"text":""}', messages: [] };
const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "parent" };

function assertSnapshotBoundary(turn: EngineInput) {
  assert.match(turn.systemPrompt, /parentContext是创建子任务时保存的父任务快照/);
  assert.match(turn.systemPrompt, /本轮未操作父任务不等于父任务仍待验收、未关闭或保持原状态/);
  assert.match(turn.systemPrompt, /不能为此跨越群绑定查询其他任务/);
}

test("child history remains queryable but cleanup notice inputs omit it without widening task scope", async () => {
  const h = setup();
  h.engine.handler = async () => silent;
  try {
    const parent = await h.app.tasks.create(actor, {
      kind: "discussion",
      title: "父讨论",
      requirements: "等待用户验收，不自动完成或关闭。",
      participants: [{ kind: "claude" }],
    });
    await h.app.tasks.reconcile(parent.id);
    const child = await h.app.tasks.create(
      { ...actor, messageId: "child" },
      {
        kind: "development",
        title: "关联开发",
        requirements: "父讨论任务继续保持等待验收状态，不要对其执行完成或关闭。",
        parentTaskId: parent.id,
        participants: [{ kind: "codex" }],
      },
    );
    await h.app.tasks.reconcile(child.id);
    const snapshot = structuredClone(child.parentContext);
    await h.app.tasks.action({ ...actor, messageId: "parent-complete" }, parent.id, "complete");
    await h.app.tasks.reconcile(parent.id);
    assert.equal(h.app.tasks.get(actor, parent.id).status, "destroyed");
    const readyChild = h.app.tasks.get(actor, child.id);
    assert.ok(readyChild.chatId);
    const notices: string[] = [];
    let ordinaryTurns = 0;
    const failures: unknown[] = [];
    h.engine.handler = async (turn) => {
      try {
        assert.equal(turn.actor.taskId, child.id);
        assertSnapshotBoundary(turn);
        const get = turn.tools.find((tool) => tool.name === "task_get");
        assert.ok(get);
        await assert.rejects(get.execute({ taskId: parent.id }, turn.actor), /绑定任务/);
        const list = turn.tools.find((tool) => tool.name === "tasks_list");
        assert.ok(list);
        const listed = (await list.execute({ all: true }, turn.actor)) as Task[];
        assert.deepEqual(
          listed.map((task) => task.id),
          [child.id],
        );
        if (turn.sessionId.startsWith("notice:")) {
          assert.ok(turn.tools.every((tool) => tool.readOnly));
          const event = JSON.parse(turn.prompt) as {
            event: string;
            task: ReturnType<typeof notificationTask>;
            participants: ReturnType<typeof notificationParticipants>;
          };
          notices.push(event.event);
          for (const field of ["parentContext", "parentTaskId", "requirements", "result"])
            assert.ok(!(field in event.task), `${field} must not enter default notice facts`);
          const fullTask = (await get.execute({}, turn.actor)) as Task;
          assert.deepEqual(fullTask.parentContext, snapshot);
          assert.equal(fullTask.requirements, child.requirements);
          assert.equal(event.task.closeRequested, true);
          assert.equal(event.task.status, "destroying");
          assert.ok(event.task.completedAt);
          assert.equal(event.task.remoteTaskId, readyChild.remoteTaskId);
          assert.equal(event.task.remoteTaskUrl, readyChild.remoteTaskUrl);
          assert.equal(event.task.chatId, readyChild.chatId);
          assert.equal(event.task.groupDeleted, false);
          assert.equal(event.task.keepGroup, false);
          assert.equal(event.task.discussion.paused, true);
          assert.equal(
            event.participants[0]?.status === "gone",
            event.event === "before_group_delete",
          );
          return silent;
        }
        ordinaryTurns++;
        const complete = turn.tools.find((tool) => tool.name === "task_action");
        assert.ok(complete);
        const result = (await complete.execute({ action: "complete" }, turn.actor)) as Task;
        assert.equal(result.id, child.id);
        assert.equal(result.status, "completed");
        assert.deepEqual(result.parentContext, snapshot);
        // The fake engine verifies input and scope only; real wording needs a model probe.
        return { text: "本任务已确认完成，资源等待收尾。", messages: [] };
      } catch (error) {
        failures.push(error);
        throw error;
      }
    };
    await h.app.handlers().message({
      ...message("child-complete", "本任务验收通过，请完成。", readyChild.chatId),
      chatType: "group",
      mentionedBot: true,
    });
    await h.app.inbox.drain();
    await h.app.tasks.reconcile(child.id);
    assert.deepEqual(failures, [], "Application must not hide engine assertion failures");
    assert.equal(ordinaryTurns, 1);
    assert.deepEqual(notices, ["before_close", "before_group_delete"]);
    assert.equal(h.app.tasks.get(actor, child.id).status, "destroyed");
    assert.equal(h.app.tasks.get(actor, parent.id).status, "destroyed");
    assert.deepEqual(h.app.tasks.get(actor, child.id).parentContext, snapshot);
  } finally {
    await h.close();
  }
});
