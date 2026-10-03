import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import { runTaskLeader } from "../../src/orchestration/leader-session.js";
import { boundCheckpointMessages } from "../../src/orchestration/leader-session-journal.js";
import {
  LEADER_CHECKPOINT_MAX_BYTES,
  LEADER_CHECKPOINT_MAX_MESSAGES,
  LEADER_RESULT_MAX_BYTES,
} from "../../src/orchestration/leader-session-types.js";
import type { ConversationEngine, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { response } from "../runtime/helpers.js";

/**
 * D3 strengthening of the checkpoint boundaries: full request equality through
 * a cold Store reopen, >12KiB out-of-line mandatory input, latest-batch
 * retention, nested escaping, and exact whole-array byte accounting. These are
 * stricter restatements of the parent review findings, never weaker ones.
 */

function actor(taskId: string, ownerId = "owner"): ActorContext {
  return {
    source: "system",
    ownerId,
    chatId: `chat-${taskId}`,
    sessionId: `orchestration:${taskId}`,
    taskId,
    messageId: "event",
  };
}

function result(id: string, text = '{"ok":true}'): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "inspect",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

function call(id: string): AgentMessage {
  return response("", [{ type: "toolCall", id, name: "inspect", arguments: {} }]);
}

function assertClosed(messages: AgentMessage[]) {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      assert.equal(pending.size, 0, "prior tool batch must be closed");
      for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
    } else if (message.role === "toolResult") {
      assert.ok(pending.delete(message.toolCallId), "a kept tool result must have its kept call");
    } else assert.equal(pending.size, 0, "non-tool messages must not interrupt a tool batch");
  }
  assert.equal(pending.size, 0, "the checkpoint ends with a closed batch");
}

/** Every assistant tool call keeps its matching result, and vice versa. */
function assertPaired(messages: AgentMessage[]) {
  const calls = new Set<string>();
  for (const message of messages)
    if (message.role === "assistant")
      for (const part of message.content) if (part.type === "toolCall") calls.add(part.id);
  for (const message of messages) {
    if (message.role === "toolResult")
      assert.ok(calls.has(message.toolCallId), `orphan tool result ${message.toolCallId}`);
  }
  assertClosed(messages);
}

function exactBytes(messages: AgentMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

test("checkpoint keeps the NEWEST complete batch and never an orphan result", () => {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < 90; index++) {
    messages.push(call(`call-${index}`), result(`call-${index}`));
  }
  const checkpoint = boundCheckpointMessages(messages, 262144, 80);
  assert.ok(checkpoint.messages.length <= 80);
  assertPaired(checkpoint.messages);
  // The newest batch must survive: dropping from the oldest end, not the newest.
  const kept = JSON.stringify(checkpoint.messages);
  assert.ok(kept.includes("call-89"), "the newest complete batch must be retained");
});

test("a closed checkpoint stays closed and no call is ever fabricated", () => {
  // Two guarantees: an already-closed transcript is reduced to another closed
  // transcript, and a kept tool result is always justified by a kept assistant
  // call — never by a synthesized one, and never with a truncated call id.
  const ids = Array.from({ length: 40 }, (_, index) => `c-${index}`);
  const closed: AgentMessage[] = [];
  for (const id of ids) closed.push(call(id), result(id));
  for (const budget of [4096, 8192, 262144]) {
    const checkpoint = boundCheckpointMessages(closed, budget, 80);
    const calls = new Set<string>();
    for (const message of checkpoint.messages)
      if (message.role === "assistant")
        for (const part of message.content) if (part.type === "toolCall") calls.add(part.id);
    for (const message of checkpoint.messages) {
      if (message.role !== "toolResult") continue;
      assert.ok(calls.has(message.toolCallId), `orphan tool result ${message.toolCallId}`);
    }
    assertClosed(checkpoint.messages);
  }
  // A pre-existing unpaired result is never "fixed" by inventing its call.
  const broken: AgentMessage[] = [result("orphan"), call("c-1"), result("c-1")];
  const repaired = boundCheckpointMessages(broken, 4096, 80);
  const synthesized = repaired.messages.filter(
    (message) =>
      message.role === "assistant" &&
      message.content.some((part) => part.type === "toolCall" && part.id === "orphan"),
  );
  assert.equal(synthesized.length, 0, "no assistant call may be fabricated for an orphan result");
});

