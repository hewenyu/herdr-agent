import assert from "node:assert/strict";
import test from "node:test";
import {
  createLeaderTemplateChoice,
  PLANNING_CHOICES,
} from "../../src/orchestration/leader-planning.js";
import {
  LEADER_INBOX,
  type LeaderInboxRecord,
  leaderSessionId,
} from "../../src/orchestration/leader-session-types.js";
import type { ConversationEngine } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

const CANDIDATES = [
  { id: "first", description: "First legal planning mode" },
  { id: "second", description: "Second legal planning mode" },
];

interface RawChoice {
  state?: "accepted" | "invalidated";
  revision: string;
  candidateId?: string;
  ownerId: string;
  taskId: string;
  sessionId: string;
  at: string;
}

/** The exact key `createLeaderTemplateChoice` derives for one actor scope. */
function choiceKey(eventId: string, ownerId: string, taskId: string): string {
  return [eventId, ownerId, taskId, leaderSessionId(taskId)].join("\u0000");
}

function rawChoice(
  store: Store,
  eventId: string,
  ownerId: string,
  taskId: string,
): RawChoice | undefined {
  return store.get<RawChoice>(PLANNING_CHOICES, choiceKey(eventId, ownerId, taskId));
}

/** Throw only AFTER a real SQLite transaction commits, never inside it. */
function crashAfterLeaderCommit(store: Store) {
  const transaction = store.transaction.bind(store);
  const state = { armed: true };
  store.transaction = <T>(fn: () => T): T => {
    const value = transaction(fn);
    if (
      state.armed &&
      store.list<LeaderInboxRecord>(LEADER_INBOX).some((entry) => entry.state === "recorded")
    ) {
      state.armed = false;
      throw new Error("simulated process loss after completed Leader commit");
    }
    return value;
  };
  return { exercised: () => !state.armed };
}

function select(
  store: Store,
  engine: ConversationEngine,
  overrides: Partial<{ ownerId: string; taskId: string; revision: string; eventId: string }> = {},
) {
  const ownerId = overrides.ownerId ?? "owner";
  const taskId = overrides.taskId ?? "task";
  const eventId = overrides.eventId ?? "choice-event";
  return createLeaderTemplateChoice({
    store,
    engine,
    actor: {
      ownerId,
      taskId,
      sessionId: leaderSessionId(taskId),
      chatId: "chat",
      messageId: eventId,
    },
    eventId,
    revision: overrides.revision ?? "revision",
  })({
    candidates: CANDIDATES,
    snapshot: { requirements: "Only discuss; never deploy or close." },
    instructions: "Choose a legal planning mode",
    current: () => {},
  });
}

test("an illegal selection taints a later legal retry within the same activation", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      calls++;
      const tool = input.tools.find((entry) => entry.name === "orchestration_choice");
      assert.ok(tool);
      await assert.rejects(tool.execute({ candidateId: "not-a-candidate" }, input.actor), {
        code: "workflow_choice",
      });
      // A legal call after the illegal one must be refused: otherwise the
      // activation could still end as an accepted choice.
      await assert.rejects(tool.execute({ candidateId: "first" }, input.actor), {
        code: "workflow_choice",
      });
      return { text: "", messages: [] };
    },
  };
  try {
    const first = await select(store, engine);
    assert.equal(first.status, "invalid");
    assert.equal(first.reason, "illegal_selection");
    assert.equal(calls, 1);
    assert.notEqual(rawChoice(store, "choice-event", "owner", "task")?.state, "accepted");
    // With no durable acceptance, a cold restart of the same event+revision
    // returns the recorded Leader receipt and can never invent a selection.
    const retry = await select(store, engine);
    assert.notEqual(retry.status, "success");
    assert.equal(retry.reason, "empty_selection");
    assert.equal(calls, 1, "the recorded activation is not rerun for the same event+revision");
  } finally {
    store.close();
  }
});

