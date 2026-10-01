import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { nativeSendOperationId, reconcileLeaderReceipts } from "../../src/app/leader-receipts.js";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import type { ActorContext, Participant, Task } from "../../src/core/types.js";
import { runLeaderScheduling } from "../../src/orchestration/leader-policy.js";
import { leaderSessionId } from "../../src/orchestration/leader-session-types.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import type { ConversationEngine, EngineInput, EngineResult } from "../../src/runtime/types.js";
import { actor as baseActor, discussion, setup } from "../tasks/helpers.js";
import {
  EVENT as HELPER_EVENT,
  REVISION as HELPER_REVISION,
  nativeRow,
  seedDispatch,
  seedOperation,
  seedSession,
} from "./leader-receipts-helpers.js";

/**
 * End-to-end proof against the real writers. The Leader authoring path runs for
 * real: `runLeaderScheduling` builds its own tool surface from the durability
 * state, the model calls the real action tool, `commitAction` + `persistAction`
 * write the durable selection, and the real Leader session/task records are the
 * ones the proof then reads. The scripted engine is a transport double only.
 */

// The helper writers and these fixtures must share one event/revision identity, so
// the native operation id derived from the actor's messageId matches the receipt.
const EVENT = HELPER_EVENT;
const REVISION = HELPER_REVISION;

function engineFor(candidateId: string, reason: string, extra: Record<string, unknown> = {}) {
  const calls: EngineInput[] = [];
  const engine: ConversationEngine = {
    contextTokens: 100_000,
    async summarize() {
      return "";
    },
    async run(input: EngineInput): Promise<EngineResult> {
      calls.push(input);
      const tools = input.tools.filter((tool) => tool.readOnly === false);
      const dispatch =
        tools.find((tool) => tool.name === "workflow_dispatch") ??
        tools.find((tool) => tool.name !== "workflow_status");
      assert.ok(dispatch, `no action tool: ${input.tools.map((tool) => tool.name).join(",")}`);
      const candidate = (
        dispatch.parameters as { properties?: { candidateId?: { enum?: string[] } } }
      ).properties?.candidateId?.enum;
      assert.ok(
        !candidate || candidate.includes(candidateId),
        `tool ${dispatch.name} does not offer ${candidateId}: ${JSON.stringify(candidate)}`,
      );
      await dispatch.execute({ candidateId, reason, ...extra }, input.actor);
      return { text: "已提交调度动作。", messages: [] };
    },
  };
  return { engine, calls };
}

async function fixture(kind: "discussion" | "development" = "discussion") {
  const h = setup();
  h.config.ai.enabled = true;
  const task = await h.service.create(baseActor, {
    ...discussion,
    ...(kind === "development" ? { kind: "development" as const } : {}),
    orchestration: { mode: "workflow" },
  });
  const state = workflowState(h.store, task, REVISION);
  return { ...h, task, state, actor: baseActor };
}

