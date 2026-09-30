import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext, ExecutionRef, Participant } from "../../src/core/types.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import type { TaskRestart } from "../../src/tasks/restart.js";
import { TaskService } from "../../src/tasks/service.js";
import { Engine, logger } from "../app/helpers.js";
import { actor, createPersistedTask, discussion, setup } from "./helpers.js";

async function fixture(mode: "model" | "workflow" = "model") {
  const h = setup();
  h.config.ai.enabled = true;
  const task = await createPersistedTask(h, actor, discussion, { orchestration: { mode } });
  task.promptVersion = 2;
  h.service.records.save(task);
  await h.service.reconcile(task.id);
  return { ...h, task, who: request(h) };
}

function request(h: ReturnType<typeof setup>, messageId = "restart"): ActorContext {
  const who: ActorContext = {
    ...actor,
    source: "feishu",
    chatType: "private",
    messageId,
  };
  h.store.set<InboxRecord>("inbox", `message:${messageId}`, {
    id: `message:${messageId}`,
    type: "message",
    actor: who,
    payload: {
      source: "feishu",
      chatType: "private",
      eventId: messageId,
      messageId,
      ownerId: "owner",
      chatId: "entry",
      text: "重新拉起两位参与者，核对现有文件后继续",
      mentionedBot: false,
    },
    lane: "owner",
    state: "done",
    sequence: 1,
    createdAt: new Date().toISOString(),
  });
  return who;
}

function nativeHistory(h: Awaited<ReturnType<typeof fixture>>) {
  const reads = new Map<string, number>();
  Object.assign(h.herdr, {
    conversation: async (ref: ExecutionRef) => {
      reads.set(ref.paneId, (reads.get(ref.paneId) ?? 0) + 1);
      if (!h.herdr.agents.has(ref.paneId))
        throw new OperationError("agent_not_found", "closed conversations are unavailable");
      return {
        entries: [
          {
            id: `native-${ref.paneId}`,
            role: "assistant" as const,
            text: `CAPTURED_BEFORE_CLOSE_${ref.paneId}`,
            final: true,
          },
        ],
        truncated: false,
      };
    },
  });
  return reads;
}

test("history survives a service stop after the first confirmed close before material is written", async () => {
  const h = await fixture();
  try {
    const reads = nativeHistory(h);
    const first = h.service.get(actor, h.task.id).participants[0];
    assert.ok(first?.execution);
    const close = h.herdr.close.bind(h.herdr);
    h.herdr.close = async (ref) => {
      const pending = h.store.list<TaskRestart>("task_restarts")[0];
      assert.equal(pending?.history?.[first.id]?.status, "captured");
      await close(ref);
      h.service.stop();
    };
    await assert.rejects(h.service.restartParticipants(h.who, h.task.id, h.task.participantIds), {
      code: "stopping",
    });
    const pending = h.store.list<TaskRestart>("task_restarts")[0];
    assert.ok(pending);
    assert.equal(h.herdr.closes, 1);
    await assert.rejects(readFile(pending.materialPath, "utf8"), { code: "ENOENT" });
    assert.match(pending.history?.[first.id]?.text ?? "", /CAPTURED_BEFORE_CLOSE/);
    h.herdr.close = close;
    const restored = new TaskService(h.options);
    const restart = await restored.restartParticipants(h.who, h.task.id, h.task.participantIds);
    const material = await readFile(restart.materialPath, "utf8");
    assert.ok(material.includes(`CAPTURED_BEFORE_CLOSE_${first.execution.paneId}`));
    assert.equal(reads.get(first.execution.paneId), 1, "closed history is never reread");
    assert.deepEqual([...reads.values()], [1, 1]);
    assert.equal(h.herdr.closes, 2);
    assert.equal(restart.state, "done");
  } finally {
    h.close();
  }
});

