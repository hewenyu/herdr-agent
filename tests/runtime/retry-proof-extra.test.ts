import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import { recoveryCheckpointLimit } from "../../src/runtime/recovery.js";
import {
  checkpointReduction,
  recoveredReduction,
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
const raw = (size = 40_000) => JSON.stringify({ accepted: true, text: "x".repeat(size) });
const bounded = JSON.stringify({ accepted: true, reference: "rt1_abc", bytes: 40_000 });
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");

test("an already-bounded checkpoint input is never a durable reduction", () => {
  // The exact shape of the released false positive: the failed request already
  // contains the bounded reference, so storing it proves nothing new.
  assert.equal(checkpointReduction([toolResult(bounded)], [toolResult(bounded)], MAX), undefined);
  // A previously saved reference is not new reduction either, however many
  // references the transcript holds.
  const references = [toolResult(bounded, "a"), toolResult(bounded, "b")];
  assert.equal(checkpointReduction(references, references, MAX), undefined);
});

test("a save-time reduction proof is bound to the exact stored transcript", () => {
  const input = [toolResult(raw()), toolResult(bounded, "other")];
  const stored = [toolResult(bounded), toolResult(bounded, "other")];
  const proof = checkpointReduction(input, stored, MAX);
  assert.ok(proof, "an oversized input stored bounded is a real reduction");
  assert.equal(proof.projected, 1);
  assert.equal(reductionMatches(proof, stored), true, "the proof matches what was stored");
  // A later, different save overwrites the transcript and expires the proof.
  const superseded = [toolResult(bounded), toolResult(bounded, "other"), toolResult(bounded, "c")];
  assert.equal(reductionMatches(proof, superseded), false, "a changed transcript is not proven");
  assert.equal(reductionMatches(undefined, stored), false, "no proof is never a proof");
  // Dropping a message is not evidence either: the measured envelopes must be
  // the ones that were really reduced.
  assert.equal(checkpointReduction([toolResult(bounded)], [toolResult(bounded)], MAX), undefined);
});

test("prompt, metadata and stripped error differences are never reduction evidence", () => {
  const failed = [toolResult(raw())];
  const promptOnly = [
    { role: "user", content: "an inserted prompt", timestamp: 9 } as AgentMessage,
    toolResult(raw()),
  ];
  assert.equal(recoveredReduction(failed, promptOnly, MAX), false, "prompt insertion is not proof");
  const metadataOnly = [
    { ...toolResult(raw()), timestamp: 12345, details: { note: "extra metadata" } } as AgentMessage,
  ];
  assert.equal(recoveredReduction(failed, metadataOnly, MAX), false, "metadata is not proof");
  const strippedError = [
    response("", []),
    {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "provider failed",
      timestamp: 2,
    } as unknown as AgentMessage,
    toolResult(raw()),
  ];
  assert.equal(
    recoveredReduction(failed, strippedError, MAX),
    false,
    "stripping an assistant error does not shrink a tool result",
  );
  // The genuine signal: the same call's envelope is inside the budget after
  // recovery and strictly smaller than the oversized one that failed.
  assert.equal(
    recoveredReduction(failed, [toolResult(bounded)], MAX),
    true,
    "bounding an oversized envelope of the failed request is proof",
  );
  assert.equal(
    recoveredReduction(failed, [toolResult(bounded, "another-call")], MAX),
    false,
    "a different call identity proves nothing about this request",
  );
});

test("retryAfterReduction fails closed unless a new reduction or receipt is proven", () => {
  const limitBytes = recoveryCheckpointLimit(50_000);
  const request = [toolResult(bounded)];
  const base = { request, checkpoint: [toolResult(bounded)], recovered: request, limitBytes };
  assert.equal(retryAfterReduction({ ...base, restoredCompleted: 0 }), undefined);
  assert.deepEqual(
    retryAfterReduction({ ...base, restoredCompleted: 1 }),
    request,
    "an exact restored receipt is a real repair of the failed request",
  );
  const oversized = [toolResult("y".repeat(limitBytes + 1000))];
  assert.equal(
    retryAfterReduction({
      ...base,
      recovered: oversized,
      restoredCompleted: 1,
      limitBytes,
    }),
    undefined,
    "a recovered transcript that still cannot fit one request is never retried",
  );
  assert.equal(retryAfterReduction({ ...base, recovered: [], restoredCompleted: 1 }), undefined);
});

test("a cold-recovered repaired request is not replayed after another budget failure", async () => {
  const store = new Store(":memory:");
  const requests: EngineInput[] = [];
  const engine: ConversationEngine = {
    contextTokens: 50_000,
    summarize: async () => "",
    run: async (input) => {
      requests.push(input);
      throw new OperationError("context_budget", "still too large", "not_executed");
    },
  };
  try {
    const sessions = new SessionService(store, engine, { tools: () => [] });
    const session = sessions.current("owner", "chat");
    const actor = {
      ownerId: "owner",
      chatId: "chat",
      sessionId: session.id,
      messageId: "cold-budget",
    };
    const receiptId = (await import("node:crypto"))
      .createHash("sha256")
      .update([actor.ownerId, actor.sessionId, actor.messageId].join("\0"))
      .digest("hex");
    // A legacy checkpoint left behind by a crash: raw oversized result, no
    // save-time proof exists for it (it was never written through this build).
    store.set("turn_receipts", receiptId, {
      generation: 0,
      status: "failed",
      replyId: `reply_${receiptId}`,
      recoveryVersion: 1,
      attempts: 1,
    });
    store.set("messages", `user_${receiptId}`, {
      id: `user_${receiptId}`,
      sessionId: session.id,
      role: "user",
      source: "user",
      text: "记录",
      createdAt: new Date().toISOString(),
      delivery: "delivered",
      deliveryIds: [actor.messageId],
      generation: 0,
      sequence: 1,
    });
    store.set("pi_checkpoints", receiptId, {
      sessionId: session.id,
      generation: 0,
      messages: [
        { role: "user", content: "记录", timestamp: 1 },
        response("", [{ type: "toolCall", name: "record", id: "call", arguments: {} }]),
        toolResult(raw(200_000)),
      ],
      updatedAt: new Date().toISOString(),
    });
    await assert.rejects(sessions.reply(actor, "记录"), { code: "context_budget" });
    assert.equal(requests.length, 1, "the repaired request is not replayed unchanged");
    assert.equal(requests[0]?.resume, true);
    assert.ok(
      bytes(requests[0]?.messages ?? []) < 100_000,
      "the single request was already bounded by recovery",
    );
    // The legacy bytes were repaired at turn start (B3 behavior), but that
    // repair is not proof that the request which just failed was reduced, so it
    // must not authorize replaying this same request.
    const checkpoint = store.get<{ messages?: AgentMessage[]; reduction?: unknown }>(
      "pi_checkpoints",
      receiptId,
    );
    assert.ok(
      bytes(checkpoint?.messages ?? []) < 100_000,
      "the repaired checkpoint is durable and bounded",
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

test("a live reduction is still retried once through the durable checkpoint", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  let writes = 0;
  const canonical = { accepted: true, text: "x".repeat(60_000) };
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
    run: async (input) => {
      calls++;
      if (calls === 1) {
        const result = await input.tools
          .find((tool) => tool.name === write.name)
          ?.execute({}, input.actor);
        // The engine hands the RAW canonical envelope to persistence, exactly
        // like a checkpoint written before the projection bound existed.
        await input.onCheckpoint?.([
          { role: "user", content: input.prompt, timestamp: 1 },
          response("", [{ type: "toolCall", name: write.name, id: "call", arguments: {} }]),
          toolResult(JSON.stringify(result)),
        ]);
        throw new OperationError("context_budget", "reduce the durable context", "not_executed");
      }
      assert.equal(input.resume, true);
      assert.ok(bytes(input.messages) <= 100_000, "the retry resumes the reduced checkpoint");
      assert.ok(input.messages.some((message) => message.role === "toolResult"));
      return {
        text: "已登记。",
        messages: input.messages,
        toolCalls: 1,
        writeCalls: 1,
        toolEvidence: { successful: 1, successfulWrites: 1, unknown: 0, notExecuted: 0 },
      };
    },
  };
  try {
    const sessions = new SessionService(store, engine, { tools: () => [write] });
    const session = sessions.current("owner", "chat");
    await sessions.reply(
      { ownerId: "owner", chatId: "chat", sessionId: session.id, messageId: "live-reduction" },
      "记录",
    );
    assert.equal(calls, 2, "a real durable reduction retries exactly once");
    assert.equal(writes, 1, "the confirmed write is never executed twice");
  } finally {
    store.close();
  }
});