/** One Leader activation through the real authoring path. */
async function authorAction(input: {
  h: Awaited<ReturnType<typeof fixture>>;
  candidateId: string;
  reason: string;
  extra?: Record<string, unknown>;
  eventId?: string;
  revision?: string;
  participants?: Participant[];
  candidates?: Parameters<typeof runLeaderScheduling>[0]["candidates"];
}): Promise<{ eventId: string; event: OrchestrationEvent }> {
  const eventId = input.eventId ?? EVENT;
  const revision = input.revision ?? REVISION;
  const participants =
    input.participants ?? input.h.service.records.participants(input.h.task as Task);
  const candidates =
    input.candidates ??
    ([
      {
        id: input.candidateId,
        kind: input.candidateId.startsWith("rework:")
          ? ("rework" as const)
          : input.candidateId.startsWith("dispatch:")
            ? ("dispatch" as const)
            : ("verify" as const),
        description: "真实候选",
      },
    ] as never);
  const { engine } = engineFor(input.candidateId, input.reason, input.extra ?? {});
  const save = (event: OrchestrationEvent) => {
    input.h.store.set("task_orchestration_events", event.id, event);
  };
  const event: OrchestrationEvent = input.h.store.get<OrchestrationEvent>(
    "task_orchestration_events",
    eventId,
  ) ?? {
    id: eventId,
    taskId: input.h.task.id,
    trigger: "ready",
    outputIds: [],
    userRevision: revision,
    state: "processing",
    attempts: 1,
    dispatches: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  save(event);
  const outcome = await runLeaderScheduling(
    {
      store: input.h.store,
      engine,
      actor: {
        source: "system",
        ownerId: input.h.task.ownerId,
        chatId: input.h.task.entryChatId,
        sessionId: `orchestration:${input.h.task.id}`,
        taskId: input.h.task.id,
        messageId: eventId,
      },
      task: input.h.task,
      state: input.h.state,
      eventId,
      revision,
      planVersion: input.h.state.plan.version,
      templateVersion: input.h.state.plan.templateVersion,
      artifactRevision: "artifact-real",
      candidates,
      participants,
      commands: [],
      reportMissing: [],
      userMessages: [input.h.task.requirements],
      currentRevision: () => revision,
      persistAction: (action, candidate) => {
        event.workflow = {
          candidate: { ...candidate, description: action.reason || candidate.description },
          planVersion: input.h.state.plan.version,
          artifactRevision: "artifact-real",
        };
        event.decision = {
          action:
            candidate.kind === "deliver"
              ? "deliver"
              : candidate.kind === "user"
                ? "wait"
                : "continue",
          reason: candidate.kind === "user" ? candidate.description : action.reason,
          candidateId: candidate.id,
          source: "leader",
        };
        save(event);
      },
    },
    eventId,
  );
  assert.ok(!("deferred" in outcome) || !outcome.deferred, "the real Leader must commit");
  const stored = input.h.store.get<OrchestrationEvent>("task_orchestration_events", eventId);
  assert.ok(stored, "the real writer must persist the event");
  return { eventId, event: stored };
}

/**
 * The receipt the Leader runtime would have left pending: the real invocation
 * identity (`operationIdForCall`) with the normalized args the tool recorded.
 */
function pendingReceipt(input: {
  taskId: string;
  eventId: string;
  revision: string;
  tool: string;
  args: Record<string, unknown>;
}) {
  const sessionId = leaderSessionId(input.taskId);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.args))
    if (value !== undefined) clean[key] = value;
  const id = `leaderop_${input.tool}`;
  return {
    version: 1,
    id,
    taskId: input.taskId,
    sessionId,
    ownerId: "",
    tool: input.tool,
    readOnly: false,
    args: JSON.stringify(clean),
    argsCanonical: JSON.stringify(clean, Object.keys(clean).sort()),
    eventId: input.eventId,
    revision: input.revision,
    activationId: "la_real",
    state: "pending" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("the real Leader commit path produces a receipt the proof can close", async () => {
  const h = await fixture("development");
  try {
    const candidateId = `dispatch:${h.state.plan.nodes[0]?.id}:p1`;
    const { eventId } = await authorAction({
      h,
      candidateId,
      reason: "节点已就绪，安排实现。",
      extra: { instruction: "请实现并给出证据。" },
      candidates: [
        {
          id: candidateId,
          kind: "dispatch",
          description: "真实候选",
          assignments: [
            { nodeId: h.state.plan.nodes[0]?.id as string, participantId: `${h.task.id}:p1` },
          ],
        },
      ] as never,
    });
    // The real durable records exist and name the real identities.
    const session = h.store.get<{ ownerId?: string }>(
      "leader_sessions",
      leaderSessionId(h.task.id),
    );
    assert.equal(session?.ownerId, h.task.ownerId);
    assert.equal(h.store.get<{ ownerId?: string }>("tasks", h.task.id)?.ownerId, h.task.ownerId);
    const operation = pendingReceipt({
      taskId: h.task.id,
      eventId,
      revision: REVISION,
      tool: "workflow_dispatch",
      args: {
        candidateId,
        reason: "节点已就绪，安排实现。",
        instruction: "请实现并给出证据。",
      },
    });
    // The receipt belongs to the real session identity the runtime recorded.
    operation.ownerId = session?.ownerId as string;
    h.store.set("leader_operations", operation.id, operation);
    const report = reconcileLeaderReceipts(h.store, h.task.id);
    assert.deepEqual(
      report.resolved.map((entry) => [entry.operationId, entry.resolution]),
      [[operation.id, "treat_done"]],
      JSON.stringify(report.blocked),
    );
    const closed = h.store.get<{ state: string; result: Record<string, unknown> }>(
      "leader_operations",
      operation.id,
    );
    assert.equal(closed?.state, "complete");
    assert.equal(closed?.result.selected, true);
    assert.equal(closed?.result.dispatched, "unknown");
    assert.equal(closed?.result.businessCompletion, "unknown");
    // The real selection record and event are unchanged by the proof.
    const record = h.store.get<Record<string, unknown>>(
      "workflow_leader_actions",
      `wla_${(await import("../../src/core/ids.js")).stableId(eventId, REVISION)}`,
    );
    assert.equal(record?.state, "committed");
    assert.deepEqual(
      (record?.request as Record<string, unknown>).instruction,
      "请实现并给出证据。",
    );
  } finally {
    h.close();
  }
});

test("a receipt whose owner does not match the real Leader session stays blocked", async () => {
  const h = await fixture("development");
  try {
    const candidateId = `dispatch:${h.state.plan.nodes[0]?.id}:p1`;
    const { eventId } = await authorAction({
      h,
      candidateId,
      reason: "节点已就绪。",
      candidates: [
        {
          id: candidateId,
          kind: "dispatch",
          description: "真实候选",
        },
      ] as never,
    });
    const operation = pendingReceipt({
      taskId: h.task.id,
      eventId,
      revision: REVISION,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪。" },
    });
    // Empty and foreign owners are the two fail-open shapes the fix closes.
    for (const ownerId of ["", "someone-else"]) {
      h.store.set("leader_operations", operation.id, { ...operation, ownerId });
      const report = reconcileLeaderReceipts(h.store, h.task.id);
      assert.equal(report.changed, false, ownerId);
      assert.deepEqual(
        report.blocked.map((entry) => entry.operationId),
        [operation.id],
        ownerId,
      );
      assert.equal(
        h.store.get<{ state: string }>("leader_operations", operation.id)?.state,
        "pending",
        ownerId,
      );
    }
    // The real owner resolves it.
    const session = h.store.get<{ ownerId: string }>("leader_sessions", leaderSessionId(h.task.id));
    h.store.set("leader_operations", operation.id, {
      ...operation,
      ownerId: session?.ownerId as string,
    });
    assert.deepEqual(
      reconcileLeaderReceipts(h.store, h.task.id).resolved.map((entry) => entry.operationId),
      [operation.id],
    );
  } finally {
    h.close();
  }
});

test("a real reasoning rewrite of the reason no longer matches the committed selection", async () => {
  const h = await fixture("development");
  try {
    const candidateId = `dispatch:${h.state.plan.nodes[0]?.id}:p1`;
    const { eventId } = await authorAction({
      h,
      candidateId,
      reason: "  节点已就绪，安排实现。  ",
      candidates: [{ id: candidateId, kind: "dispatch", description: "真实候选" }] as never,
    });
    const session = h.store.get<{ ownerId: string }>("leader_sessions", leaderSessionId(h.task.id));
    const trimmed = pendingReceipt({
      taskId: h.task.id,
      eventId,
      revision: REVISION,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪，安排实现。" },
    });
    trimmed.ownerId = session?.ownerId as string;
    // The record holds the trimmed reason the real commit persisted.
    const record = h.store.get<{ request: { reason: string } }>(
      "workflow_leader_actions",
      `wla_${(await import("../../src/core/ids.js")).stableId(eventId, REVISION)}`,
    );
    assert.equal(record?.request.reason, "节点已就绪，安排实现。");
    // The receipt carrying the padded original is the same invocation.
    const padded = { ...trimmed, id: "leaderop_padded" };
    h.store.set("leader_operations", padded.id, {
      ...padded,
      args: JSON.stringify({
        candidateId,
        reason: "  节点已就绪，安排实现。  ",
      }),
    });
    const rewritten = { ...trimmed, id: "leaderop_rewritten" };
    h.store.set("leader_operations", rewritten.id, {
      ...rewritten,
      args: JSON.stringify({ candidateId, reason: "另一段理由。" }),
    });
    const report = reconcileLeaderReceipts(h.store, h.task.id);
    assert.deepEqual(
      report.resolved.map((entry) => entry.operationId),
      [padded.id],
    );
    assert.deepEqual(
      report.blocked.map((entry) => entry.operationId),
      [rewritten.id],
    );
  } finally {
    h.close();
  }
});

test("the real wait action persists the candidate description and its receipt resolves", async () => {
  const h = await fixture();
  try {
    const candidateId = "user:blocked";
    const { eventId } = await authorAction({
      h,
      candidateId,
      reason: "模型写的理由不会成为事件原因。",
      candidates: [
        {
          id: candidateId,
          kind: "user",
          description: "只有确需用户决定、权限或必需信息时等待用户。",
        },
      ] as never,
    });
    const session = h.store.get<{ ownerId: string }>("leader_sessions", leaderSessionId(h.task.id));
    const operation = pendingReceipt({
      taskId: h.task.id,
      eventId,
      revision: REVISION,
      tool: "workflow_wait",
      args: { reason: "模型写的理由不会成为事件原因。" },
    });
    operation.ownerId = session?.ownerId as string;
    h.store.set("leader_operations", operation.id, operation);
    const report = reconcileLeaderReceipts(h.store, h.task.id);
    assert.deepEqual(
      report.resolved.map((entry) => entry.resolution),
      ["treat_done"],
    );
    // The decision itself proves only that it was recorded.
    const stored = h.store.get<{ decision: { action: string; reason: string } }>(
      "task_orchestration_events",
      eventId,
    );
    assert.equal(stored?.decision.action, "wait");
    assert.equal(stored?.decision.reason, "只有确需用户决定、权限或必需信息时等待用户。");
  } finally {
    h.close();
  }
});

test("a real committed action survives a real cold reopen and still resolves", async () => {
  const h = await fixture("development");
  // This test closes the database itself, so it cleans its directory directly.
  try {
    const candidateId = `dispatch:${h.state.plan.nodes[0]?.id}:p1`;
    const { eventId } = await authorAction({
      h,
      candidateId,
      reason: "节点已就绪。",
      candidates: [{ id: candidateId, kind: "dispatch", description: "真实候选" }] as never,
    });
    const session = h.store.get<{ ownerId: string }>("leader_sessions", leaderSessionId(h.task.id));
    const operation = pendingReceipt({
      taskId: h.task.id,
      eventId,
      revision: REVISION,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪。" },
    });
    operation.ownerId = session?.ownerId as string;
    h.store.set("leader_operations", operation.id, operation);
    // Cold reopen on the same durable file: nothing is kept in memory.
    const path = h.store.path;
    h.store.close();
    const { Store } = await import("../../src/storage/store.js");
    const reopened = new Store(path);
    try {
      const report = reconcileLeaderReceipts(reopened, h.task.id);
      assert.deepEqual(
        report.resolved.map((entry) => entry.operationId),
        [operation.id],
      );
      assert.equal(
        reopened.get<{ state: string }>("leader_operations", operation.id)?.state,
        "complete",
      );
      assert.equal(
        reopened.get<{ decision?: { source?: string } }>("task_orchestration_events", eventId)
          ?.decision?.source,
        "leader",
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(h.directory, { recursive: true, force: true });
  }
});

test("a real Leader action for a different event never closes this event's receipt", async () => {
  const h = await fixture("development");
  try {
    const candidateId = `dispatch:${h.state.plan.nodes[0]?.id}:p1`;
    const first = await authorAction({
      h,
      candidateId,
      reason: "第一个事件。",
      eventId: "orchestrate:event-1",
      candidates: [{ id: candidateId, kind: "dispatch", description: "真实候选" }] as never,
    });
    const second = await authorAction({
      h,
      candidateId,
      reason: "第二个事件。",
      eventId: "orchestrate:event-2",
      candidates: [{ id: candidateId, kind: "dispatch", description: "真实候选" }] as never,
    });
    assert.notEqual(first.eventId, second.eventId);
    const session = h.store.get<{ ownerId: string }>("leader_sessions", leaderSessionId(h.task.id));
    const operation = pendingReceipt({
      taskId: h.task.id,
      eventId: second.eventId,
      revision: REVISION,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "第一个事件。" },
    });
    operation.ownerId = session?.ownerId as string;
    h.store.set("leader_operations", operation.id, operation);
    // The reason belongs to the first event: the second event's record differs.
    assert.equal(reconcileLeaderReceipts(h.store, h.task.id).changed, false);
    h.store.set("leader_operations", operation.id, {
      ...operation,
      args: JSON.stringify({ candidateId, reason: "第二个事件。" }),
    });
    assert.deepEqual(
      reconcileLeaderReceipts(h.store, h.task.id).resolved.map((entry) => entry.operationId),
      [operation.id],
    );
  } finally {
    h.close();
  }
});

test("the real Leader session record is the only one that authorizes its own receipts", async () => {
  const h = await fixture("development");
  try {
    const candidateId = `dispatch:${h.state.plan.nodes[0]?.id}:p1`;
    const { eventId } = await authorAction({
      h,
      candidateId,
      reason: "节点已就绪。",
      candidates: [{ id: candidateId, kind: "dispatch", description: "真实候选" }] as never,
    });
    const session = h.store.get<Record<string, unknown>>(
      "leader_sessions",
      leaderSessionId(h.task.id),
    );
    assert.ok(session);
    const operation = pendingReceipt({
      taskId: h.task.id,
      eventId,
      revision: REVISION,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪。" },
    });
    operation.ownerId = session.ownerId as string;
    h.store.set("leader_operations", operation.id, operation);
    // Corrupt only the stored session: the same receipt must stop resolving.
    h.store.set("leader_sessions", leaderSessionId(h.task.id), { ...session, ownerId: "" });
    const blocked = reconcileLeaderReceipts(h.store, h.task.id);
    assert.equal(blocked.changed, false);
    assert.match(blocked.blocked[0]?.reason ?? "", /会话身份不成立/);
    h.store.set("leader_sessions", leaderSessionId(h.task.id), { ...session, taskId: "other" });
    assert.equal(reconcileLeaderReceipts(h.store, h.task.id).changed, false);
    h.store.delete("leader_sessions", leaderSessionId(h.task.id));
    assert.equal(reconcileLeaderReceipts(h.store, h.task.id).changed, false);
    assert.equal(
      h.store.get<{ state: string }>("leader_operations", operation.id)?.state,
      "pending",
    );
    // The real record restores the proof.
    h.store.set("leader_sessions", leaderSessionId(h.task.id), session);
    assert.deepEqual(
      reconcileLeaderReceipts(h.store, h.task.id).resolved.map((entry) => entry.operationId),
      [operation.id],
    );
  } finally {
    h.close();
  }
});

test("a real state where the task owner changed no longer authorizes the old receipts", async () => {
  const h = await fixture("development");
  try {
    const candidateId = `dispatch:${h.state.plan.nodes[0]?.id}:p1`;
    const { eventId } = await authorAction({
      h,
      candidateId,
      reason: "节点已就绪。",
      candidates: [{ id: candidateId, kind: "dispatch", description: "真实候选" }] as never,
    });
    const session = h.store.get<{ ownerId: string }>("leader_sessions", leaderSessionId(h.task.id));
    const operation = pendingReceipt({
      taskId: h.task.id,
      eventId,
      revision: REVISION,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪。" },
    });
    operation.ownerId = session?.ownerId as string;
    h.store.set("leader_operations", operation.id, operation);
    const task = h.store.get<Task>("tasks", h.task.id);
    assert.ok(task);
    h.store.set("tasks", h.task.id, { ...task, ownerId: "another-owner" });
    assert.equal(reconcileLeaderReceipts(h.store, h.task.id).changed, false);
    h.store.set("tasks", h.task.id, { ...task, ownerId: "" });
    assert.equal(reconcileLeaderReceipts(h.store, h.task.id).changed, false);
    h.store.set("tasks", h.task.id, task);
    assert.deepEqual(
      reconcileLeaderReceipts(h.store, h.task.id).resolved.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.equal(
      h.store.get<OrchestrationEvent>("task_orchestration_events", eventId)?.workflow?.candidate.id,
      candidateId,
    );
    assert.equal(h.store.get<WorkflowState>(WORKFLOWS, h.task.id)?.taskId, h.task.id);
  } finally {
    h.close();
  }
});

test("the session identity the real runtime creates is the one receipts are judged against", async () => {
  const h = await fixture("development");
  try {
    const { sessionActor } = await import("../../src/orchestration/leader-session-writes.js");
    // No Leader session exists until a real activation creates one.
    assert.equal(h.store.get("leader_sessions", leaderSessionId(h.task.id)), undefined);
    const { leaderRuntime } = await import("../../src/orchestration/leader-session.js");
    const actor: ActorContext = baseActor;
    await leaderRuntime(h.store).runTaskLeader({
      store: h.store,
      engine: {
        contextTokens: 50_000,
        async summarize() {
          return "";
        },
        async run(): Promise<EngineResult> {
          return { text: "已核对。", messages: [] };
        },
      },
      actor: {
        source: "system",
        ownerId: h.task.ownerId,
        chatId: h.task.entryChatId,
        sessionId: `orchestration:${h.task.id}`,
        taskId: h.task.id,
        messageId: EVENT,
      },
      eventId: EVENT,
      revision: REVISION,
      systemPrompt: "s",
      prompt: "p",
      tools: [],
    });
    const session = h.store.get<{ id: string; taskId: string; ownerId: string }>(
      "leader_sessions",
      leaderSessionId(h.task.id),
    );
    assert.ok(session, "a real activation must create the durable session");
    const derived = sessionActor(session, EVENT);
    assert.equal(derived.taskId, h.task.id);
    assert.equal(derived.sessionId, leaderSessionId(h.task.id));
    assert.equal(derived.ownerId, h.task.ownerId);
    // That exact created identity is what closes a real receipt.
    const candidateId = `dispatch:${h.state.plan.nodes[0]?.id}:p1`;
    const { eventId } = await authorAction({
      h,
      candidateId,
      reason: "节点已就绪。",
      eventId: "orchestrate:event-after-session",
      candidates: [{ id: candidateId, kind: "dispatch", description: "真实候选" }] as never,
    });
    const operation = pendingReceipt({
      taskId: h.task.id,
      eventId,
      revision: REVISION,
      tool: "workflow_dispatch",
      args: { candidateId, reason: "节点已就绪。" },
    });
    operation.ownerId = derived.ownerId;
    operation.sessionId = derived.sessionId;
    h.store.set("leader_operations", operation.id, operation);
    assert.deepEqual(
      reconcileLeaderReceipts(h.store, h.task.id).resolved.map((entry) => entry.operationId),
      [operation.id],
    );
    assert.ok(actor);
  } finally {
    h.close();
  }
});

test("every real prompt version reconciles a first-turn send through the real TaskService", async () => {
  // The real send path writes the prepared body; the Leader receipt must prove it
  // for v1, v2 (its footer follows the token) and v3 (blank-line separators).
  // One task per store keeps the chat binding unambiguous.
  for (const promptVersion of [undefined, 2, 3] as const) {
    const h = setup();
    try {
      h.config.ai.enabled = true;
      const created = await h.service.create(baseActor, {
        ...discussion,
        orchestration: { mode: "workflow" },
        createGroup: false,
      });
      created.promptVersion = promptVersion;
      created.orchestration = { mode: "model" };
      h.service.records.save(created);
      await h.service.reconcile(created.id);
      const task = h.service.records.get(baseActor, created.id);
      const participant = h.service.records.participants(task)[0];
      assert.ok(participant);
      const text = "请核对原有要求并报告现有证据。";
      seedSession(h.store, task.id, task.ownerId);
      const nativeId = nativeSendOperationId(task.id, EVENT, participant.id, text);
      seedDispatch(h.store, task.id, nativeId, participant.id);
      await h.service.send(
        {
          ...baseActor,
          source: "system",
          chatId: task.chatId ?? task.entryChatId,
          sessionId: `orchestration:${task.id}`,
          taskId: task.id,
          messageId: EVENT,
        },
        task.id,
        participant.id,
        text,
      );
      const operation = seedOperation(h.store, {
        taskId: task.id,
        tool: "participant_send",
        args: { taskId: task.id, participantId: participant.id, text },
        state: "pending",
        eventId: EVENT,
        revision: REVISION,
      });
      const report = reconcileLeaderReceipts(h.store, task.id);
      assert.deepEqual(
        report.resolved.map((entry) => entry.operationId),
        [operation.id],
        `prompt v${promptVersion ?? 1}: ${JSON.stringify(report.blocked)}`,
      );
      assert.equal(
        h.store.get<{ state?: string }>("leader_operations", operation.id)?.state,
        "complete",
      );
      // Reconciliation never repeats the native input.
      assert.equal(nativeRow(h.store, nativeId).state, "done");
    } finally {
      h.close();
    }
  }
});