test("replacement commit failure retries preserve the same captured recovery material", async () => {
  const h = await fixture();
  try {
    const reads = nativeHistory(h);
    h.service.records.saveParticipant = () => {
      throw new Error("replacement commit failed");
    };
    await assert.rejects(
      h.service.restartParticipants(h.who, h.task.id, h.task.participantIds),
      /replacement commit failed/,
    );
    const pending = h.store.list<TaskRestart>("task_restarts")[0];
    assert.ok(pending);
    const captured = await readFile(pending.materialPath, "utf8");
    assert.equal(Object.keys(pending.history ?? {}).length, 2);
    assert.equal((captured.match(/CAPTURED_BEFORE_CLOSE/g) ?? []).length, 2);
    h.service.stop();
    const restored = new TaskService(h.options);
    const restart = await restored.restartParticipants(h.who, h.task.id, h.task.participantIds);
    assert.equal(await readFile(restart.materialPath, "utf8"), captured);
    assert.deepEqual(restart.history, pending.history);
    assert.deepEqual([...reads.values()], [1, 1]);
    assert.equal(h.herdr.closes, 2);
    assert.equal(restart.state, "done");
  } finally {
    h.close();
  }
});

test("failed history capture is checkpointed before close and retained on retry", async () => {
  const h = await fixture();
  try {
    let reads = 0;
    Object.assign(h.herdr, {
      conversation: async () => {
        reads++;
        throw new OperationError("history_unavailable", "conversation read failed");
      },
    });
    h.herdr.closeError = new OperationError("server_unavailable", "temporarily unavailable");
    await assert.rejects(h.service.restartParticipants(h.who, h.task.id, h.task.participantIds), {
      code: "server_unavailable",
    });
    const pending = h.store.list<TaskRestart>("task_restarts")[0];
    const first = h.task.participantIds[0];
    assert.ok(pending && first);
    const checkpoint = pending.history?.[first];
    assert.equal(checkpoint?.status, "failed");
    assert.match(checkpoint?.text ?? "", /历史读取未完成：history_unavailable/);
    h.herdr.closeError = undefined;
    const restart = await h.service.restartParticipants(h.who, h.task.id, h.task.participantIds);
    assert.deepEqual(restart.history?.[first], checkpoint);
    assert.equal(reads, 2, "each participant is captured only once, including failed reads");
    assert.match(
      await readFile(restart.materialPath, "utf8"),
      /历史读取未完成：history_unavailable/,
    );
  } finally {
    h.close();
  }
});

test("retired unknown inputs allow ordinary retry while active unknown operations still block it", async () => {
  const h = await fixture();
  try {
    h.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    await assert.rejects(
      h.service.send(actor, h.task.id, h.task.participantIds[0], "unknown input"),
    );
    const restart = await h.service.restartParticipants(h.who, h.task.id, h.task.participantIds);
    const oldId = restart.operationIds[0];
    assert.ok(oldId);
    const retired = h.store.get<OperationReceipt>("operations", oldId);
    await h.service.action({ ...actor, messageId: "retry-after-restart" }, h.task.id, "retry");
    assert.deepEqual(h.store.get("operations", oldId), retired);
    h.store.set("operations", `${h.task.id}:unrelated-unknown`, {
      id: `${h.task.id}:unrelated-unknown`,
      fingerprint: "unknown",
      state: "uncertain",
      updatedAt: new Date().toISOString(),
    });
    await assert.rejects(
      h.service.action({ ...actor, messageId: "retry-active-unknown" }, h.task.id, "retry"),
      { code: "operation_uncertain" },
    );
    assert.deepEqual(h.store.get("operations", oldId), retired);
  } finally {
    h.close();
  }
});

