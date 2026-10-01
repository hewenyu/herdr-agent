import assert from "node:assert/strict";
import test from "node:test";
import { createLeaderTemplateChoice } from "../../src/orchestration/leader-planning.js";
import {
  LEADER_INBOX,
  type LeaderInboxRecord,
} from "../../src/orchestration/leader-session-types.js";
import type { ConversationEngine } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

for (const failure of ["model-error", "cancelled"] as const) {
  test(`a choice staged before ${failure} is not accepted without a completed Leader inbox`, async () => {
    const store = new Store(":memory:");
    const controller = new AbortController();
    const actor = {
      ownerId: "owner",
      taskId: "task",
      sessionId: "task-leader:task",
      chatId: "chat",
      messageId: "event",
    };
    let calls = 0;
    const engine: ConversationEngine = {
      contextTokens: 50000,
      summarize: async () => "",
      run: async (input) => {
        calls++;
        if (calls === 1) {
          const tool = input.tools.find((entry) => entry.name === "orchestration_choice");
          assert.ok(tool);
          await tool.execute({ candidateId: "simple" }, input.actor);
          if (failure === "cancelled") controller.abort();
        }
        throw new Error("the model stopped before its Leader result could commit");
      },
    };
    const select = (signal?: AbortSignal) =>
      createLeaderTemplateChoice({
        store,
        engine,
        actor,
        eventId: "incomplete-choice",
        revision: "revision",
      })({
        candidates: [{ id: "simple", description: "Discuss only" }],
        snapshot: { requirements: "Only discuss; do not implement or deploy." },
        instructions: "Choose a legal planning mode",
        current: () => {},
        ...(signal ? { signal } : {}),
      });
    try {
      const initial = await select(controller.signal);
      assert.equal(initial.status, failure === "cancelled" ? "cancelled" : "error");
      const inbox = store.list<LeaderInboxRecord>(LEADER_INBOX);
      assert.equal(inbox.length, 1);
      assert.notEqual(inbox[0]?.state, "recorded", "the activation must not have completed");
      const recovered = await select();
      assert.notEqual(
        recovered.status,
        "success",
        "a staged choice is not a committed, replayable selection",
      );
    } finally {
      store.close();
    }
  });
}

test("a template choice survives a crash after the Leader inbox commits but before adapter handoff", async () => {
  const store = new Store(":memory:");
  const actor = {
    ownerId: "owner",
    taskId: "task",
    sessionId: "task-leader:task",
    chatId: "chat",
    messageId: "event",
  };
  let calls = 0;
  let crashAfterCommit = true;
  const transaction = store.transaction.bind(store);
  store.transaction = <T>(fn: () => T): T => {
    const value = transaction(fn);
    // Throw only AFTER the real SQLite transaction commits, not inside it:
    // rolling the inbox back would test an entirely different crash window.
    if (
      crashAfterCommit &&
      store.list<LeaderInboxRecord>(LEADER_INBOX).some((entry) => entry.state === "recorded")
    ) {
      crashAfterCommit = false;
      throw new Error("simulated process loss after completed Leader commit");
    }
    return value;
  };
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      calls++;
      const tool = input.tools.find((entry) => entry.name === "orchestration_choice");
      assert.ok(tool);
      await tool.execute({ candidateId: "simple" }, input.actor);
      return { text: "", messages: [] };
    },
  };
  const select = () =>
    createLeaderTemplateChoice({
      store,
      engine,
      actor,
      eventId: "choice-event",
      revision: "revision",
    })({
      candidates: [{ id: "simple", description: "Discuss only" }],
      snapshot: { requirements: "Only discuss; do not implement or deploy." },
      instructions: "Choose a legal planning mode",
      current: () => {},
    });
  try {
    await select();
    assert.equal(crashAfterCommit, false, "the post-commit crash window must be exercised");
    assert.equal(calls, 1);
    assert.equal(store.list<LeaderInboxRecord>(LEADER_INBOX)[0]?.state, "recorded");
    const recovered = await select();
    assert.equal(recovered.status, "success", "completed choice must survive the handoff gap");
    assert.equal(recovered.candidateId, "simple");
    assert.equal(calls, 1, "a completed Leader activation must not rerun its model");
  } finally {
    store.transaction = transaction;
    store.close();
  }
});
