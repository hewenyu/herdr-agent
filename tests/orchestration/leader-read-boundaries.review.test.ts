import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/types.js";
import {
  createLeaderTemplateChoice,
  createPlanningLeaderBridge,
  createPlanningReadTools,
} from "../../src/orchestration/leader-planning.js";
import { runLeaderScheduling } from "../../src/orchestration/leader-policy.js";
import {
  createLeaderReadTools,
  type LeaderToolContext,
} from "../../src/orchestration/leader-tools.js";
import { planWorkflow } from "../../src/orchestration/planner.js";
import { workflowState } from "../../src/orchestration/state.js";
import type { ConversationEngine } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

function fixture(requirements = "Inspect this task only") {
  const store = new Store(":memory:");
  const task: Task = {
    id: "task",
    ownerId: "owner",
    sessionId: "outer",
    entryChatId: "chat",
    kind: "discussion",
    title: "Task",
    requirements,
    directories: [],
    directoryMode: "shared",
    bypass: false,
    status: "running",
    participantIds: [],
    groupDeleted: false,
    keepGroup: false,
    createGroup: false,
    createRemoteTask: false,
    worktreeReady: true,
    discussion: { mode: "manual", rounds: 0, nextParticipant: 0, paused: false },
    result: "",
    closeRequested: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const state = workflowState(store, task, "revision");
  const actor = {
    ownerId: task.ownerId,
    taskId: task.id,
    sessionId: `task-leader:${task.id}`,
    chatId: "chat",
    messageId: "event",
  };
  const context: LeaderToolContext = {
    store,
    task,
    state,
    eventId: "event",
    userRevision: "revision",
    artifactRevision: "artifact",
    planVersion: 1,
    candidates: [],
    participants: [],
    commands: [],
    reportMissing: [],
    revision: () => "revision",
    assertCurrent: () => {},
    commit: async () => {},
  };
  const planning = createPlanningReadTools({
    store,
    task,
    state,
    userMessages: [],
    assertCurrent: () => {},
  });
  return { store, task, state, actor, context, planning };
}

test("a completed durable template choice survives recreating its in-memory callback", async () => {
  const h = fixture();
  let modelCalls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      modelCalls++;
      const tool = input.tools.find((entry) => entry.name === "orchestration_choice");
      assert.ok(tool);
      await tool.execute({ candidateId: "simple" }, input.actor);
      return { text: "", messages: [] };
    },
  };
  const select = () =>
    createLeaderTemplateChoice({
      store: h.store,
      engine,
      actor: h.actor,
      eventId: "choice-event",
      revision: "revision",
    })({
      candidates: [{ id: "simple", description: "Ordinary discussion" }],
      snapshot: { requirements: h.task.requirements },
      instructions: "Choose a legal mode",
      current: () => {},
    });
  try {
    assert.equal((await select()).candidateId, "simple");
    assert.equal(
      (await select()).candidateId,
      "simple",
      "a durable completed choice must not become empty after recovery",
    );
    assert.equal(modelCalls, 1, "recover the recorded choice rather than asking again");
  } finally {
    h.store.close();
  }
});

test("a completed Leader plan survives recreating the planner before runner handoff", async () => {
  const h = fixture();
  let modelCalls = 0;
  const engine: ConversationEngine = {
    contextTokens: 50000,
    summarize: async () => "",
    run: async (input) => {
      modelCalls++;
      const tool = input.tools.find((entry) => entry.name === "orchestration_plan");
      assert.ok(tool);
      await tool.execute(
        { template: "discussion", instructions: {}, deliveryRequirements: [] },
        input.actor,
      );
      return { text: "", messages: [] };
    },
  };
  const plan = () =>
    planWorkflow({
      task: h.task,
      state: h.state,
      engine,
      actor: h.actor,
      userMessages: [],
      simpleDiscussion: true,
      signal: new AbortController().signal,
      assertCurrent: () => {},
      leader: createPlanningLeaderBridge({
        store: h.store,
        engine,
        task: h.task,
        state: h.state,
        eventId: "plan-event",
        revision: "revision",
        userMessages: [],
        assertCurrent: () => {},
      }),
    });
  try {
    const first = await plan();
    assert.deepEqual(
      await plan(),
      first,
      "the validated plan must be recovered, not lost in a local selected variable",
    );
    assert.equal(modelCalls, 1);
  } finally {
    h.store.close();
  }
});