test("confirmed group deletion clears its stale error despite retired unknown input audit", async () => {
  const h = await fixture();
  try {
    h.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    await assert.rejects(
      h.service.send(actor, h.task.id, h.task.participantIds[0], "unknown input"),
    );
    const restart = await h.service.restartParticipants(h.who, h.task.id, h.task.participantIds);
    h.herdr.delivery = { status: "delivered", acked: true, verified: true, attempts: 1 };
    await h.service.reconcile(h.task.id);
    let dissolved = false;
    Object.assign(h.platform, { getGroupStatus: async () => (dissolved ? "dissolved" : "normal") });
    h.platform.deleteGroup = async () => {
      h.platform.deletions++;
      dissolved = true;
      throw new OperationError("lost_delete_ack", "删除成功但回执丢失", "unknown");
    };
    await h.service.action({ ...actor, messageId: "destroy-after-restart" }, h.task.id, "destroy");
    await h.service.reconcile(h.task.id);
    assert.equal(h.service.get(actor, h.task.id).error, "删除成功但回执丢失");
    const deletionId = `${h.task.id}:delete-group`;
    const original = h.store.get<OperationReceipt>("operations", deletionId);
    assert.equal(original?.state, "uncertain");
    await h.service.reconcile(h.task.id);
    const recovered = h.store.get<OperationReceipt>("operations", deletionId);
    assert.ok(original && recovered);
    assert.equal(recovered.state, original.state);
    assert.deepEqual(recovered.error, original.error);
    assert.equal(recovered.updatedAt, original.updatedAt);
    assert.equal(recovered.resolution?.choice, "treat_done");
    assert.equal(recovered.resolution?.decidedBy, "evidence");
    assert.equal((recovered.resolution?.result as { status?: string })?.status, "dissolved");
    const task = h.service.get(actor, h.task.id);
    assert.equal(task.status, "destroyed");
    assert.equal(task.error, undefined);
    assert.equal(h.platform.deletions, 1);
    assert.equal(h.herdr.closes, 4);
    assert.equal(
      h.store.get<OperationReceipt>("operations", restart.operationIds[0] ?? "")?.state,
      "uncertain",
    );
  } finally {
    h.close();
  }
});

for (const mode of ["model", "workflow"] as const)
  test(`${mode} replacement startup mounts the recovery material directory`, async () => {
    const h = await fixture(mode);
    try {
      const restart = await h.service.restartParticipants(h.who, h.task.id, h.task.participantIds);
      const starts: string[][] = [];
      const start = h.herdr.startAgent.bind(h.herdr);
      h.herdr.startAgent = async (pane, kind, name, options) => {
        starts.push([...options.directories]);
        return start(pane, kind, name, options);
      };
      await h.service.reconcile(h.task.id);
      assert.equal(starts.length, 2);
      const task = h.service.get(actor, h.task.id);
      if (mode === "model") assert.equal(task.boardDirectory, undefined);
      else assert.ok(task.boardDirectory);
      for (const directories of starts) {
        assert.ok(directories.includes(dirname(restart.materialPath)));
        assert.ok(task.directories.every((directory) => directories.includes(directory)));
        if (task.boardDirectory) assert.ok(directories.includes(task.boardDirectory));
        assert.equal(directories.length, new Set(directories).size);
      }
    } finally {
      h.close();
    }
  });

test("a definitely refused close resumes the same restart while preserving paused state until all closures succeed", async () => {
  const h = await fixture();
  try {
    h.herdr.closeError = new OperationError("server_unavailable", "temporarily unavailable");
    await assert.rejects(h.service.restartParticipants(h.who, h.task.id, h.task.participantIds), {
      code: "server_unavailable",
    });
    const pending = h.store.list<TaskRestart>("task_restarts")[0];
    assert.equal(pending?.state, "closing");
    assert.equal(h.service.get(actor, h.task.id).status, "paused");
    assert.equal(h.service.get(actor, h.task.id).participants.length, 2);
    h.herdr.closeError = undefined;
    const restart = await h.service.restartParticipants(h.who, h.task.id, h.task.participantIds);
    assert.equal(restart.id, pending?.id);
    assert.equal(restart.state, "done");
    assert.equal(h.herdr.closes, 3, "one refused call followed by two confirmed closes");
    assert.equal(
      h.service.get(actor, h.task.id).participants.filter((p) => p.status !== "removed").length,
      2,
    );
  } finally {
    h.close();
  }
});