test("checkpoint count limit counts the summary row and keeps whole batches", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "request", timestamp: 1 }];
  for (let index = 0; index < 50; index++) messages.push(call(`c-${index}`), result(`c-${index}`));
  const checkpoint = boundCheckpointMessages(messages, 512, 8);
  assert.ok(checkpoint.messages.length <= 8, `kept ${checkpoint.messages.length} messages`);
  assertPaired(checkpoint.messages);
});

test("checkpoint byte limit is exact and includes array framing plus summary metadata", () => {
  const messages: AgentMessage[] = Array.from({ length: 4 }, (_, index) => ({
    role: "user",
    content: `history-${index}:${"x".repeat(250)}`,
    timestamp: 1,
  }));
  for (const budget of [512, 1024, 2048, 4096]) {
    const checkpoint = boundCheckpointMessages(messages, budget, 80);
    const actual = exactBytes(checkpoint.messages);
    assert.equal(checkpoint.bytes, actual, "reported bytes must equal the exact stored array");
    assert.ok(actual <= budget, `budget ${budget} exceeded by ${actual} bytes`);
  }
  // An exactly-sized array is reported without an off-by-one.
  const two: AgentMessage[] = [
    { role: "user", content: "first", timestamp: 1 },
    { role: "user", content: "second", timestamp: 2 },
  ];
  const exact = exactBytes(two);
  assert.equal(boundCheckpointMessages(two, exact, 80).bytes, exact);
});

test("checkpoint tolerates nested escaping and multibyte content within budget", () => {
  const heavy = JSON.stringify({
    body: `${"\\".repeat(300)}\n\t${"审".repeat(80)}\u0000${'"'.repeat(60)}`,
  });
  const messages: AgentMessage[] = [call("call-0"), result("call-0", heavy)];
  const checkpoint = boundCheckpointMessages(messages, 1024, 80);
  assert.ok(exactBytes(checkpoint.messages) <= 1024);
  assertPaired(checkpoint.messages);
});

test("an irreducible oversized request fails typed instead of shrinking the checkpoint", () => {
  const huge = { role: "user" as const, content: "x".repeat(4096), timestamp: 1 };
  assert.throws(
    () => boundCheckpointMessages([], 512, 80, [huge]),
    (error: unknown) =>
      error instanceof OperationError && error.code === "orchestration_context_budget",
  );
});

test("dropping history is never silent: an unrepresentable marker fails typed", () => {
  // Two history rows cannot both fit a tiny budget. The reduction may not simply
  // drop one: an omission without a durable marker would let the model read a
  // gap as "nothing happened", so an impossible marker is refused typed.
  const messages: AgentMessage[] = [
    { role: "user", content: "first", timestamp: 1 },
    { role: "user", content: "second", timestamp: 2 },
  ];
  const exact = exactBytes(messages);
  const fits = boundCheckpointMessages(messages, exact, 80);
  assert.equal(fits.bytes, exact);
  assert.equal(fits.summarized, false);
  // One byte less already requires a reduction; it must stay inside the budget
  // or refuse, and whenever it reduces it must say so explicitly.
  const reduced = boundCheckpointMessages(messages, exact - 1, 80);
  assert.ok(reduced.bytes <= exact - 1);
  assert.equal(reduced.summarized, true, "a reduction must be marked as such");
  assert.throws(
    () => boundCheckpointMessages(messages, 40, 80),
    (error: unknown) =>
      error instanceof OperationError &&
      ["context_budget", "orchestration_context_budget"].includes(error.code),
    "an impossible marker must be a typed refusal, never a silent drop",
  );
});

