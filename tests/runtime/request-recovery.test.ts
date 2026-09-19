import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import type { InboxRecord } from "../../src/app/inbox.js";
import { loadConfig } from "../../src/config/load.js";
import { OperationError } from "../../src/core/errors.js";
import { normalizeMessage } from "../../src/feishu/normalize.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type { EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { logger, Platform } from "../app/helpers.js";
import { FakeHerdr } from "../tasks/helpers.js";
import { config, response, scripted } from "./helpers.js";

const requests = [
  "让 Claude 和 Codex 讨论这个需求",
  "用 Codex 开始实现这个项目",
  "把这个需求交给 Codex",
  "开个讨论任务，让 Claude 帮我梳理这个需求",
  "拉个群，让 Claude 和 Codex 一起讨论",
  "先停一下，保留讨论，稍后继续",
  "请解释创建任务的流程，然后创建一个任务",
  "Claude 可以参与讨论吗？现在让 Claude 参与讨论",
];

function input(prompt: string, tool: RuntimeTool): EngineInput {
  return {
    actor: { ownerId: "owner", chatId: "entry", sessionId: "session", messageId: "request" },
    sessionId: "session",
    systemPrompt: "Only orchestrate using application tools. Do not do project work yourself.",
    prompt,
    messages: [],
    tools: [tool],
  };
}

for (const prompt of requests) {
  test(`PiEngine recovers a tool-free acknowledgement: ${prompt}`, async () => {
    const toolName = prompt.startsWith("先停") ? "task_action" : "task_create";
    let attempts = 0;
    const toolChoices: unknown[] = [];
    const stream = scripted([
      response("收到。"),
      response("", [{ type: "toolCall", id: "recovered", name: toolName, arguments: {} }]),
      response("请求已记录，等待后续状态。"),
    ]);
    const engine = new PiEngine(config, {
      streamFn: (model, context, options) => {
        toolChoices.push((options as Record<string, unknown> | undefined)?.toolChoice);
        return stream(model, context, options);
      },
    });
    const result = await engine.run(
      input(prompt, {
        name: toolName,
        description: "Record an orchestration request",
        parameters: { type: "object", properties: {} },
        readOnly: false,
        execute: async () => {
          attempts++;
          return { accepted: true, status: "queued" };
        },
      }),
    );
    assert.equal(attempts, 1);
    assert.equal(result.toolCalls, 1);
    assert.equal(result.writeCalls, 1);
    assert.equal(result.text, "请求已记录，等待后续状态。");
    assert.deepEqual(toolChoices, [undefined, "required", undefined]);
  });

  test(`PiEngine rejects repeated tool-free acknowledgement: ${prompt}`, async () => {
    const engine = new PiEngine(config, {
      streamFn: scripted([response("收到。"), response("好的。")]),
    });
    await assert.rejects(
      engine.run(
        input(prompt, {
          name: "tasks_list",
          description: "Find current task",
          parameters: { type: "object", properties: {} },
          readOnly: true,
          execute: async () => assert.fail("No tool call was emitted"),
        }),
      ),
      (error: unknown) =>
        error instanceof OperationError &&
        error.code === "model_failed" &&
        error.outcome === "not_executed",
    );
  });
}

test("Feishu normalize → durable inbox → real PiEngine recovery → application task_create", async () => {
  const directory = mkdtempSync(join(tmpdir(), "myrix-request-recovery-"));
  const store = new Store(":memory:");
  const appConfig = loadConfig({ stateDir: directory, home: directory, cwd: directory, env: {} });
  appConfig.ai = config;
  appConfig.tasks.enabled = true;
  appConfig.feishu.allowedOpenIds = ["owner"];
  const platform = new Platform();
  const herdr = new FakeHerdr();
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("收到。"),
      response("", [
        {
          type: "toolCall",
          id: "create-discussion",
          name: "task_create",
          arguments: {
            kind: "discussion",
            title: "需求讨论",
            requirements: "仅讨论需求；禁止编码和修改文件。",
            participants: [{ kind: "claude" }, { kind: "codex" }],
          },
        },
      ]),
      response("请求已记录，等待后续状态。"),
    ]),
  });
  const app = new Application({ config: appConfig, store, platform, herdr, engine, logger });
  try {
    const incoming = normalizeMessage(
      {
        header: { event_id: "feishu-event" },
        event: {
          sender: { sender_type: "user", sender_id: { open_id: "owner" } },
          message: {
            message_id: "feishu-message",
            chat_id: "entry",
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: requests[0] }),
          },
        },
      },
      "bot",
    );
    assert.ok(incoming);
    await app.handlers().message(incoming);
    assert.equal(store.get<InboxRecord>("inbox", "message:feishu-message")?.state, "queued");
    assert.equal(app.tasks.records.list("owner").length, 0);
    await app.inbox.drain();
    assert.equal(store.get<InboxRecord>("inbox", "message:feishu-message")?.state, "done");
    const tasks = app.tasks.records.list("owner");
    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.ok(task);
    assert.equal(task.kind, "discussion");
    assert.equal(task.requirements, "仅讨论需求；禁止编码和修改文件。");
    assert.deepEqual(
      app.tasks.records.participants(task).map((participant) => participant.kind),
      ["claude", "codex"],
    );
    assert.equal(herdr.creates, 0, "task_create only queues the work");
    assert.equal(task.chatId, undefined);
    assert.equal(platform.texts.at(-1)?.text, "请求已记录，等待后续状态。");
    await app.handlers().message(incoming);
    await app.inbox.drain();
    assert.equal(app.tasks.records.list("owner").length, 1);
  } finally {
    await app.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const prompt of [
  "请解释让 Claude 和 Codex 讨论需求的流程",
  "请解释创建任务的流程，第一步创建项目，第二步让 Claude 参与讨论。",
  "任务未完成。",
  "Claude 可以参与讨论吗？",
]) {
  test(`PiEngine does not force a tool for explanations, reports or capability questions: ${prompt}`, async () => {
    const engine = new PiEngine(config, { streamFn: scripted([response("明白了。")]) });
    const result = await engine.run(
      input(prompt, {
        name: "task_create",
        description: "Create a task",
        parameters: { type: "object", properties: {} },
        readOnly: false,
        execute: async () => assert.fail("Conversation must not force a write"),
      }),
    );
    assert.equal(result.toolCalls, 0);
    assert.equal(result.text, "明白了。");
  });
}