for (const [kind, prefix] of [
  ["long", "context ".repeat(4000)],
  ["escaped", "\u0000".repeat(2000)],
] as const)
  test(`model-fit ${kind} planning constraints are not refused at the inline prompt threshold`, async () => {
    const marker = "MANDATORY_CURRENT_REQUEST: never deploy or close without explicit acceptance";
    const h = fixture(prefix + marker);
    let modelCalls = 0;
    const engine: ConversationEngine = {
      contextTokens: 50000,
      summarize: async () => "",
      run: async (input) => {
        modelCalls++;
        const actualContext = JSON.stringify({ prompt: input.prompt, messages: input.messages });
        assert.ok(actualContext.includes(marker), "full mandatory payload must reach the engine");
        const tool = input.tools.find((entry) => entry.name === "orchestration_plan");
        assert.ok(tool);
        await tool.execute(
          { template: "discussion", instructions: {}, deliveryRequirements: [] },
          input.actor,
        );
        return { text: "", messages: input.messages };
      },
    };
    try {
      const plan = await planWorkflow({
        task: h.task,
        state: h.state,
        engine,
        actor: h.actor,
        userMessages: [],
        simpleDiscussion: true,
        signal: new AbortController().signal,
        assertCurrent: () => {},
        leader: createPlanningLeaderBridge({
          store: h.store,
          engine,
          task: h.task,
          state: h.state,
          eventId: `fit-${kind}`,
          revision: "revision",
          userMessages: [],
          assertCurrent: () => {},
        }),
      });
      assert.equal(
        modelCalls,
        1,
        "inline policy is not a refusal cap for model-fit mandatory data",
      );
      assert.equal(plan.goal, h.task.requirements);
    } finally {
      h.store.close();
    }
  });

test("planning read tools reject a known conversation ID belonging to another task", async () => {
  const h = fixture();
  try {
    h.store.set("workflow_conversation_evidence", "foreign-output", {
      text: "FOREIGN_SECRET",
      notes: "Other task's record",
      participantId: "foreign-agent",
      hash: "hash",
    });
    const tool = h.planning.find((entry) => entry.name === "planning_read");
    assert.ok(tool);
    await assert.rejects(
      Promise.resolve().then(() =>
        tool.execute({ kind: "conversation", id: "foreign-output" }, h.actor),
      ),
      (error: unknown) => error instanceof OperationError && error.outcome === "not_executed",
    );
  } finally {
    h.store.close();
  }
});

test("planning requirements pages count JSON escaping in their total byte budget", async () => {
  const h = fixture("\u0000".repeat(12000));
  try {
    const tool = h.planning.find((entry) => entry.name === "planning_read");
    assert.ok(tool);
    let text = "";
    let offset = 0;
    for (;;) {
      const value = (await tool.execute(
        { kind: "requirements", offset, limit: 4000 },
        h.actor,
      )) as { text: string; nextOffset?: number };
      assert.ok(
        Buffer.byteLength(JSON.stringify(value)) <= 16384,
        "the full quoted page must fit, not just raw characters",
      );
      text += value.text;
      if (value.nextOffset === undefined) break;
      assert.ok(value.nextOffset > offset);
      offset = value.nextOffset;
    }
    assert.ok(text.includes(h.task.requirements));
  } finally {
    h.store.close();
  }
});