/**
 * A newest batch that ALONE exceeds the whole checkpoint byte budget: one
 * assistant message with 20 tool calls closed by 20 tool results of ~16KiB text
 * each. Every result stays inside its own per-result repair, yet the closed
 * batch is larger than the entire checkpoint budget, so nothing of it can be
 * kept verbatim — the only honest representation left is the omission summary.
 */
function oversizedNewestBatch(olderText: string, newestText: string): AgentMessage[] {
  const calls = 20;
  return [
    { role: "user", content: olderText, timestamp: 1 },
    {
      role: "assistant",
      api: "openai-responses",
      provider: "myrix",
      model: "test",
      timestamp: 1,
      content: [
        { type: "text", text: newestText },
        ...Array.from({ length: calls }, (_, index) => ({
          type: "toolCall" as const,
          id: `new-${index}`,
          name: "inspect",
          arguments: {},
        })),
      ],
      stopReason: "toolUse",
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    ...Array.from(
      { length: calls },
      (_, index): AgentMessage => ({
        role: "toolResult",
        toolCallId: `new-${index}`,
        toolName: "inspect",
        content: [{ type: "text", text: `newest-result-${index}:${"x".repeat(16000)}` }],
        isError: false,
        timestamp: 1,
      }),
    ),
  ];
}

test("the last surviving batch is summarized too: the newest batch never vanishes silently", () => {
  // Confirmed regression in boundCheckpointMessages: once an older batch had been
  // dropped the `dropped` flag was set, so when the LAST surviving batch itself
  // could not fit, `if (!dropped) remember(kept[0])` skipped its omission marker.
  // The newest complete batch then disappeared from BOTH the stored messages and
  // the summary — the model would read a gap as "nothing happened".
  const olderText = "EARLIER-TURN";
  const newestText = "NEWEST-FINAL-BATCH";
  const fixture = oversizedNewestBatch(olderText, newestText);
  const [older, ...newest] = fixture;
  assert.ok(older && older.role === "user");
  // Fixture preconditions: the omission is forced, not incidental.
  assert.ok(
    exactBytes(newest) > LEADER_CHECKPOINT_MAX_BYTES,
    "fixture: the newest batch alone must exceed the whole byte budget",
  );
  for (const message of newest) {
    if (message.role !== "toolResult") continue;
    assert.ok(
      exactBytes([message]) <= LEADER_RESULT_MAX_BYTES,
      "fixture: every result must already fit its own per-result repair",
    );
  }

  const checkpoint = boundCheckpointMessages(
    fixture,
    LEADER_CHECKPOINT_MAX_BYTES,
    LEADER_CHECKPOINT_MAX_MESSAGES,
  );

  assert.equal(checkpoint.summarized, true);
  assert.ok(checkpoint.summary, "omitting a batch must leave an explicit durable summary");
  const summary = checkpoint.summary;
  const stored = JSON.stringify(checkpoint.messages);
  // Stronger than `summarized === true`: the omission must actually REPRESENT the
  // newest batch, and the stored transcript must carry that marker to the model.
  assert.ok(
    summary.includes(newestText),
    "the newest batch must be represented in the omission summary",
  );
  assert.ok(
    stored.includes(newestText),
    "the stored transcript must carry the newest batch's omission marker",
  );
  assert.ok(summary.includes(olderText), "the older omitted batch must stay represented too");
  assert.ok(stored.includes(olderText));
  // The marker accounts for the WHOLE omitted payload, including the newest batch
  // (the older batch alone is a few hundred bytes, far below the budget).
  const marker = JSON.parse(summary) as { bytes?: number };
  assert.ok(
    (marker.bytes ?? 0) > LEADER_CHECKPOINT_MAX_BYTES,
    `omitted bytes must cover the newest batch, got ${String(marker.bytes)}`,
  );
  // Every original constraint still holds after the fix.
  assert.equal(checkpoint.bytes, exactBytes(checkpoint.messages));
  assert.ok(checkpoint.bytes <= LEADER_CHECKPOINT_MAX_BYTES);
  assert.ok(checkpoint.messages.length <= LEADER_CHECKPOINT_MAX_MESSAGES);
  assertPaired(checkpoint.messages);
});

test("an unrepresentable omission marker is refused typed, never a silent newest-batch drop", () => {
  // The same forced-omission fixture under a budget too small to hold even the
  // minimal marker: no honest checkpoint exists, so the call must refuse with a
  // typed not-executed failure instead of returning a transcript whose newest
  // batch was dropped without a trace.
  const fixture = oversizedNewestBatch("EARLIER-TURN", "NEWEST-FINAL-BATCH");
  assert.throws(
    () => boundCheckpointMessages(fixture, 40, 80),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === "orchestration_context_budget" &&
      error.outcome === "not_executed",
    "an impossible omission marker must be a typed refusal, never a silent drop",
  );
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "leader-checkpoint-extra-"));
  return {
    directory,
    store: new Store(join(directory, "state.sqlite")),
    reopen() {
      const store = new Store(join(directory, "state.sqlite"));
      return store;
    },
    close(store: Store) {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("cold resume restores the COMPLETE out-of-line mandatory request in model messages", async () => {
  const h = fixture();
  const marker = "HARD_CONSTRAINT: never close this task without explicit user acceptance.";
  // Well above the 12288-byte inline budget: delivered once as a durable user
  // message, and it must still be there after 45 closed read batches.
  const request = JSON.stringify({
    requirements: "要".repeat(6000),
    prohibition: marker,
    escaped: `${"\\".repeat(200)}\u0000"`,
  });
  assert.ok(Buffer.byteLength(request, "utf8") > 12288, "fixture must exceed the inline budget");
  let resumedMessages: AgentMessage[] = [];

  let calls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      calls++;
      if (calls === 1) {
        const checkpoint: AgentMessage[] = [{ role: "user", content: request, timestamp: 1 }];
        for (let index = 0; index < 45; index++) {
          checkpoint.push(call(`read-${index}`), result(`read-${index}`));
        }
        await input.onCheckpoint?.(checkpoint);
        throw new OperationError("model_failed", "offline interrupted request", "not_executed");
      }
      resumedMessages = input.messages;
      return { text: "继续。", messages: input.messages };
    },
  };
  const tools: RuntimeTool[] = [
    {
      name: "inspect",
      description: "read",
      readOnly: true,
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    },
  ];
  const input = {
    store: h.store,
    engine,
    actor: actor("task-cold"),
    eventId: "event",
    revision: "revision",
    systemPrompt: "Follow all current mandatory requirements without granting new authority.",
    prompt: request,
    tools,
  };
  await assert.rejects(runTaskLeader(input), { code: "model_failed" });
  // Cold restart: a brand new Store over the same durable file.
  const cold = h.reopen();
  try {
    const resumed = await runTaskLeader({ ...input, store: cold });
    assert.equal(resumed.text, "继续。");
    assert.equal(calls, 2);
    // The checkpoint pins the COMPLETE canonical activation payload (the
    // out-of-line request row), so the model-visible messages carry every
    // mandatory field after a cold restart, not a prefix or a bare pointer.
    const activated = JSON.parse(request) as Record<string, unknown>;
    const carriers = resumedMessages.filter(
      (message): message is Extract<AgentMessage, { role: "user" }> =>
        message.role === "user" && typeof message.content === "string",
    );
    const pinned = carriers.find((message) =>
      (message.content as string).includes("要".repeat(100)),
    );
    assert.ok(pinned, "the complete original mandatory request must survive a cold resume");
    // The durable row is the canonical activation envelope of THIS activation;
    // the complete mandatory request is its `event` field, byte for byte.
    const envelope = JSON.parse(pinned.content as string) as Record<string, unknown>;
    assert.equal(envelope.event, request, "the complete mandatory request must be intact");
    assert.equal(envelope.eventId, "event");
    assert.equal(envelope.revision, "revision");
    const inner = JSON.parse(envelope.event as string) as Record<string, unknown>;
    assert.equal(inner.prohibition, activated.prohibition, "the exact mandatory tail must survive");
    assert.equal(inner.requirements, activated.requirements);
    assert.equal(inner.escaped, activated.escaped, "nested JSON escaping must round-trip");
    assert.ok(
      JSON.stringify(resumedMessages).includes(marker),
      "the trailing hard constraint must be model-visible after resume",
    );
    assert.ok(resumedMessages.length <= LEADER_CHECKPOINT_MAX_MESSAGES);
    assert.ok(exactBytes(resumedMessages) <= LEADER_CHECKPOINT_MAX_BYTES);
    assertClosed(resumedMessages);
    // The latest batch survives, so a resume continues from the newest state.
    const serialized = JSON.stringify(resumedMessages);
    assert.ok(serialized.includes("read-44"), "the newest read batch must be retained");
  } finally {
    h.close(cold);
    try {
      h.store.close();
    } catch {
      // The first handle was already closed by the cold store's file reuse.
    }
  }
});

test("a stale historical request row can never substitute for the current mandatory request", () => {
  const current = JSON.stringify({ taskId: "t", eventId: "e2", revision: "r2", event: "CURRENT" });
  const stale = JSON.stringify({ taskId: "t", eventId: "e1", revision: "r1", event: "STALE" });
  const messages: AgentMessage[] = [
    { role: "user", content: stale, timestamp: 1 },
    call("c1"),
    result("c1"),
  ];
  const checkpoint = boundCheckpointMessages(
    messages,
    LEADER_CHECKPOINT_MAX_BYTES,
    LEADER_CHECKPOINT_MAX_MESSAGES,
    [{ role: "user", content: current, timestamp: 2 }],
  );
  const serialized = JSON.stringify(checkpoint.messages);
  assert.ok(serialized.includes("CURRENT"), "the current mandatory request must be pinned");
  assert.ok(checkpoint.bytes === exactBytes(checkpoint.messages));
});

test("a projected oversized result is repaired against the whole message boundary", async () => {
  const h = fixture();
  const giant = { outcome: "ok", body: `${"\\".repeat(30000)}${"审".repeat(2000)}` };
  let observed = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      observed++;
      await input.onCheckpoint?.([
        { role: "user", content: input.prompt, timestamp: 1 },
        call("g1"),
        result("g1", JSON.stringify(giant)),
      ]);
      throw new OperationError("model_failed", "interrupted", "unknown");
    },
  };
  const input = {
    store: h.store,
    engine,
    actor: actor("task-whole"),
    eventId: "event",
    revision: "revision",
    systemPrompt: "bounded",
    prompt: "read the giant value",
    tools: [] as RuntimeTool[],
  };
  try {
    await assert.rejects(runTaskLeader(input), { code: "model_failed" });
    assert.equal(observed, 1);
    const checkpoints = h.store.list<{ messages: AgentMessage[]; bytes: number }>(
      "leader_checkpoints",
    );
    assert.equal(checkpoints.length, 1);
    const stored = checkpoints[0];
    assert.ok(stored);
    assert.ok(
      exactBytes(stored.messages) <= LEADER_CHECKPOINT_MAX_BYTES,
      "the stored transcript must fit the checkpoint budget",
    );
    assert.equal(stored.bytes, exactBytes(stored.messages));
    for (const message of stored.messages) {
      if (message.role !== "toolResult") continue;
      assert.ok(
        exactBytes([message]) <= LEADER_RESULT_MAX_BYTES,
        `stored tool result was ${exactBytes([message])} bytes`,
      );
    }
  } finally {
    h.close(h.store);
  }
});
