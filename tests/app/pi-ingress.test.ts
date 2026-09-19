import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Application } from "../../src/app/application.js";
import type { InboxRecord } from "../../src/app/inbox.js";
import { loadConfig } from "../../src/config/load.js";
import { normalizeMessage } from "../../src/feishu/normalize.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { Store } from "../../src/storage/store.js";
import { config as modelConfig, response, scripted } from "../runtime/helpers.js";
import { FakeHerdr } from "../tasks/helpers.js";
import { logger, Platform } from "./helpers.js";

// Offline integration: the provider stream and external transports are fixtures;
// normalization, durable ingress, pi's tool loop and application tools are real.
function setupIngress(messages: AssistantMessage[]) {
  const directory = mkdtempSync(join(tmpdir(), "myrix-pi-ingress-"));
  const store = new Store(join(directory, "state.sqlite"));
  const config = loadConfig({ stateDir: directory, home: directory, cwd: directory, env: {} });
  config.ai = { ...modelConfig };
  config.tasks.enabled = true;
  config.feishu.allowedOpenIds = ["owner"];
  const contexts: Parameters<StreamFn>[1][] = [];
  const choices: unknown[] = [];
  const stream = scripted(messages, (context) =>
    contexts.push(JSON.parse(JSON.stringify(context))),
  );
  const engine = new PiEngine(config.ai, {
    streamFn: (model, context, options) => {
      choices.push((options as { toolChoice?: unknown } | undefined)?.toolChoice);
      return stream(model, context, options);
    },
  });
  const platform = new Platform();
  const herdr = new FakeHerdr();
  const app = new Application({ config, store, engine, platform, herdr, logger });
  return {
    app,
    store,
    platform,
    herdr,
    contexts,
    choices,
    async close() {
      await app.shutdown();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function event(text: string, format: "text" | "post" = "text", eventId = "event-1") {
  return {
    header: { event_id: eventId },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: "owner" } },
      message: {
        message_id: "message-1",
        chat_id: "entry",
        chat_type: "p2p",
        message_type: format,
        content: JSON.stringify(
          format === "text"
            ? { text }
            : { zh_cn: { title: "", content: [[{ tag: "text", text }]] } },
        ),
      },
    },
  };
}

for (const [request, format, participants] of [
  ["让 Claude 和 Codex 讨论这个需求", "text", ["claude", "codex"]],
  ["拉个群，让 Claude 和 Codex 一起讨论", "post", ["claude", "codex"]],
  ["开个讨论任务，让 Claude 帮我梳理这个需求", "text", ["claude"]],
] as const) {
  test(`Feishu ${format} ingress recovers zero-tool acknowledgement for ${request}`, async () => {
    const requirements = `${request}。禁止编码、写文件、运行测试，讨论结束后等待我验收。`;
    const answer = "已登记讨论任务，等待调度。";
    const h = setupIngress([
      response("收到。"),
      response("", [
        {
          type: "toolCall",
          id: "create-discussion",
          name: "task_create",
          arguments: {
            kind: "discussion",
            title: "需求讨论",
            requirements,
            participants: participants.map((kind) => ({ kind })),
            createGroup: true,
            createRemoteTask: true,
          },
        },
      ]),
      response(answer),
    ]);
    try {
      const incoming = normalizeMessage(event(requirements, format), "bot");
      assert.ok(incoming);
      await h.app.handlers().message(incoming);
      const queued = h.store.get<InboxRecord>("inbox", "message:message-1");
      assert.equal(queued?.state, "queued");
      assert.equal(queued?.actor?.source, "feishu");
      assert.equal(queued?.actor?.chatType, "private");
      assert.equal(h.contexts.length, 0);
      await h.app.inbox.drain();

      assert.equal(h.store.get<InboxRecord>("inbox", "message:message-1")?.state, "done");
      assert.equal(h.contexts.length, 3);
      assert.deepEqual(h.contexts[0]?.messages.at(-1)?.content, [
        { type: "text", text: requirements },
      ]);
      assert.deepEqual(h.choices, [undefined, "required", undefined]);
      const tasks = h.app.tasks.records.list("owner", true);
      assert.equal(tasks.length, 1);
      const task = tasks[0];
      assert.ok(task);
      assert.equal(task.sessionId, queued?.actor?.sessionId);
      assert.equal(task.entryChatId, "entry");
      assert.equal(task.requirements, requirements);
      assert.equal(task.status, "queued");
      assert.equal(task.project, undefined);
      assert.equal(task.createGroup, true);
      assert.equal(task.createRemoteTask, true);
      assert.deepEqual(
        h.app.tasks.records.participants(task).map((participant) => participant.kind),
        participants,
      );
      const results = h.contexts[2]?.messages.filter((message) => message.role === "toolResult");
      assert.equal(results?.length, 1);
      assert.equal(results[0]?.toolName, "task_create");
      assert.equal(results[0]?.isError, false);
      assert.match(JSON.stringify(results[0]?.content), /accepted/);
      assert.match(JSON.stringify(results[0]?.content), /queued/);
      assert.deepEqual(
        h.platform.texts.map((message) => message.text),
        [answer],
      );
      assert.equal(h.platform.groups, 0);
      assert.equal(h.platform.creates, 0);
      assert.equal(h.herdr.creates, 0);
      assert.equal(h.herdr.sends.length, 0);
      const history = h.app.sessions.history("owner", task.sessionId);
      assert.equal(history.at(-1)?.text, answer);
      assert.equal(history.at(-1)?.delivery, "delivered");
      assert.ok(h.store.entries("pi_checkpoints").length > 0);

      const duplicate = normalizeMessage(event(requirements, format, "redelivered"), "bot");
      assert.ok(duplicate);
      await h.app.handlers().message(duplicate);
      await h.app.inbox.drain();
      assert.equal(h.contexts.length, 3);
      assert.equal(h.app.tasks.records.list("owner", true).length, 1);
      assert.equal(h.platform.texts.length, 1);
    } finally {
      await h.close();
    }
  });
}

for (const request of [
  "不要让 Claude 和 Codex 讨论这个需求，也不要创建任务或拉群。",
  "只解释如何让 Claude 和 Codex 参与讨论，不要执行。",
  "例如：让 Claude 和 Codex 讨论这个需求。",
]) {
  test(`Feishu ingress preserves non-action constraint: ${request}`, async () => {
    const answer = "这里只说明配置和操作方式。";
    const h = setupIngress([response(answer)]);
    try {
      const incoming = normalizeMessage(event(request), "bot");
      assert.ok(incoming);
      await h.app.handlers().message(incoming);
      await h.app.inbox.drain();
      assert.equal(h.store.get<InboxRecord>("inbox", "message:message-1")?.state, "done");
      assert.equal(h.contexts.length, 1);
      assert.deepEqual(h.choices, [undefined]);
      assert.deepEqual(h.contexts[0]?.messages.at(-1)?.content, [{ type: "text", text: request }]);
      assert.equal(h.app.tasks.records.list("owner", true).length, 0);
      assert.equal(h.platform.groups, 0);
      assert.equal(h.platform.creates, 0);
      assert.equal(h.herdr.creates, 0);
      assert.equal(h.herdr.sends.length, 0);
      assert.deepEqual(
        h.platform.texts.map((message) => message.text),
        [answer],
      );
    } finally {
      await h.close();
    }
  });
}