test("planning pagination can reach mandatory text past 200000 characters", async () => {
  const marker = "MANDATORY: no deployment or closing without human acceptance";
  const h = fixture("x".repeat(205000) + marker);
  try {
    const tool = h.planning.find((entry) => entry.name === "planning_read");
    assert.ok(tool);
    const value = (await tool.execute(
      { kind: "requirements", offset: 205000, limit: 4000 },
      h.actor,
    )) as { text: string };
    assert.ok(value.text.includes(marker), "a scoped original must stay fully addressable");
  } finally {
    h.store.close();
  }
});

for (const source of ["task-goal-tail", "message-tail", "earlier-message"] as const)
  test(`Leader cannot commit a choice while ${source} mandatory constraints are silently absent`, async () => {
    const marker = "HARD_CONSTRAINT: do not deploy, widen directories, or close without acceptance";
    const long = "context ".repeat(1000) + marker;
    const h = fixture(source === "task-goal-tail" ? long : "Inspect the task only");
    const userMessages =
      source === "earlier-message"
        ? [marker, ...Array.from({ length: 12 }, (_, index) => `Additional requirement ${index}`)]
        : source === "message-tail"
          ? [long]
          : [];
    let missingAtCommit = false;
    let modelCalls = 0;
    const engine: ConversationEngine = {
      contextTokens: 50000,
      summarize: async () => "",
      run: async (input) => {
        modelCalls++;
        const request = JSON.stringify({
          prompt: input.prompt,
          messages: input.messages,
          systemPrompt: input.systemPrompt,
        });
        const wait = input.tools.find((tool) => tool.name === "workflow_wait");
        assert.ok(wait, "fixture must use the actual, legal Leader action");
        // Do not page: incomplete mandatory input must gate this action, not trust
        // a warning in the prompt. A fully inline request can safely commit.
        await wait.execute({ reason: "Missing a necessary user decision" }, input.actor);
        missingAtCommit = !request.includes(marker);
        return { text: "", messages: [] };
      },
    };
    try {
      await runLeaderScheduling(
        {
          store: h.store,
          engine,
          actor: h.actor,
          task: h.task,
          state: h.state,
          eventId: "constraints-event",
          revision: "revision",
          planVersion: h.state.plan.version,
          templateVersion: 1,
          artifactRevision: "artifact",
          candidates: [{ id: "user:missing", kind: "user", description: "Need user evidence" }],
          participants: [],
          commands: [],
          reportMissing: [],
          userMessages,
          currentRevision: () => "revision",
          persistAction: () => {},
        },
        "constraints-review",
      );
    } catch (error) {
      assert.ok(error instanceof OperationError, "refusal must remain a typed operation failure");
      assert.match(error.code, /context_budget|constraints|requirements/);
      assert.equal(error.outcome, "not_executed");
    } finally {
      h.store.close();
    }
    assert.ok(modelCalls <= 1);
    assert.equal(
      missingAtCommit,
      false,
      "a warning or truncated prefix cannot replace constraints",
    );
  });

test("workflow board pages bound the complete JSON envelope, including escaping", async () => {
  const h = fixture();
  try {
    h.state.plan.goal = "\u0000".repeat(12000);
    const board = createLeaderReadTools(h.context).find((tool) => tool.name === "workflow_board");
    assert.ok(board);
    const value = await board.execute({ section: "plan", offset: 0, limit: 4000 }, h.actor);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 16384);
  } finally {
    h.store.close();
  }
});

