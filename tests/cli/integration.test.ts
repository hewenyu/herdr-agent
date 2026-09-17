import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Application } from "../../src/app/application.js";
import { loadConfig } from "../../src/config/load.js";
import type { StoredMessage, Task } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { NOTIFICATION_PROMPT } from "../../src/runtime/prompts.js";
import { Store } from "../../src/storage/store.js";
import { startWeb } from "../../src/web/index.js";
import { config as modelConfig, response, scripted } from "../runtime/helpers.js";
import { FakeHerdr } from "../tasks/helpers.js";

test("real pi loop and HTTP Web create a discussion, herdr participants speak in turn, and rendered output is acknowledged", async () => {
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
          createGroup: false,
          createRemoteTask: false,
          discussion: { mode: "round_robin", maxRounds: 1, maxMinutes: 5 },
        },
      },
    ]),
    response("已创建讨论任务，Claude 与 Codex 将参与。"),
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
  const app = new Application({
    config,
    store,
    herdr,
    engine,
    logger: { info() {}, warn() {}, error() {} },
  });
  const web = await startWeb({
    listen: "127.0.0.1:0",
    backend: app,
    assets: { "index.html": "__CSRF_TOKEN__", "app.js": "", "styles.css": "" },
  });
  const csrf = await (await fetch(web.url)).text();
  const action = async (name: string, input: Record<string, unknown>) => {
    const result = await fetch(`${web.url}/api/actions`, {
      method: "POST",
      headers: {
        Origin: web.url,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: name, input }),
    });
    const body = (await result.json()) as { ok: boolean; result: Record<string, unknown> };
    assert.equal(result.status, 200, JSON.stringify(body));
    return body.result;
  };
  try {
    const answer = await action("chat.send", {
      text: "请让 Claude 和 Codex 讨论需求，本机运行。",
      requestId: "user-1",
    });
    assert.match(String(answer.text), /Claude 与 Codex/);
    assert.equal(store.list<Task>("tasks").length, 1);
    await action("chat.ack", { sessionId: answer.sessionId, messageId: answer.id });
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
    assert.equal(task.status, "review");
    assert.equal(task.discussion.paused, true);
    const session = app.sessions.forTask("owner", task.id);
    const outputs = app.sessions
      .history("owner", session.id)
      .filter((message) => message.role === "participant");
    assert.equal(outputs.length, 2);
    assert.ok(outputs.every((message) => message.delivery === "prepared"));
    await action("session.select", { id: session.id });
    await action("chat.ack", { sessionId: session.id, messageId: outputs[0]?.id });
    assert.equal(store.get<StoredMessage>("messages", outputs[0]?.id ?? "")?.delivery, "delivered");
    assert.ok(modelCalls >= 2);
    assert.equal(herdr.closes, 0);
  } finally {
    await app.shutdown();
    await web.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
