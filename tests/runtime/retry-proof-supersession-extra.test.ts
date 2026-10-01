import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import {
  checkpointReduction,
  reductionMatches,
  retryAfterReduction,
} from "../../src/runtime/retry-proof.js";
import { SessionService } from "../../src/runtime/sessions.js";
import type { ConversationEngine, EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { response } from "./helpers.js";

const MAX = 16384;

function toolResult(text: string, toolCallId = "call"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "record",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}
const raw = JSON.stringify({ accepted: true, text: "x".repeat(40_000) });
const bounded = JSON.stringify({ accepted: true, reference: "rt1_abc", bytes: 40_000 });

test("a checkpoint and its own recovery are never proof against each other", () => {
  const checkpoint = [toolResult(raw)];
  const recovered = [toolResult(bounded)];
  // The first branch of the old decision compared a working array against the
  // recovered form. Anchoring that diff to `checkpoint.messages` instead does
  // not make it safe: for a legacy or already-recovered turn those raw bytes
  // are NOT the request the provider rejected (the engine received the bounded
  // view), so a smaller recovery of them proves nothing NEW.
  assert.equal(
    retryAfterReduction({ checkpoint, recovered, restoredCompleted: 0, limitBytes: 1_000_000 }),
    undefined,
    "an old reduction found by diffing a stale transcript is not new proof",
  );
  // The same transcript IS proof once a real save-time reduction binds it to
  // the durable record: the input really carried a raw oversized envelope and
  // the exact stored form is bounded.
  const reduction = checkpointReduction(checkpoint, recovered, MAX);
  assert.ok(reduction);
  assert.deepEqual(
    retryAfterReduction({
      checkpoint: recovered,
      recovered,
      reduction,
      restoredCompleted: 0,
      limitBytes: 1_000_000,
    }),
    recovered,
    "a save-time proof for the exact stored transcript still authorizes one retry",
  );
});

test("a save-time proof expires with the transcript it was bound to", () => {
  const reduction = checkpointReduction([toolResult(raw)], [toolResult(bounded)], MAX);
  assert.ok(reduction);
  // The latest failed request was persisted from an already-bounded view, so
  // the checkpoint now on disk carries no proof of its own.
  const latest = [toolResult(bounded), toolResult(bounded, "second")];
  assert.equal(reductionMatches(reduction, latest), false);
  assert.equal(
    retryAfterReduction({
      checkpoint: latest,
      recovered: latest,
      reduction,
      restoredCompleted: 0,
      limitBytes: 1_000_000,
    }),
    undefined,
    "a superseded reduction never authorizes an unchanged retry",
  );
});

for (const mutation of ["append", "replace"] as const)
  test(`a stale working history the engine ${mutation}s can never authorize a retry`, async () => {
    const store = new Store(":memory:");
    let calls = 0;
    let writes = 0;
    const canonical = { accepted: true, text: "x".repeat(40_000) };
    const write: RuntimeTool = {
      name: "record",
      description: "Record once",
      readOnly: false,
      parameters: { type: "object", properties: {} },
      execute: async () => {
        writes++;
        return canonical;
      },
    };
    const engine: ConversationEngine = {
      contextTokens: 50_000,
      summarize: async () => "",
      run: async (input: EngineInput) => {
        calls++;
        const result = await input.tools
          .find((tool) => tool.name === write.name)
          ?.execute({}, input.actor);
        assert.ok(input.projectToolResult);
        const stale: AgentMessage[] = [
          { role: "user", content: input.prompt, timestamp: 0 },
          response("", [{ type: "toolCall", name: write.name, id: "call", arguments: {} }]),
          toolResult(JSON.stringify(canonical)),
        ];
        // An engine may keep its own canonical working history and hand a
        // distinct bounded view to persistence. Both a growing array and an
        // array rewritten in place are outside SessionService's proof, because
        // neither is evidence of what the latest provider request carried.
        if (mutation === "append") input.messages.push(...stale);
        else {
          input.messages.length = 0;
          input.messages.push(...stale);
        }
        const projected = await input.projectToolResult({
          tool: write.name,
          toolCallId: "call",
          args: {},
          result,
        });
        assert.ok((projected as { reference?: string }).reference);
        await input.onCheckpoint?.([
          { role: "user", content: input.prompt, timestamp: 0 },
          response("", [{ type: "toolCall", name: write.name, id: "call", arguments: {} }]),
          toolResult(JSON.stringify(projected)),
        ]);
        throw new OperationError("context_budget", "cannot fit even after projection");
      },
    };
    try {
      const sessions = new SessionService(store, engine, { tools: () => [write] });
      const session = sessions.current("owner", "chat");
      const actor = {
        ownerId: "owner",
        chatId: "chat",
        sessionId: session.id,
        messageId: `stale-${mutation}`,
      };
      await assert.rejects(sessions.reply(actor, "Record within current constraints"), {
        code: "context_budget",
      });
      assert.equal(calls, 1, "a mutable engine array is not proof about the failed request");
      assert.equal(writes, 1, "the confirmed write is never executed twice");
      const checkpoint = store.get<{ messages: AgentMessage[]; reduction?: unknown }>(
        "pi_checkpoints",
        (await import("node:crypto"))
          .createHash("sha256")
          .update([actor.ownerId, actor.sessionId, actor.messageId].join("\0"))
          .digest("hex"),
      );
      assert.equal(
        checkpoint?.reduction,
        undefined,
        "an already-bounded save records no reduction proof",
      );
    } finally {
      store.close();
    }
  });