for (const unfit of [false, true])
  test(`template-choice constraints are ${unfit ? "rejected before inference when unfit" : "complete when model-fit beyond the snapshot prefix"}`, async () => {
    const marker = "MANDATORY_TEMPLATE_TAIL_DO_NOT_START_IMPLEMENTATION";
    const h = fixture(`${"requirement ".repeat(unfit ? 18000 : 2000)}${marker}`);
    let calls = 0;
    let visible = false;
    const engine: ConversationEngine = {
      contextTokens: 50000,
      summarize: async () => "",
      run: async (input) => {
        calls++;
        visible = JSON.stringify({ prompt: input.prompt, messages: input.messages }).includes(
          marker,
        );
        const tool = input.tools.find((entry) => entry.name === "orchestration_choice");
        assert.ok(tool);
        await tool.execute({ candidateId: "simple" }, input.actor);
        return { text: "", messages: [] };
      },
    };
    try {
      const result = await createLeaderTemplateChoice({
        store: h.store,
        engine,
        actor: h.actor,
        eventId: "mandatory-choice",
        revision: "revision",
      })({
        candidates: [{ id: "simple", description: "Only discuss; do not implement" }],
        snapshot: { requirements: h.task.requirements },
        instructions: "Choose a legal mode without losing any mandatory constraints",
        current: () => {},
      });
      if (unfit) {
        assert.notEqual(result.status, "success", "a truncated prefix cannot authorize a choice");
        assert.equal(calls, 0, "an irreducible activation must fail before the model runs");
      } else {
        assert.equal(result.status, "success");
        assert.equal(calls, 1);
        assert.equal(visible, true, "the model must see the complete requirement tail");
      }
    } finally {
      h.store.close();
    }
  });

for (const scope of ["task", "owner"] as const)
  test(`durable template choices never cross the ${scope} boundary`, async () => {
    const h = fixture();
    let calls = 0;
    const engine: ConversationEngine = {
      contextTokens: 50000,
      summarize: async () => "",
      run: async (input) => {
        calls++;
        const tool = input.tools.find((entry) => entry.name === "orchestration_choice");
        assert.ok(tool);
        await tool.execute({ candidateId: calls === 1 ? "first" : "second" }, input.actor);
        return { text: "", messages: [] };
      },
    };
    const select = (actor = h.actor) =>
      createLeaderTemplateChoice({
        store: h.store,
        engine,
        actor,
        eventId: "same-event-key",
        revision: "same-revision",
      })({
        candidates: [
          { id: "first", description: "First legal option" },
          { id: "second", description: "Second legal option" },
        ],
        snapshot: { requirements: h.task.requirements },
        instructions: "Choose for this actor's task only",
        current: () => {},
      });
    try {
      assert.equal((await select()).candidateId, "first");
      const other = await select({
        ...h.actor,
        ...(scope === "task"
          ? { taskId: "other-task", sessionId: "task-leader:other-task" }
          : { ownerId: "other-owner" }),
      });
      if (scope === "task") {
        assert.equal(other.candidateId, "second", "another task must make its own decision");
        assert.equal(calls, 2);
      } else {
        assert.notEqual(other.status, "success", "foreign owners cannot reuse a cached choice");
        assert.equal(calls, 1, "the existing task Leader's owner boundary must reject first");
      }
      assert.equal((await select()).candidateId, "first", "the original task keeps its own choice");
      assert.equal(calls, scope === "task" ? 2 : 1, "completed choices never rerun the model");
    } finally {
      h.store.close();
    }
  });

test("a durable cached template choice still checks the current user revision", async () => {
  const h = fixture();
  let stale = false;
  let calls = 0;
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
      store: h.store,
      engine,
      actor: h.actor,
      eventId: "cached-choice-event",
      revision: "revision",
    })({
      candidates: [{ id: "simple", description: "Discuss only" }],
      snapshot: { requirements: h.task.requirements },
      instructions: "Choose a legal mode",
      current: () => {
        if (stale)
          throw new OperationError(
            "workflow_revision_changed",
            "The request was superseded",
            "not_executed",
          );
      },
    });
  try {
    assert.equal((await select()).candidateId, "simple");
    stale = true;
    await assert.rejects(select, { code: "workflow_revision_changed" });
    assert.equal(calls, 1);
  } finally {
    h.store.close();
  }
});
