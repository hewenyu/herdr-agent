/** Real model with in-memory synthetic history and session effects; no Feishu/herdr writes. */
import assert from "node:assert/strict";
import { applicationTools } from "../../src/app/tools.js";
import { loadConfig } from "../../src/config/load.js";
import type { ActorContext } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { SessionService } from "../../src/runtime/sessions.js";
import type { ConversationEngine, SummaryInput } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

async function run() {
  const config = loadConfig();
  const store = new Store(":memory:");
  const model = new PiEngine({ ...config.ai, contextTokens: 16384, timeoutMs: 60_000 });
  const toolsCalled: string[] = [];
  let summaries = 0;
  const engine: ConversationEngine = {
    contextTokens: model.contextTokens,
    run: (input) => model.run(input),
    summarize: (input: SummaryInput) => {
      summaries++;
      return model.summarize(input);
    },
  };
  let sessions: SessionService;
  sessions = new SessionService(store, engine, {
    tools: (actor) =>
      applicationTools({ sessions } as Parameters<typeof applicationTools>[0], actor)
        .filter((tool) => tool.name === "session_clear")
        .map((tool) => ({
          ...tool,
          execute: async (...args) => {
            toolsCalled.push(tool.name);
            return tool.execute(...args);
          },
        })),
  });
  try {
    const session = sessions.current("probe-owner", "probe-private-entry");
    const actor: ActorContext = {
      source: "feishu",
      chatType: "private",
      ownerId: "probe-owner",
      chatId: "probe-private-entry",
      sessionId: session.id,
      messageId: "probe-compaction",
    };
    for (let index = 1; index <= 22; index++)
      store.set("messages", `fixture-${index}`, {
        id: `fixture-${index}`,
        sessionId: session.id,
        role: "user",
        source: "user",
        text: `合成历史第${index}轮：只讨论调度工具，不创建或关闭任务；保留已有项目代码。${"主机器人管理多个pi会话，Claude和Codex交由herdr托管。".repeat(28)}`,
        createdAt: new Date(index * 1000).toISOString(),
        delivery: "delivered",
        deliveryIds: [`fixture-message-${index}`],
        generation: 0,
        sequence: index,
      });
    store.set("message_sequence", session.id, 22);
    const reply = await sessions.reply(
      actor,
      "继续只讨论本工具。简要复述此前的约束，不执行任务操作。",
    );
    assert.ok(summaries > 0);
    assert.ok(sessions.get(actor.ownerId, session.id).summary);
    assert.equal(sessions.history(actor.ownerId, session.id).length, 24);
    assert.equal(sessions.current(actor.ownerId, actor.chatId).id, session.id);
    assert.equal(toolsCalled.length, 0);
    sessions.beginDelivery(actor.ownerId, reply.id);
    sessions.recordDelivery(actor.ownerId, reply.id, { complete: true, ids: ["fixture-ack"] });
    process.stdout.write(
      `${JSON.stringify({ scenario: "automatic-compaction", summaries, sessionUnchanged: true, rawHistoryPreserved: true, response: reply.text, evidence: "real_model; in_memory_synthetic_history; no_external_resource_effects" })}\n`,
    );
    const reset = await sessions.reply({ ...actor, messageId: "probe-clear" }, "/clear");
    const next = sessions.current(actor.ownerId, actor.chatId);
    assert.deepEqual(toolsCalled, ["session_clear"]);
    assert.notEqual(next.id, session.id);
    assert.equal(sessions.get(actor.ownerId, session.id).generation, 0);
    assert.equal(sessions.get(actor.ownerId, session.id).archived, true);
    assert.equal(sessions.beginDelivery(actor.ownerId, reset.id), true);
    assert.equal(sessions.history(actor.ownerId, next.id).length, 0);
    process.stdout.write(
      `${JSON.stringify({ scenario: "manual-clear-new-session", toolsCalled, newSessionSelected: true, oldReplyDeliverable: true, oldGenerationPreserved: true, newHistoryEmpty: true, response: reset.text, evidence: "real_model; actual_session_service_in_memory; no_feishu_or_herdr_effects" })}\n`,
    );
  } finally {
    store.close();
  }
}
void run().catch(() => {
  process.stderr.write("入口压缩/新会话探针未全部完成，未输出配置。\n");
  process.exitCode = 1;
});
