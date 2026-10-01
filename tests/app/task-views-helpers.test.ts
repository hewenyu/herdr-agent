import assert from "node:assert/strict";
import test from "node:test";
import { boundConversation, modelBytes, truncateBytes } from "../../src/app/task-views.js";
import { applicationTools } from "../../src/app/tools.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { ActorContext, Task } from "../../src/core/types.js";
import { workflowState } from "../../src/orchestration/state.js";
import { setup } from "./helpers.js";

/** Materialize the same durable workflow state the scheduler uses. */
function materialize(h: ReturnType<typeof setup>, task: Task) {
  const orchestrator = (
    h.app as unknown as { taskOrchestrator: { revision(task: Task, workflow?: boolean): string } }
  ).taskOrchestrator;
  return workflowState(h.store, task, orchestrator.revision(task, false));
}

const actor: ActorContext = {
  ownerId: "owner",
  chatId: "entry",
  sessionId: "entry",
  messageId: "helper",
  source: "feishu",
  chatType: "private",
};

test("truncateBytes never splits a surrogate pair and always states the omission", () => {
  const emoji = "🙂".repeat(4_000);
  const bounded = truncateBytes(emoji, 1_000);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 1_000);
  assert.doesNotMatch(bounded, /[\uD800-\uDBFF]$/u, "no lone high surrogate may survive");
  assert.match(bounded, /字节预算/);
  assert.equal(truncateBytes("ok", 100), "ok", "values inside the budget stay intact");
});

test("a bound conversation keeps newest text, counts omissions and never lies about being whole", () => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    text: `第${index}轮：${"讨论内容".repeat(400)}`,
  }));
  const page = boundConversation(entries);
  assert.ok(modelBytes(page.entries) <= 4_096 + 1_024, `${modelBytes(page.entries)} bytes`);
  assert.ok(page.omittedEntries > 0, "a bounded page must report what it left out");
  assert.equal(page.truncated, true);
  assert.ok(
    page.entries.some((entry) => entry.truncated),
    "per-entry shortening must be visible",
  );
  const small = boundConversation([{ text: "短句" }]);
  assert.deepEqual(small, {
    entries: [{ text: "短句", truncated: false }],
    omittedEntries: 0,
    truncated: false,
  });
});

test("task_progress bounds a huge participant conversation and still reports delivery facts", async () => {
  const h = setup();
  try {
    const task = await h.app.tasks.create(actor, {
      kind: "discussion",
      title: "会话边界",
      requirements: "讨论并给出结论。",
      project: "project",
      participants: [{ kind: "codex" }],
      orchestration: { mode: "workflow" },
      createRemoteTask: false,
    });
    await h.app.tasks.reconcile(task.id);
    const current = h.app.tasks.get(actor, task.id);
    assert.ok(current.chatId);
    const bound: ActorContext = {
      ...actor,
      chatId: current.chatId,
      chatType: "group",
      taskId: current.id,
      messageId: "helper-group",
    };
    materialize(h, current);
    const participant = h.app.tasks.records.participants(current)[0];
    assert.ok(participant?.execution);
    h.app.tasks.records.saveParticipant({
      ...participant,
      initialSent: true,
      cursor: "scheduler",
      execution: { ...participant.execution, sessionId: "session" },
    });
    const live = { ...participant.execution, sessionId: "session" };
    h.herdr.agents.set(live.paneId, {
      ...live,
      sessionId: "session",
      status: "idle",
      stateSeq: "1",
      interactiveReady: true,
      launchPending: false,
    });
    (h.herdr as HerdrPort).conversation = async () => ({
      entries: Array.from({ length: 60 }, (_, index) => ({
        id: `entry-${index}`,
        role: "assistant" as const,
        text: `第${index}轮自述：${"很长的参与者说明".repeat(500)}`,
        final: false,
      })),
      truncated: true,
    });
    const tool = applicationTools(h.app, bound).find((entry) => entry.name === "task_progress");
    assert.ok(tool);
    const result = (await tool.execute({ taskId: current.id }, bound)) as {
      participants: Array<{
        id: string;
        initialSent: boolean;
        initialDelivery?: string;
        conversation?: Array<{ truncated: boolean }>;
        omittedEntries?: number;
        conversationTruncated?: boolean;
        readError?: string;
      }>;
      workflow?: { phase: string; counts: Record<string, number> };
    };
    assert.ok(modelBytes(result) <= 16_384, `task_progress returned ${modelBytes(result)} bytes`);
    const observed = result.participants.find((entry) => entry.id === participant.id);
    assert.ok(observed);
    assert.equal(observed.initialSent, true, "delivery facts survive projection");
    assert.equal(observed.readError, undefined);
    assert.ok(observed.conversation?.length, "recent conversation must still be readable");
    assert.ok((observed.omittedEntries ?? 0) > 0);
    assert.equal(observed.conversationTruncated, true);
    assert.ok(result.workflow?.phase);
    assert.equal(h.app.tasks.records.participants(current)[0]?.cursor, "scheduler");
  } finally {
    await h.close();
  }
});

test("task_detail pages and task_get summaries agree about the same durable record", async () => {
  const h = setup();
  try {
    const task = await h.app.tasks.create(actor, {
      kind: "discussion",
      title: "一致性",
      requirements: "讨论。",
      project: "project",
      participants: [{ kind: "codex" }],
      orchestration: { mode: "workflow" },
      createRemoteTask: false,
    });
    await h.app.tasks.reconcile(task.id);
    materialize(h, h.app.tasks.get(actor, task.id));
    const view = (await applicationTools(h.app, actor)
      .find((entry) => entry.name === "task_get")
      ?.execute({ taskId: task.id }, actor)) as { id: string; status: string };
    const page = await applicationTools(h.app, actor)
      .find((entry) => entry.name === "task_detail")
      ?.execute({ taskId: task.id, section: "status" }, actor);
    assert.equal(view.id, task.id);
    assert.equal((page as { taskId: string }).taskId, task.id);
    assert.equal((page as { totalEntries: number }).totalEntries, 1);
  } finally {
    await h.close();
  }
});