test("a new user message resumes the same unfinished restart and its replay returns the original result", async () => {
  const h = await fixture();
  try {
    const reads = nativeHistory(h);
    const close = h.herdr.close.bind(h.herdr);
    h.herdr.close = async (ref) => {
      if (h.herdr.closes === 1)
        h.herdr.closeError = new OperationError("server_unavailable", "temporarily unavailable");
      await close(ref);
    };
    await assert.rejects(h.service.restartParticipants(h.who, h.task.id, h.task.participantIds), {
      code: "server_unavailable",
    });
    const pending = h.store.list<TaskRestart>("task_restarts")[0];
    assert.ok(pending);
    assert.equal(h.herdr.closes, 2);
    const firstClose = h.store.get("operations", `${pending.id}:close:${h.task.participantIds[0]}`);
    const continuation = request(h, "continue-restart");
    h.herdr.close = close;
    h.herdr.closeError = undefined;
    const restart = await h.service.restartParticipants(
      continuation,
      h.task.id,
      [...h.task.participantIds].reverse(),
    );
    assert.equal(restart.id, pending.id);
    assert.equal(restart.state, "done");
    assert.deepEqual(restart.source, pending.source);
    assert.deepEqual(restart.history, pending.history);
    assert.deepEqual(
      h.store.get("operations", `${pending.id}:close:${h.task.participantIds[0]}`),
      firstClose,
    );
    assert.deepEqual([...reads.values()], [1, 1]);
    assert.equal(h.herdr.closes, 3, "the confirmed first close is reused by the new request");
    h.service.stop();
    const restored = new TaskService(h.options);
    for (const who of [continuation, h.who])
      assert.deepEqual(
        await restored.restartParticipants(who, h.task.id, h.task.participantIds),
        restart,
      );
    assert.equal(h.herdr.closes, 3);
    assert.equal(h.store.list<TaskRestart>("task_restarts").length, 1);
    assert.equal(restored.get(actor, h.task.id).participantIds.length, 4);
    await assert.rejects(
      restored.restartParticipants(continuation, h.task.id, h.task.participantIds.slice(0, 1)),
      { code: "operation_conflict" },
    );
  } finally {
    h.close();
  }
});

test("a new message cannot resume an unfinished restart with different participant targets", async () => {
  const h = await fixture();
  try {
    h.herdr.closeError = new OperationError("server_unavailable", "temporarily unavailable");
    await assert.rejects(h.service.restartParticipants(h.who, h.task.id, h.task.participantIds));
    const pending = h.store.list<TaskRestart>("task_restarts")[0];
    const continuation = request(h, "different-targets");
    h.herdr.closeError = undefined;
    await assert.rejects(
      h.service.restartParticipants(continuation, h.task.id, h.task.participantIds.slice(0, 1)),
      { code: "restart_pending" },
    );
    assert.equal(h.herdr.closes, 1);
    assert.deepEqual(h.store.list<TaskRestart>("task_restarts"), [pending]);
    assert.equal(h.service.get(actor, h.task.id).participantIds.length, 2);
  } finally {
    h.close();
  }
});

test("a new continuation message never replays an unknown close", async () => {
  const h = await fixture();
  try {
    h.herdr.closeError = new OperationError(
      "connection_failed",
      "close outcome unknown",
      "unknown",
    );
    await assert.rejects(h.service.restartParticipants(h.who, h.task.id, h.task.participantIds));
    const pending = h.store.list<TaskRestart>("task_restarts")[0];
    const continuation = request(h, "continue-unknown-close");
    h.herdr.closeError = undefined;
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(
        h.service.restartParticipants(continuation, h.task.id, h.task.participantIds),
        { code: "restart_effect_unknown" },
      );
    assert.equal(h.herdr.closes, 1);
    assert.equal(h.store.list<TaskRestart>("task_restarts").length, 1);
    const resumed = h.store.list<TaskRestart>("task_restarts")[0];
    assert.equal(resumed?.id, pending?.id);
    assert.ok(
      Object.values(resumed?.requests ?? {}).some(
        (source) => source.messageId === continuation.messageId,
      ),
    );
    assert.equal(h.service.get(actor, h.task.id).participantIds.length, 2);
  } finally {
    h.close();
  }
});