test("a first selection revoked by a second call is not silently reused after restart", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      calls++;
      const tool = input.tools.find((entry) => entry.name === "orchestration_choice");
      assert.ok(tool);
      await tool.execute({ candidateId: "first" }, input.actor);
      // `first` is durable now. The second selection makes the activation
      // invalid; recovery must never fall back to that accepted draft.
      await assert.rejects(tool.execute({ candidateId: "second" }, input.actor), {
        code: "workflow_choice",
      });
      return { text: "", messages: [] };
    },
  };
  try {
    const first = await select(store, engine);
    assert.equal(first.status, "invalid");
    assert.equal(rawChoice(store, "choice-event", "owner", "task")?.state, "invalidated");
    const retry = await select(store, engine);
    assert.notEqual(retry.status, "success", "a revoked acceptance is not replayable");
    assert.equal(retry.reason, "empty_selection");
    assert.equal(calls, 1, "the recorded activation is not rerun for the same event+revision");
  } finally {
    store.close();
  }
});

test("a non-first accepted candidate survives a crash after commit but before handoff", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const crash = crashAfterLeaderCommit(store);
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      calls++;
      const tool = input.tools.find((entry) => entry.name === "orchestration_choice");
      assert.ok(tool);
      await tool.execute({ candidateId: "second" }, input.actor);
      return { text: "", messages: [] };
    },
  };
  try {
    const lost = await select(store, engine);
    assert.equal(crash.exercised(), true, "the post-commit crash window must be exercised");
    assert.notEqual(lost.status, "success", "the handoff crash is observable to the caller");
    assert.equal(calls, 1);
    assert.equal(store.list<LeaderInboxRecord>(LEADER_INBOX)[0]?.state, "recorded");
    const recovered = await select(store, engine);
    assert.equal(recovered.status, "success");
    assert.equal(recovered.candidateId, "second", "exact accepted candidate, not the first draft");
    assert.equal(calls, 1, "a completed model activation is never rerun");
  } finally {
    store.close();
  }
});

test("a pre-upgrade selection row without an accepted state is never replayed", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      calls++;
      const tool = input.tools.find((entry) => entry.name === "orchestration_choice");
      assert.ok(tool);
      await tool.execute({ candidateId: "second" }, input.actor);
      return { text: "", messages: [] };
    },
  };
  try {
    store.set<RawChoice>(PLANNING_CHOICES, choiceKey("choice-event", "owner", "task"), {
      revision: "revision",
      candidateId: "first",
      ownerId: "owner",
      taskId: "task",
      sessionId: leaderSessionId("task"),
      at: new Date().toISOString(),
    });
    const result = await select(store, engine);
    assert.equal(result.status, "success");
    assert.equal(result.candidateId, "second", "a legacy row without state is not authoritative");
    assert.equal(calls, 1, "a malformed legacy row cannot replace a real decision");
  } finally {
    store.close();
  }
});

test("a crashed accepted choice is never reused across task, event or owner scope", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const crash = crashAfterLeaderCommit(store);
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      calls++;
      const tool = input.tools.find((entry) => entry.name === "orchestration_choice");
      assert.ok(tool);
      await tool.execute({ candidateId: "first" }, input.actor);
      return { text: "", messages: [] };
    },
  };
  try {
    await select(store, engine);
    assert.equal(crash.exercised(), true);
    assert.equal(rawChoice(store, "choice-event", "owner", "task")?.state, "accepted");
    const otherTask = await select(store, engine, { taskId: "other-task" });
    assert.equal(otherTask.status, "success");
    assert.equal(calls, 2, "a different task scope makes its own model decision");
    const otherEvent = await select(store, engine, { eventId: "other-event" });
    assert.equal(otherEvent.status, "success");
    assert.equal(
      rawChoice(store, "other-event", "owner", "task")?.state,
      "accepted",
      "a different event scope records its own acceptance",
    );
    assert.equal(calls, 3, "a different event scope makes its own model decision");
    // A foreign owner cannot reuse this task's durable Leader session at all:
    // it is refused before inference, which is even stronger than a cache miss.
    const otherOwner = await select(store, engine, { ownerId: "other-owner" });
    assert.notEqual(otherOwner.status, "success");
    assert.equal(calls, 3, "a foreign owner never reaches the model");
  } finally {
    store.close();
  }
});
