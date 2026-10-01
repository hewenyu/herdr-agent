import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { Task } from "../../src/core/types.js";
import { publishReport } from "../../src/orchestration/report.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import type { TaskUserRevision } from "../../src/tasks/user-request.js";
import { message, setup } from "./helpers.js";

async function fixture(promptVersion: 2 | 3 = 3) {
  const h = setup();
  const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "create" };
  const created = await h.app.tasks.create(actor, {
    kind: "discussion",
    title: "讨论进度",
    requirements: "讨论两个方案，不修改项目文件",
    project: "project",
    participants: [{ kind: "codex" }, { kind: "claude" }],
    orchestration: { mode: "workflow" },
    createRemoteTask: false,
  });
  h.app.tasks.records.save({ ...created, promptVersion });
  await h.app.tasks.reconcile(created.id);
  const task = h.app.tasks.get(actor, created.id);
  assert.ok(task.chatId);
  const scheduler = (
    h.app as unknown as { taskOrchestrator: { revision(task: Task, workflow?: boolean): string } }
  ).taskOrchestrator;
  for (const participant of task.participants)
    h.app.tasks.records.saveParticipant({ ...participant, initialSent: true, cursor: "0" });
  let conversationReads = 0;
  (h.herdr as HerdrPort).conversation = async () => {
    conversationReads++;
    return {
      entries: [{ id: "native-progress", role: "assistant", text: "讨论结论已形成", final: true }],
      truncated: false,
    };
  };
  const state = workflowState(h.store, task, scheduler.revision(task, false));
  state.phase = "awaiting_acceptance";
  state.planning = "ready";
  const revision = await workspaceRevision(task.directories);
  for (const node of state.plan.nodes)
    state.nodes[node.id] = {
      status: "completed",
      attempt: 1,
      artifactRevision: revision,
      participantId: task.participantIds[node.role === "reviewer" ? 1 : 0],
      outputId: `${node.id}-output`,
    };
  await publishReport(
    h.directory,
    task,
    state,
    {
      protocolVersion: 1,
      nodeId: "report",
      operationId: "report-operation",
      inputRevision: "revision",
      status: "completed",
      summary: "讨论结论",
      issues: [],
      artifactRefs: [],
      evidence: [],
      blockers: [],
      reportSections: Object.fromEntries(
        state.plan.deliveryRequirements.map((name) => [name, "已形成结论"]),
      ),
    },
    "report-output",
    revision,
  );
  h.store.set(WORKFLOWS, task.id, state);
  const original = h.store.get<WorkflowState>(WORKFLOWS, task.id);
  assert.ok(original);
  const originalRevision = scheduler.revision(task);
  const calls: string[] = [];
  let requestedTools: string[] = [];
  let queryOptions: { args?: Record<string, unknown>; error?: string } = {};
  h.engine.handler = async (input) => {
    const choice = input.tools.find((tool) => tool.name === "orchestration_choice");
    if (choice) {
      await choice.execute({ candidateId: "request_pi" }, input.actor);
      return { text: "", messages: [] };
    }
    if (
      input.sessionId.startsWith("workflow-plan:") ||
      input.tools.some((tool) => tool.name === "orchestration_plan")
    )
      return { text: "等待补充规划", messages: [], toolCalls: 0, writeCalls: 0 };
    for (const name of requestedTools) {
      const tool = input.tools.find((entry) => entry.name === name);
      assert.ok(tool, name);
      const args =
        name === "participant_send"
          ? { taskId: task.id, participantId: task.participantIds[0], text: "追加比较第三个方案" }
          : name === "participant_screen"
            ? { taskId: task.id, participantId: task.participantIds[0] }
            : name === "tasks_list"
              ? {}
              : { taskId: task.id };
      const pending = tool.execute({ ...args, ...queryOptions.args }, input.actor);
      if (queryOptions.error) await assert.rejects(pending, { code: queryOptions.error });
      else await pending;
      calls.push(name);
    }
    return {
      text: queryOptions.error ? "本次读取未成功，无法确定当前进度。" : "当前讨论结论可查阅。",
      messages: [],
      toolCalls: requestedTools.length,
      writeCalls: requestedTools.filter((name) => name === "participant_send").length,
    };
  };
  return {
    ...h,
    actor,
    task,
    scheduler,
    original,
    originalRevision,
    calls,
    conversationReads: () => conversationReads,
    state: () => h.store.get<WorkflowState>(WORKFLOWS, task.id),
    requests: () => h.store.list<TaskUserRevision>("task_user_revisions"),
    async query(
      id: string,
      tools: string[],
      chatType: "group" | "private" = "group",
      options: typeof queryOptions = {},
    ) {
      requestedTools = tools;
      queryOptions = options;
      await h.app.handlers().message({
        ...message(id, "当前进度和已有结论是什么？", chatType === "group" ? task.chatId : "entry"),
        chatType,
        mentionedBot: true,
      });
      await h.app.tick();
    },
  };
}

