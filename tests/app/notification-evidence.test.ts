import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import { loadConfig } from "../../src/config/load.js";
import type { ActorContext } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type {
  ConversationEngine,
  EngineInput,
  EngineResult,
  RuntimeTool,
} from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config as modelConfig, response, scripted } from "../runtime/helpers.js";
import { FakeHerdr, FakePlatform } from "../tasks/helpers.js";

const actor: ActorContext = {
  ownerId: "owner",
  chatId: "entry",
  sessionId: "pi-entry",
  messageId: "create-task",
};

class RecordingPlatform extends FakePlatform {
  readonly texts: Array<{ chat: string; text: string; key: string }> = [];

  override async sendText(chat = "", text = "", key = ""): Promise<string> {
    this.texts.push({ chat, text, key });
    return `message-${this.texts.length}`;
  }
}

function applicationWithPi(stream: Parameters<typeof scripted>[0]) {
  const directory = mkdtempSync(join(tmpdir(), "herdr-notice-evidence-"));
  const store = new Store(join(directory, "state.sqlite"));
  const config = loadConfig({ stateDir: directory, home: directory, cwd: directory, env: {} });
  config.ai.enabled = true;
  config.tasks.enabled = true;
  config.feishu.allowedOpenIds = ["owner"];
  const platform = new RecordingPlatform();
  const herdr = new FakeHerdr();
  const inputs: EngineInput[] = [];
  const results: EngineResult[] = [];
  const pi = new PiEngine(modelConfig, { streamFn: scripted(stream) });
  const engine: ConversationEngine = {
    contextTokens: pi.contextTokens,
    async run(input) {
      inputs.push(input);
      const result = await pi.run(input);
      results.push(result);
      return result;
    },
    summarize: (input) => pi.summarize(input),
  };
  const app = new Application({ config, store, herdr, platform, engine });
  return {
    app,
    store,
    inputs,
    results,
    platform,
    close: async () => {
      await app.shutdown();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("lifecycle notice trusts its task snapshot without forcing a write tool", async () => {
  const h = applicationWithPi([
    response('{"notify":true,"text":"模型确认：群已创建。"}'),
    response('{"notify":false,"text":""}'),
    response('{"notify":false,"text":""}'),
  ]);
  try {
    const task = await h.app.tasks.create(actor, {
      kind: "discussion",
      title: "通知快照任务",
      requirements: "只验证生命周期通知",
      participants: [{ kind: "codex" }],
      createGroup: true,
      createRemoteTask: false,
    });
    await h.app.tasks.reconcile(task.id);
    const created = h.app.tasks.get(actor, task.id);
    assert.equal(created.chatId, "group1");
    assert.equal(h.platform.groups, 1);
    assert.equal(h.inputs.length, 3, "group_ready, welcome and progress each generate once");
    assert.equal(h.inputs[0] && JSON.parse(h.inputs[0].prompt).task.chatId, "group1");
    for (const input of h.inputs) {
      assert.equal(input.enforceClaims, false);
      assert.ok(input.tools.length > 0);
      assert.ok(input.tools.every((tool) => tool.readOnly));
      assert.equal(
        input.tools.some((tool) => !tool.readOnly),
        false,
      );
      assert.equal(input.tools.find((tool) => tool.name === "task_get")?.readOnly, true);
    }
    assert.equal(h.results[0]?.toolCalls, 0);
    assert.equal(h.results[0]?.writeCalls, 0);
    assert.deepEqual(h.results[0]?.toolEvidence, {
      successful: 0,
      successfulWrites: 0,
      unknown: 0,
      notExecuted: 0,
    });
    assert.equal(h.platform.texts.length, 1);
    assert.equal(h.platform.texts[0]?.text, "模型确认：群已创建。");
    await h.app.tasks.reconcile(task.id);
    assert.equal(h.inputs.length, 3, "reconciling again does not replay lifecycle notices");
  } finally {
    await h.close();
  }
});

test("ordinary user claims still require a write fact after a read-only lookup", async () => {
  const pi = new PiEngine(modelConfig, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "read", name: "task_get", arguments: {} }]),
      response("群已创建。"),
      response("群已创建。"),
    ]),
  });
  const readOnly: RuntimeTool = {
    name: "task_get",
    description: "读取当前任务快照",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute: async () => ({ chatId: "group-created-by-platform" }),
  };

  await assert.rejects(
    pi.run({
      actor,
      sessionId: actor.sessionId,
      prompt: "创建群",
      messages: [],
      systemPrompt: "普通用户业务请求",
      tools: [readOnly],
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "model_failed" &&
      "outcome" in error &&
      (error as { outcome?: string }).outcome === "not_executed",
  );
});
