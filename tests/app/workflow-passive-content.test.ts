import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import { TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { applicationTools } from "../../src/app/tools.js";
import type { ActorContext, StoredMessage, Task } from "../../src/core/types.js";
import { handoffDirectory } from "../../src/orchestration/handoff.js";
import { orchestrationUserMessages } from "../../src/orchestration/user-messages.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { associateTaskUserRequest, type TaskUserRevision } from "../../src/tasks/user-request.js";
import { actor, discussion } from "../tasks/helpers.js";
import { logger, message, setup } from "./helpers.js";

const unrelated = "另一个新项目设计必须保存 OTHER-PROJECT.md，不运行验证；先查旧任务进度。";

async function fixture(group: boolean) {
  const h = setup();
  const task = await h.app.tasks.create(actor, {
    ...discussion,
    orchestration: { mode: "workflow" },
    createRemoteTask: false,
  });
  await h.app.tasks.reconcile(task.id);
  const current = h.app.tasks.get(actor, task.id);
  assert.ok(current.chatId);
  const who: ActorContext = {
    ...actor,
    source: "feishu",
    messageId: "query-with-another-project",
    chatId: group ? current.chatId : "entry",
    chatType: group ? "group" : "private",
    ...(group ? { taskId: task.id } : {}),
  };
  h.store.set<InboxRecord>("inbox", `message:${who.messageId}`, {
    id: `message:${who.messageId}`,
    type: "message",
    actor: who,
    payload: {
      ...message(who.messageId, unrelated, who.chatId),
      chatType: who.chatType ?? "private",
    },
    state: "done",
    lane: group ? "task" : "owner",
    sequence: 1,
    createdAt: new Date().toISOString(),
  });
  if (group)
    h.store.set<StoredMessage>("messages", "group-query", {
      id: "group-query",
      sessionId: who.sessionId,
      taskId: task.id,
      role: "user",
      source: "user",
      text: unrelated,
      delivery: "delivered",
      deliveryIds: [who.messageId],
      generation: 0,
      createdAt: new Date().toISOString(),
    });
  const query = applicationTools(h.app, who).find((tool) => tool.name === "tasks_list");
  assert.ok(query);
  await query.execute({}, who);
  h.engine.handler = async (input) => {
    const tool = input.tools[0];
    assert.ok(tool);
    await tool.execute(
      tool.name === "orchestration_plan"
        ? { template: "discussion", instructions: {}, deliveryRequirements: [] }
        : tool.name === "orchestration_choice"
          ? {
              candidateId: JSON.parse(input.prompt).candidates.some(
                (candidate: { id: string }) => candidate.id === "request_pi",
              )
                ? "request_pi"
                : JSON.parse(input.prompt).candidates[0].id,
            }
          : { candidateId: JSON.parse(input.prompt).candidates[0].id, reason: "按已有要求继续" },
      input.actor,
    );
    return { text: "", messages: [] };
  };
  const worker = new TaskOrchestrator({
    config: h.config,
    projects: h.app.projects,
    store: h.store,
    tasks: () => h.app.tasks,
    tools: () => [],
    engine: h.engine,
    signal: h.app.signal,
    logger,
  });
  return { ...h, task, who, worker };
}

for (const group of [false, true])
  for (const upgrade of [false, true])
    test(`passive ${group ? "group message" : "entry revision"} stays out of planning and native handoff unless explicitly upgraded (input=${upgrade})`, async () => {
      const h = await fixture(group);
      try {
        assert.equal(h.store.list<TaskUserRevision>("task_user_revisions")[0]?.usage, "read");
        if (upgrade) {
          const participant = h.app.tasks.records.participants(h.task)[0];
          assert.ok(participant?.execution);
          await h.app.tasks.send(h.who, h.task.id, participant.id, "将这条原文明确交给此任务");
          h.herdr.finish(participant.execution.paneId, "已接收补充要求");
          await h.app.tasks.reconcile(h.task.id);
        }
        await h.worker.tick();
        const planning = h.engine.calls.find((call) => call.sessionId.startsWith("workflow-plan:"));
        assert.ok(planning, JSON.stringify(h.store.list("task_orchestration_events")));
        const supplied = JSON.parse(planning.prompt);
        assert.equal(supplied.userMessages.includes(unrelated), upgrade);
        assert.equal(
          supplied.sources.some((source: { text: string }) => source.text === unrelated),
          upgrade,
        );
        await h.worker.tick();
        const state = h.store.get<WorkflowState>(WORKFLOWS, h.task.id);
        const progress = state && Object.values(state.nodes).find((node) => node.operationId);
        assert.ok(progress?.operationId, JSON.stringify(h.store.list("task_orchestration_events")));
        const brief = readFileSync(
          join(handoffDirectory(h.directory, h.task.id, progress.operationId), "brief.md"),
          "utf8",
        );
        assert.equal(brief.includes(unrelated), upgrade);
        assert.ok(h.herdr.sends.some((send) => send.text.includes("brief.md")));
        const provenance = h.store.list<TaskUserRevision>("task_user_revisions");
        assert.equal(provenance[0]?.usage, upgrade ? "input" : "read");
        assert.equal(provenance[0]?.source.text, unrelated, "audit originals remain unchanged");
        if (group)
          assert.equal(h.store.get<StoredMessage>("messages", "group-query")?.text, unrelated);
      } finally {
        await h.close();
      }
    });

test("v3 control provenance is excluded while unclassified messages and legacy task content remain available", async () => {
  const h = await fixture(true);
  try {
    const revision = h.store.entries<TaskUserRevision>("task_user_revisions")[0];
    assert.ok(revision);
    h.store.set("task_user_revisions", revision[0], { ...revision[1], usage: "control" });
    assert.deepEqual(orchestrationUserMessages(h.store, h.task), []);
    for (const variant of [
      { promptVersion: 2 },
      { orchestration: { mode: "model" } },
    ] as Partial<Task>[])
      assert.deepEqual(
        orchestrationUserMessages(h.store, { ...h.task, ...variant }).map((entry) => entry.text),
        [unrelated],
      );
    h.store.set("task_user_revisions", revision[0], { ...revision[1], usage: undefined });
    assert.deepEqual(
      orchestrationUserMessages(h.store, h.task).map((entry) => entry.text),
      [unrelated],
    );
    associateTaskUserRequest(h.store, h.who, h.task, "input");
    assert.equal(h.store.get<TaskUserRevision>("task_user_revisions", revision[0])?.usage, "input");
    assert.deepEqual(
      orchestrationUserMessages(h.store, h.task).map((entry) => entry.text),
      [unrelated],
    );
  } finally {
    await h.close();
  }
});
