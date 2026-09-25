import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { stableId } from "../../src/core/ids.js";
import type { Participant, Task, TaskMutationRevision } from "../../src/core/types.js";
import type { EngineInput } from "../../src/runtime/types.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { logger, setup } from "./helpers.js";

const EVENTS = "task_orchestration_events";
const MUTATIONS = "task_mutation_revisions";
type Harness = ReturnType<typeof setup>;

async function execute(input: EngineInput, name: string, args: Record<string, unknown>) {
  const tool = input.tools.find((entry) => entry.name === name);
  assert.ok(tool);
  return tool.execute(args, input.actor);
}

const calls = (h: Harness) =>
  h.engine.calls.filter((input) => input.sessionId.startsWith("orchestration:")).length;

async function matureTask(h: Harness): Promise<Task> {
  const task = await h.app.tasks.create(
    { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "create" },
    {
      kind: "discussion",
      title: "讨论并交付结论",
      requirements: "只讨论，不修改文件。新增参与者仍须在原任务范围内协作。",
      participants: [{ kind: "claude", name: "原参与者" }],
      orchestration: { mode: "model" },
      createGroup: false,
      createRemoteTask: false,
    },
  );
  h.engine.handler = async (input) => {
    if (!input.sessionId.startsWith("orchestration:"))
      return { text: '{"notify":false,"text":""}', messages: [] };
    const data = JSON.parse(input.prompt);
    if (data.event.trigger === "ready")
      await execute(input, "participant_send", {
        participantId: data.participants[0].id,
        text: "仅讨论原始目标，形成完整结论。",
      });
    else
      await execute(input, "orchestration_decide", {
        action: "deliver",
        reason: "依据原生结论交付，等待验收。",
        outputId: data.authoritativeOutputs.at(-1).entry.id,
      });
    return { text: "", messages: [] };
  };
  await h.app.tick();
  const first = h.app.tasks.records.participants(task)[0];
  assert.ok(first?.execution);
  h.herdr.finish(first.execution.paneId, "初始完整结论");
  await h.app.tick();
  await h.app.tick();
  assert.equal(calls(h), 2);
  assert.equal(h.herdr.sends.length, 1);
  assert.ok(
    h.store
      .list<OrchestrationEvent>(EVENTS)
      .every((event) => event.userRevision === stableId(task.requirements)),
    "tasks without mutation records retain their pre-upgrade revision hash",
  );
  return task;
}

const addition = (taskId: string) => ({
  taskId,
  requestId: "web-add-existing-task",
  kind: "codex",
  name: "追加参与者",
  role: "按原任务范围核对现有结论",
});

test("Web participant addition wakes a mature task after restart without inventing chat authority or repeating retries", async () => {
  const h = setup();
  let restarted: Application | undefined;
  try {
    const task = await matureTask(h);
    const input = addition(task.id);
    const added = (await h.app.dispatch("participant.add", input)) as Participant;
    const revisions = h.store.entries<TaskMutationRevision>(MUTATIONS);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]?.[1].participantId, added.id);
    assert.equal(h.store.list("task_user_revisions").length, 0);
    assert.equal(h.store.list("inbox").length, 0);
    const retried = (await h.app.dispatch("participant.add", {
      ...input,
      role: "重试不改变已提交角色",
    })) as Participant;
    assert.equal(retried.id, added.id);
    assert.equal(retried.role, added.role);
    assert.deepEqual(h.store.entries(MUTATIONS), revisions);
    await h.app.shutdown();
    h.engine.handler = async (turn) => {
      if (!turn.sessionId.startsWith("orchestration:"))
        return { text: '{"notify":false,"text":""}', messages: [] };
      const data = JSON.parse(turn.prompt);
      const participant = data.participants.find((entry: Participant) => entry.id === added.id);
      assert.ok(participant);
      if (!participant.initialSent) {
        assert.equal(data.event.trigger, "user_revision");
        assert.deepEqual(data.event.outputIds, []);
        assert.deepEqual(data.userRevisions, []);
        assert.equal(data.taskMutations[0].participantId, added.id);
        assert.equal(data.taskMutations[0].action, "participant_add");
        await execute(turn, "participant_send", {
          participantId: added.id,
          text: "只讨论、不修改文件；按原任务范围核对现有结论。",
        });
      } else
        await execute(turn, "orchestration_decide", {
          action: "deliver",
          reason: "新参与者已完成原范围内的核对。",
          outputId: data.authoritativeOutputs.at(-1).entry.id,
        });
      return { text: "", messages: [] };
    };
    restarted = new Application({
      config: h.config,
      store: h.store,
      herdr: h.herdr,
      engine: h.engine,
      platform: h.platform,
      logger,
    });
    await restarted.tick();
    const provisioned = h.store.get<Participant>("participants", added.id);
    assert.ok(provisioned?.execution);
    assert.equal(calls(h), 3);
    assert.equal(h.herdr.sends.length, 2);
    assert.equal(h.herdr.sends[1]?.pane, provisioned.execution.paneId);
    h.herdr.finish(provisioned.execution.paneId, "补充核对完成");
    await restarted.tick();
    assert.equal(calls(h), 4);
    await restarted.dispatch("participant.add", input);
    await restarted.tick();
    assert.deepEqual(h.store.entries(MUTATIONS), revisions);
    assert.equal(calls(h), 4);
    assert.equal(h.herdr.sends.length, 2);
    const key = revisions[0]?.[0];
    assert.ok(key);
    h.store.delete(MUTATIONS, key);
    await restarted.dispatch("participant.add", input);
    await restarted.tick();
    assert.equal(h.store.entries(MUTATIONS).length, 1);
    assert.equal(h.store.entries(MUTATIONS)[0]?.[0], key);
    assert.equal(
      calls(h),
      4,
      "repairing the same durable mutation preserves its revision identity",
    );
  } finally {
    await restarted?.shutdown();
    await h.close();
  }
});