for (const tool of ["task_get", "task_progress", "tasks_list", "participant_screen"])
  test(`a real group ${tool} query preserves the v3 report and plan through full ticks`, async () => {
    const h = await fixture();
    try {
      await h.query("first-read", [tool]);
      await h.query("second-read", [tool]);
      await h.app.tick();
      const state = h.state();
      assert.equal(state?.phase, "awaiting_acceptance");
      assert.equal(state.plan.version, h.original.plan.version);
      assert.deepEqual(state.report, h.original.report);
      assert.deepEqual(state.nodes, h.original.nodes);
      assert.equal(h.scheduler.revision(h.task), h.originalRevision);
      assert.deepEqual(h.calls, [tool, tool]);
      assert.equal(h.herdr.sends.length, 0);
      assert.equal(
        h.engine.calls.some((call) => call.sessionId.startsWith("workflow-plan:")),
        false,
      );
      assert.deepEqual(
        h.requests().map((request) => request.usage),
        ["read", "read"],
      );
      assert.deepEqual(
        h.app.tasks.records.participants(h.task).map((participant) => participant.cursor),
        ["0", "0"],
      );
      if (tool === "task_progress") assert.equal(h.conversationReads(), 4);
      assert.equal(
        h.store.list<{ state: string }>("inbox").every((record) => record.state === "done"),
        true,
      );
    } finally {
      await h.close();
    }
  });

for (const failure of ["invalid_cursor", "screen_unavailable"])
  test(`a real failed read with ${failure} cannot turn the group query into new workflow requirements`, async () => {
    const h = await fixture();
    try {
      if (failure === "screen_unavailable")
        h.herdr.screen = async () => {
          throw new OperationError("screen_unavailable", "终端读取失败");
        };
      await h.query(
        "failed-read",
        [failure === "invalid_cursor" ? "task_progress" : "participant_screen"],
        "group",
        {
          error: failure,
          args: failure === "invalid_cursor" ? { cursor: "missing-participant" } : {},
        },
      );
      await h.app.tick();
      assert.equal(h.scheduler.revision(h.task), h.originalRevision);
      assert.equal(h.state()?.phase, "awaiting_acceptance");
      assert.equal(h.state()?.plan.version, h.original.plan.version);
      assert.deepEqual(h.state()?.report, h.original.report);
      assert.equal(h.requests()[0]?.usage, "read");
      assert.equal(h.herdr.sends.length, 0);
      assert.equal(
        h.engine.calls.some((call) => call.sessionId.startsWith("workflow-plan:")),
        false,
      );
      assert.equal(
        h.store.list<{ state: string }>("inbox").every((record) => record.state === "done"),
        true,
      );
    } finally {
      await h.close();
    }
  });

for (const order of [
  ["task_progress", "participant_send"],
  ["participant_send", "task_get"],
])
  test(`a mixed group turn keeps actual task input authoritative in ${order.join(" then ")} order`, async () => {
    const h = await fixture();
    try {
      await h.query("mixed-input", order);
      assert.deepEqual(h.calls, order);
      assert.equal(h.requests().length, 1);
      assert.equal(h.requests()[0]?.usage, "input");
      assert.notEqual(h.scheduler.revision(h.task), h.originalRevision);
      assert.equal(h.herdr.sends.length, 1);
      const first = h.app.tasks.records.participants(h.task)[0];
      assert.ok(first?.execution);
      h.herdr.finish(first.execution.paneId, "第三个方案已比较");
      await h.app.tick();
      assert.equal(h.state()?.plan.version, h.original.plan.version + 1);
      assert.equal(h.state()?.report, undefined);
      assert.ok(
        h.engine.calls.some(
          (call) =>
            call.sessionId.startsWith("task-leader:") &&
            call.tools.some((tool) => tool.name === "orchestration_plan"),
        ),
      );
    } finally {
      await h.close();
    }
  });

test("read-only provenance does not rewrite the existing v2 scheduling revision semantics", async () => {
  const h = await fixture(2);
  try {
    await h.query("legacy-read", ["task_get"]);
    assert.deepEqual(h.requests(), []);
    assert.notEqual(h.scheduler.revision(h.task), h.originalRevision);
    assert.equal(h.state()?.plan.version, h.original.plan.version + 1);
  } finally {
    await h.close();
  }
});

for (const mode of ["workflow", "model"] as const)
  for (const tool of ["task_get", "tasks_list"])
    test(`a private ${tool} query does not associate new revisions with an existing ${mode} task`, async () => {
      const h = await fixture(2);
      try {
        const task = h.app.tasks.get(h.actor, h.task.id);
        task.orchestration = { mode };
        h.app.tasks.records.save(task);
        const revision = h.scheduler.revision(task);
        await h.query(`private-${tool}`, [tool], "private");
        assert.deepEqual(h.calls, [tool]);
        assert.deepEqual(h.requests(), []);
        assert.equal(h.scheduler.revision(task), revision);
        assert.equal(h.state()?.plan.version, h.original.plan.version);
        assert.deepEqual(h.state()?.report, h.original.report);
        assert.equal(h.herdr.sends.length, 0);
      } finally {
        await h.close();
      }
    });