test("unknown closure never creates replacement resources or replays the close", async () => {
  const h = await fixture();
  try {
    h.herdr.closeError = new OperationError(
      "connection_failed",
      "close outcome unknown",
      "unknown",
    );
    await assert.rejects(h.service.restartParticipants(h.who, h.task.id, h.task.participantIds), {
      code: "connection_failed",
    });
    h.herdr.closeError = undefined;
    await assert.rejects(h.service.restartParticipants(h.who, h.task.id, h.task.participantIds), {
      code: "restart_effect_unknown",
    });
    assert.equal(h.herdr.closes, 1);
    assert.equal(h.service.get(actor, h.task.id).status, "paused");
    assert.equal(h.service.get(actor, h.task.id).participants.length, 2);
    assert.equal(
      h.store.entries<OperationReceipt>("operations").filter(([, r]) => r.state === "uncertain")
        .length,
      1,
    );
  } finally {
    h.close();
  }
});

test("native close ownership failure retains original participants and does not retire unknown input", async () => {
  const h = await fixture();
  try {
    h.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    await assert.rejects(
      h.service.send(actor, h.task.id, h.task.participantIds[0], "old unknown input"),
    );
    h.herdr.closeError = new OperationError("target_changed", "native pane now belongs elsewhere");
    await assert.rejects(h.service.restartParticipants(h.who, h.task.id, h.task.participantIds), {
      code: "target_changed",
    });
    const uncertain = h.store
      .entries<OperationReceipt>("operations")
      .find(([, r]) => r.state === "uncertain");
    assert.ok(uncertain);
    assert.equal(uncertain[1].retiredByRestart, undefined);
    assert.equal(
      h.service.get(actor, h.task.id).participants.some((p) => p.status === "removed"),
      false,
    );
    assert.equal(h.service.get(actor, h.task.id).discussion.paused, true);
  } finally {
    h.close();
  }
});

for (const completed of [false, true])
  test(`lifecycle ingress during a confirmed close prevents premature replacement (completed=${completed})`, async () => {
    const h = await fixture();
    const close = h.herdr.close.bind(h.herdr);
    try {
      h.herdr.close = async (ref) => {
        await close(ref);
        const current = h.service.get(actor, h.task.id);
        h.store.set<InboxRecord>("inbox", "lifecycle", {
          id: "lifecycle",
          type: "task",
          payload: { id: current.remoteTaskId as string },
          state: "processing",
          lane: "task",
          sequence: 2,
          createdAt: new Date().toISOString(),
        });
      };
      await assert.rejects(h.service.restartParticipants(h.who, h.task.id, h.task.participantIds), {
        code: "orchestration_deferred",
      });
      assert.equal(h.service.get(actor, h.task.id).participants.length, 2);
      assert.equal(h.service.get(actor, h.task.id).status, "paused");
      assert.equal(h.herdr.closes, 1);
      h.herdr.close = close;
      const remote = h.platform.tasks.get(h.service.get(actor, h.task.id).remoteTaskId as string);
      assert.ok(remote);
      if (completed) remote.completedAt = "1790648811982";
      await h.service.reconcile(h.task.id);
      const record = h.store.get<InboxRecord>("inbox", "lifecycle");
      assert.ok(record);
      h.store.set("inbox", "lifecycle", { ...record, state: "done" });
      if (completed) {
        await assert.rejects(
          h.service.restartParticipants(h.who, h.task.id, h.task.participantIds),
          { code: "task_ended" },
        );
        assert.equal(h.service.get(actor, h.task.id).participants.length, 2);
      } else {
        await h.service.restartParticipants(h.who, h.task.id, h.task.participantIds);
        assert.equal(h.herdr.closes, 2, "the first confirmed close is reused");
        assert.equal(
          h.service.get(actor, h.task.id).participants.filter((p) => p.status !== "removed").length,
          2,
        );
      }
    } finally {
      h.close();
    }
  });

