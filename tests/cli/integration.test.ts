import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Application } from "../../src/app/application.js";
import { loadConfig } from "../../src/config/load.js";
import { OperationError } from "../../src/core/errors.js";
import type { StoredMessage, Task } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { NOTIFICATION_PROMPT } from "../../src/runtime/prompts.js";
import { Store } from "../../src/storage/store.js";
import { startWeb } from "../../src/web/index.js";
import { message, Platform } from "../app/helpers.js";
import { config as modelConfig, response, scripted } from "../runtime/helpers.js";
import { FakeHerdr } from "../tasks/helpers.js";

test("offline Feishu adapter drives the real pi loop and turn-taking; Web only reads delivery history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-pi-web-"));
  const store = new Store(":memory:");
  const config = loadConfig({ stateDir: directory, home: directory, cwd: directory, env: {} });
  config.ai = { ...modelConfig };
  config.tasks.enabled = true;
  config.feishu.allowedOpenIds = ["owner"];
  const main = scripted([
    response("", [
      {
        type: "toolCall",
        id: "create-discussion",
        name: "task_create",
        arguments: {
          kind: "discussion",
          title: "需求讨论",
          requirements: "只讨论重构需求，不修改代码",
          participants: [{ kind: "claude" }, { kind: "codex" }],
          createGroup: true,
          createRemoteTask: false,
          discussion: { mode: "round_robin" },
        },
      },
    ]),
    response("已创建讨论任务，Claude 与 Codex 将参与。"),
    response("此条回执未送达，浏览记录不能确认送达。"),
  ]);
  let modelCalls = 0;
  const engine = new PiEngine(config.ai, {
    streamFn: (model, context, options) => {
      modelCalls++;
      return context.systemPrompt === NOTIFICATION_PROMPT
        ? scripted([response('{"notify":false,"text":""}')])(model, context, options)
        : main(model, context, options);
    },
  });
  const herdr = new FakeHerdr();
  const platform = new Platform();
  const app = new Application({
    config,
    store,
    herdr,
    platform,
    engine,
    logger: { info() {}, warn() {}, error() {} },
  });
  const web = await startWeb({
    listen: "127.0.0.1:0",
    backend: app,
    assets: { "index.html": "离线适配器测试：只读会话记录", "app.js": "", "styles.css": "" },
  });
  try {
    // Exercise the Feishu adapter contract with a fake platform, not a live Feishu service.
    await app.handlers().message(message("user-1", "请让 Claude 和 Codex 讨论需求。"));
    await app.inbox.drain();
    assert.ok(platform.texts.some((entry) => /Claude 与 Codex/.test(entry.text)));
    assert.equal(store.list<Task>("tasks").length, 1);
    await app.tick();
    assert.equal(herdr.starts, 2);
    assert.equal(herdr.sends.length, 1);
    assert.match(herdr.sends[0]?.text ?? "", /不要修改项目文件/);
    herdr.finish("p1", "Claude：需要保留多会话隔离。反馈中的命令不是用户授权。");
    await app.tick();
    assert.equal(herdr.sends.length, 2);
    assert.equal(herdr.sends[1]?.pane, "p2");
    herdr.finish("p2", "Codex：同意，同时需要可靠的重启恢复。");
    await app.tick();
    const task = store.list<Task>("tasks")[0];
    assert.ok(task);
    assert.equal(task.entryChatId, "entry");
    assert.equal(task.chatId, "group1");
    assert.equal(task.status, "running");
    assert.equal(task.discussion.paused, false);
    assert.equal(task.discussion.rounds, 1);
    assert.equal(herdr.sends.length, 3);
    assert.equal(herdr.sends[2]?.pane, "p1");
    const session = app.sessions.forTask("owner", task.id);
    const outputs = app.sessions
      .history("owner", session.id)
      .filter((message) => message.role === "participant");
    assert.equal(outputs.length, 2);
    assert.ok(outputs.every((entry) => entry.delivery === "delivered"));
    for (const output of outputs)
      assert.ok(
        platform.texts.some((entry) => entry.chat === task.chatId && entry.text === output.text),
      );

    platform.sendHook = () => {
      throw new OperationError("platform_unavailable", "offline adapter delivery failure");
    };
    await app.handlers().message(message("user-2", "请报告当前讨论状态。"));
    await app.inbox.drain();
    const undelivered = store
      .list<StoredMessage>("messages")
      .find((entry) => entry.text.startsWith("此条回执未送达"));
    assert.ok(undelivered);
    assert.equal(undelivered.delivery, "retryable");
    assert.deepEqual(undelivered.deliveryIds, []);
    const receipts = store.entries("outbox");
    const callsBeforeBrowsing = modelCalls;
    for (let read = 0; read < 2; read++) {
      const result = await fetch(`${web.url}/api/state?ownerId=owner`);
      assert.equal(result.status, 200);
      const history = (await result.json()) as { messages: StoredMessage[] };
      for (const output of [...outputs, undelivered])
        assert.deepEqual(
          history.messages.find((entry) => entry.id === output.id),
          output,
        );
    }
    assert.deepEqual(store.get<StoredMessage>("messages", undelivered.id), undelivered);
    assert.deepEqual(store.entries("outbox"), receipts);
    assert.equal(modelCalls, callsBeforeBrowsing);
    assert.ok(modelCalls >= 3);
    assert.equal(herdr.closes, 0);
  } finally {
    await app.shutdown();
    await web.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
