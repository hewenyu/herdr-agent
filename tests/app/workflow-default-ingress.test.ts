import assert from "node:assert/strict";
import test from "node:test";
import { quietWorkflow } from "../../src/app/workflow-notifications.js";
import { message, setup } from "./helpers.js";

test("a stale model-mode tool call from entry history still creates a quiet v3 workflow", async () => {
  const h = setup();
  try {
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-only";
    const request = "新建小说设计讨论，让Claude和Codex相互讨论，沉淀文档后通知我。";
    h.engine.handler = async (turn) => {
      const create = turn.tools.find((tool) => tool.name === "task_create");
      assert.ok(create);
      // Replay the stale arguments observed on 2026-09-29. The execution boundary,
      // not just the currently advertised schema, must enforce the new default.
      await create.execute(
        {
          kind: "discussion",
          title: "小说设计",
          requirements: request,
          participants: [{ kind: "codex" }, { kind: "claude" }],
          orchestration: { mode: "model" },
        },
        turn.actor,
      );
      return { text: "已登记讨论任务。", messages: [] };
    };
    await h.app.handlers().message(message("new-discussion", request));
    await h.app.inbox.drain();
    const tasks = h.app.tasks.records.list("owner");
    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.ok(task);
    assert.equal(task.userRequest?.text, request);
    assert.equal(task.orchestration?.mode, "workflow");
    assert.equal(task.promptVersion, 3);
    assert.equal(quietWorkflow(task), true);
    await h.app.handlers().message(message("new-discussion", request));
    await h.app.inbox.drain();
    assert.equal(h.app.tasks.records.list("owner").length, 1);
  } finally {
    await h.close();
  }
});