test("workflow replacement replans with active participants and carries historical authorship to their replacements", async () => {
  const h = await fixture("workflow");
  try {
    const engine = new Engine();
    engine.handler = async (input) => {
      const tool = input.tools[0];
      assert.ok(tool);
      await tool.execute(
        tool.name === "orchestration_plan"
          ? { template: "discussion", instructions: {}, deliveryRequirements: [] }
          : { candidateId: JSON.parse(input.prompt).candidates[0].id, reason: "继续已有讨论" },
        input.actor,
      );
      return { text: "", messages: [] };
    };
    const worker = new TaskOrchestrator({
      config: h.config,
      projects: h.catalog,
      store: h.store,
      engine,
      tasks: () => h.service,
      tools: () => [],
      signal: new AbortController().signal,
      logger,
    });
    await worker.tick();
    h.herdr.delivery = { status: "unconfirmed", acked: true, verified: false, attempts: 1 };
    await worker.tick();
    const event = h.store
      .list<OrchestrationEvent>("task_orchestration_events")
      .find((entry) => entry.dispatches.some((dispatch) => dispatch.state === "uncertain"));
    assert.ok(event?.workflow);
    const state = h.store.get<WorkflowState>(WORKFLOWS, h.task.id);
    assert.ok(state);
    // Model an imported archive whose implementation-role evidence is known only in an old plan.
    const oldAuthor = h.task.participantIds[0] as string;
    const archival = {
      ...event,
      id: "archival-author",
      workflow: { ...event.workflow, planVersion: 100 },
      dispatches: [
        {
          operationId: "archival-write",
          participantId: oldAuthor,
          nodeId: "old-write",
          state: "sent" as const,
        },
      ],
    };
    h.store.set("task_orchestration_events", archival.id, archival);
    h.store.set("workflow_plans", `${h.task.id}:100`, {
      plan: { ...state.plan, nodes: [{ id: "old-write", access: "write", role: "implementer" }] },
    });
    state.implementationParticipants = [];
    h.store.set(WORKFLOWS, h.task.id, state);
    const restart = await h.service.restartParticipants(h.who, h.task.id, h.task.participantIds);
    const restored = h.store.get<WorkflowState>(WORKFLOWS, h.task.id);
    assert.ok(restored);
    assert.ok(
      restored.implementationParticipants?.includes(restart.replacements[oldAuthor] as string),
    );
    h.herdr.delivery = { status: "delivered", acked: true, verified: true, attempts: 1 };
    await h.service.reconcile(h.task.id);
    await worker.tick();
    await worker.tick();
    const active = h.service
      .get(actor, h.task.id)
      .participants.filter((p: Participant) => p.status !== "removed");
    assert.ok(active.every((p) => p.initialSent));
    const replanned = h.store.get<WorkflowState>(WORKFLOWS, h.task.id);
    assert.ok(replanned);
    assert.equal(
      replanned.plan.nodes.some(
        (node) => node.participantId && h.task.participantIds.includes(node.participantId),
      ),
      false,
    );
    assert.equal(
      h.store.get<OrchestrationEvent>("task_orchestration_events", event.id)?.state,
      "superseded",
    );
    assert.equal(h.herdr.sends.length, 3, "one old unknown input and two fresh openings only");
    assert.ok(h.herdr.sends.slice(1).every((sent) => sent.text.includes(restart.materialPath)));
  } finally {
    h.close();
  }
});
