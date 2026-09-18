/** Read-only production history replay. All writes and tools use an isolated in-memory Store. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applicationTools } from "../../src/app/tools.js";
import { loadConfig } from "../../src/config/load.js";
import type { ActorContext, Session } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { SessionService } from "../../src/runtime/sessions.js";
import type { MessageRecord } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

async function run() {
  const sessionId = process.argv[2];
  if (!sessionId) throw new Error("Pass the existing session ID to replay read-only");
  const config = loadConfig();
  const database = new DatabaseSync(join(config.stateDir, "state.sqlite"), { readOnly: true });
  const store = new Store(":memory:");
  const calls: string[] = [];
  let sourceCount = 0;
  try {
    const row = database
      .prepare("SELECT value FROM records WHERE namespace='sessions' AND key=?")
      .get(sessionId) as { value: string } | undefined;
    assert.ok(row);
    const original = JSON.parse(row.value) as Session;
    assert.ok(!original.taskId, "only a main entry session can be replayed");
    store.set("sessions", sessionId, { ...original, archived: false });
    const messages = database
      .prepare(
        "SELECT key,value FROM records WHERE namespace='messages' AND json_extract(value,'$.sessionId')=?",
      )
      .all(sessionId) as Array<{ key: string; value: string }>;
    let sequence = 0;
    for (const message of messages) {
      const parsed = JSON.parse(message.value) as MessageRecord;
      store.set("messages", message.key, parsed);
      sequence = Math.max(sequence, parsed.sequence);
    }
    sourceCount = messages.length;
    store.set("message_sequence", sessionId, sequence);
    const cursor = database
      .prepare("SELECT value FROM records WHERE namespace='summary_cursor' AND key=?")
      .get(sessionId) as { value: string } | undefined;
    if (cursor) store.set("summary_cursor", sessionId, JSON.parse(cursor.value));
    database.close();
    const engine = new PiEngine({ ...config.ai, timeoutMs: 60_000 });
    let sessions: SessionService;
    sessions = new SessionService(store, engine, {
      tools: (actor) =>
        applicationTools({ sessions } as Parameters<typeof applicationTools>[0], actor)
          .filter((tool) => tool.name === "session_clear")
          .map((tool) => ({
            ...tool,
            execute: async (...args) => {
              calls.push(tool.name);
              return tool.execute(...args);
            },
          })),
    });
    const actor: ActorContext = {
      ownerId: original.ownerId,
      sessionId,
      source: "feishu",
      chatType: "private",
      chatId: "isolated-history-probe",
      messageId: `isolated-clear-${Date.now()}`,
    };
    sessions.select(actor.ownerId, actor.chatId, sessionId);
    const reply = await sessions.reply(actor, "/clear");
    const next = sessions.current(actor.ownerId, actor.chatId);
    assert.deepEqual(calls, ["session_clear"]);
    assert.notEqual(next.id, sessionId);
    assert.equal(sessions.get(actor.ownerId, sessionId).archived, true);
    assert.equal(sessions.get(actor.ownerId, sessionId).generation, original.generation);
    assert.equal(sessions.history(actor.ownerId, sessionId).length, sourceCount + 2);
    assert.equal(sessions.history(actor.ownerId, next.id).length, 0);
    assert.equal(sessions.beginDelivery(actor.ownerId, reply.id), true);
    process.stdout.write(
      `${JSON.stringify({ scenario: "production-history-clear", sourceHistoryCount: sourceCount, toolsCalled: calls, oldSessionArchived: true, oldHistoryPreserved: true, newSessionSelected: true, newHistoryEmpty: true, oldReplyDeliverable: true, response: reply.text, evidence: "real_model; production_history_read_only; in_memory_writes_only; no_external_tools_or_messages" })}\n`,
    );
  } finally {
    if (database.isOpen) database.close();
    store.close();
  }
}
void run().catch(() => {
  process.stderr.write("旧历史 clear 探针未通过；未输出历史或配置。\n");
  process.exitCode = 1;
});