test("failed Web additions and mutation-record write rollback never wake the existing task", async () => {
  const h = setup();
  try {
    const task = await matureTask(h);
    await assert.rejects(h.app.dispatch("participant.add", { ...addition(task.id), kind: "bad" }));
    const set = h.store.set.bind(h.store);
    h.store.set = (namespace, key, value) => {
      set(namespace, key, value);
      if (namespace === MUTATIONS) throw new Error("mutation persistence failure");
    };
    try {
      await assert.rejects(
        h.app.dispatch("participant.add", addition(task.id)),
        /persistence failure/,
      );
    } finally {
      h.store.set = set;
    }
    assert.equal(h.store.list(MUTATIONS).length, 0);
    assert.equal(
      h.app.tasks.records.participants(h.store.get<Task>("tasks", task.id) as Task).length,
      1,
    );
    await h.app.tick();
    assert.equal(calls(h), 2);
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    await h.close();
  }
});

for (const guard of ["pause", "unknown"] as const)
  test(`a Web participant mutation cannot bypass ${guard}`, async () => {
    const h = setup();
    try {
      const task = await matureTask(h);
      let uncertainId: string | undefined;
      if (guard === "pause")
        await h.app.dispatch("task.action", {
          taskId: task.id,
          requestId: "pause-before-add",
          action: "pause",
        });
      else {
        const event = h.store
          .list<OrchestrationEvent>(EVENTS)
          .find((entry) => entry.decision?.action === "deliver");
        assert.ok(event);
        uncertainId = event.id;
        const operationId = `${task.id}:unverified-native-send`;
        h.store.set<OperationReceipt>("operations", operationId, {
          id: operationId,
          fingerprint: "unknown-input",
          state: "uncertain",
          updatedAt: new Date().toISOString(),
        });
        event.dispatches = [
          { operationId, participantId: task.participantIds[0] ?? "", state: "uncertain" },
        ];
        event.state = "attention";
        h.store.set(EVENTS, event.id, event);
      }
      await h.app.dispatch("participant.add", addition(task.id));
      assert.equal(h.store.list(MUTATIONS).length, 1);
      await h.app.tick();
      assert.equal(calls(h), 2);
      assert.equal(h.herdr.sends.length, 1);
      if (guard === "pause")
        assert.equal(h.store.get<Task>("tasks", task.id)?.discussion.paused, true);
      else {
        const event = h.store.get<OrchestrationEvent>(EVENTS, uncertainId ?? "");
        assert.equal(event?.state, "attention");
        assert.equal(event?.dispatches[0]?.state, "uncertain");
      }
    } finally {
      await h.close();
    }
  });
