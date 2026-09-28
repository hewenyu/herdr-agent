import assert from "node:assert/strict";
import test from "node:test";
import { applicationTools } from "../../src/app/tools.js";
import { taskProgress } from "../../src/app/workflow-progress.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type {
  AgentKind,
  AgentSnapshot,
  Participant,
  Task,
  TranscriptEntry,
} from "../../src/core/types.js";
import { HerdrRuntime } from "../../src/herdr/runtime.js";
import { setup } from "./helpers.js";

const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "progress" };

async function create(h: ReturnType<typeof setup>) {
  return h.app.tasks.create(actor, {
    kind: "discussion",
    title: "讨论",
    requirements: "讨论方案",
    project: "project",
    participants: [{ kind: "codex" }, { kind: "claude" }],
    orchestration: { mode: "workflow" },
  });
}

test("v3 records intermediate output internally without platform/default history delivery or background pi", async () => {
  const h = setup();
  try {
    const task = await create(h);
    task.promptVersion = 3;
    h.app.tasks.records.save(task);
    const participant = h.app.tasks.records.participants(task)[0];
    assert.ok(participant);
    const callbacks = h.app as unknown as {
      output(task: Task, participant: Participant, entry: TranscriptEntry): Promise<void>;
      notice(task: Task, kind: string): Promise<void>;
    };
    const entry: TranscriptEntry = {
      id: "turn",
      role: "assistant",
      text: "内部自然讨论",
      final: true,
    };
    await callbacks.output(task, participant, entry);
    assert.equal(h.platform.texts.length, 0);
    assert.equal(h.store.list("messages").length, 0);
    assert.equal(h.store.list("workflow_outputs").length, 1);
    await callbacks.notice(task, "welcome");
    await callbacks.notice(task, "group_ready");
    task.status = "running";
    await callbacks.notice(task, "progress");
    assert.equal(h.platform.texts.length, 1);
    assert.equal(h.engine.calls.length, 0);
    task.status = "attention";
    task.error = "实际错误";
    await callbacks.notice(task, "progress");
    assert.equal(h.platform.texts.length, 2);
    assert.match(h.platform.texts[1]?.text ?? "", /实际错误/);
    assert.equal(h.engine.calls.length, 0);
  } finally {
    await h.close();
  }
});

test("task_progress reads only bound participant conversation and never advances observation cursor", async () => {
  const h = setup();
  try {
    const task = await create(h);
    const participant = h.app.tasks.records.participants(task)[0];
    assert.ok(participant);
    participant.initialSent = true;
    participant.cursor = "scheduler-cursor";
    participant.execution = {
      workspaceId: "workspace",
      paneId: "pane",
      kind: "codex",
      cwd: h.directory,
      sessionId: "session",
    };
    h.app.tasks.records.saveParticipant(participant);
    let reads = 0;
    (h.herdr as HerdrPort).conversation = async (ref, receipt, cursor) => {
      reads++;
      assert.deepEqual(ref, participant.execution);
      assert.equal(receipt, participant.initialReceipt);
      assert.equal(cursor, "progress-cursor");
      return {
        entries: [{ id: "entry", role: "assistant", text: "正在比较两个方案", final: false }],
        truncated: false,
      };
    };
    const tool = applicationTools(h.app, actor).find((tool) => tool.name === "task_progress");
    assert.ok(tool?.readOnly);
    const result = (await tool.execute(
      { taskId: task.id, participantId: participant.id, cursor: "progress-cursor" },
      actor,
    )) as { participants: Array<{ conversation: TranscriptEntry[] }> };
    assert.equal(result.participants[0]?.conversation[0]?.text, "正在比较两个方案");
    assert.equal(h.app.tasks.records.participants(task)[0]?.cursor, "scheduler-cursor");
    await assert.rejects(tool.execute({ taskId: task.id }, { ...actor, ownerId: "foreign" }));
    await assert.rejects(
      tool.execute({ taskId: task.id, participantId: "other-task-participant" }, actor),
    );
    await assert.rejects(
      tool.execute({ taskId: task.id }, { ...actor, taskId: "other", chatId: "other-chat" }),
    );
    assert.equal(reads, 1);
  } finally {
    await h.close();
  }
});

async function boundProgress(kind: AgentKind = "codex", sessionId?: string) {
  const h = setup();
  const task = await create(h);
  const participant = h.app.tasks.records.participants(task).find((entry) => entry.kind === kind);
  assert.ok(participant);
  participant.initialSent = true;
  participant.cursor = "scheduler-cursor";
  participant.execution = {
    workspaceId: "workspace",
    paneId: "pane",
    kind,
    cwd: h.directory,
    ...(sessionId ? { sessionId } : {}),
    transcriptReceipt: participant.initialReceipt,
  };
  h.app.tasks.records.saveParticipant(participant);
  const live: AgentSnapshot = {
    ...participant.execution,
    sessionId: "live-session",
    status: "working",
    stateSeq: "1",
    interactiveReady: true,
    launchPending: false,
  };
  h.herdr.agents.set(live.paneId, live);
  const tool = applicationTools(h.app, actor).find((entry) => entry.name === "task_progress");
  assert.ok(tool);
  const read = async () => {
    const result = (await tool.execute(
      { taskId: task.id, participantId: participant.id, cursor: "progress-cursor" },
      actor,
    )) as {
      participants: Array<{
        id: string;
        conversation?: TranscriptEntry[];
        runtime?: { sessionId?: string };
        readError?: string;
      }>;
    };
    const observed = result.participants.find((entry) => entry.id === participant.id);
    assert.ok(observed);
    return observed;
  };
  return { ...h, task, participant, live, read };
}

for (const kind of ["codex", "claude"] as const)
  test(`task_progress pins a sessionless ${kind} read to the observed session without changing its saved binding`, async () => {
    const h = await boundProgress(kind);
    try {
      const before = structuredClone(h.participant);
      let reads = 0;
      (h.herdr as HerdrPort).conversation = async (target, receipt, cursor) => {
        reads++;
        assert.deepEqual(target, { ...before.execution, sessionId: h.live.sessionId });
        assert.equal(receipt, before.initialReceipt);
        assert.equal(cursor, "progress-cursor");
        return {
          entries: [
            { id: "native-entry", role: "assistant", text: "已完成方案比较", final: false },
          ],
          truncated: false,
        };
      };
      const result = await h.read();
      assert.equal(result.readError, undefined);
      assert.equal(result.runtime?.sessionId, "live-session");
      assert.equal(result.conversation?.[0]?.text, "已完成方案比较");
      assert.equal(reads, 1);
      assert.deepEqual(h.store.get<Participant>("participants", before.id), before);
      assert.equal(h.herdr.sends.length, 0);
    } finally {
      await h.close();
    }
  });

for (const field of [
  "paneId",
  "workspaceId",
  "kind",
  "cwd",
  "sessionId",
  "missingSession",
] as const)
  test(`task_progress still rejects a changed ${field} before reading native content`, async () => {
    const h = await boundProgress(
      "codex",
      field.includes("Session") || field === "sessionId" ? "live-session" : undefined,
    );
    try {
      const changed = { ...h.live };
      if (field === "missingSession") delete changed.sessionId;
      else if (field === "kind") changed.kind = "claude";
      else changed[field] = "different";
      h.herdr.agents.set(h.live.paneId, changed);
      (h.herdr as HerdrPort).conversation = async () => {
        assert.fail("mismatched participant identity must not reach the transcript reader");
      };
      const result = await h.read();
      assert.match(result.readError ?? "", /现场已不属于原参与者会话/);
      assert.deepEqual(result.conversation, []);
      assert.equal(h.herdr.sends.length, 0);
    } finally {
      await h.close();
    }
  });

test("a sessionless progress read still rejects changes to the saved participant binding during observation", async () => {
  const h = await boundProgress();
  try {
    (h.herdr as HerdrPort).conversation = async (target) => {
      h.app.tasks.records.saveParticipant({ ...h.participant, execution: target });
      return {
        entries: [{ id: "native-entry", role: "assistant", text: "不可返回", final: false }],
        truncated: false,
      };
    };
    const result = await h.read();
    assert.match(result.readError ?? "", /读取期间参与者绑定已变化/);
    assert.deepEqual(result.conversation, []);
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    await h.close();
  }
});

test("progress fixes the observed live session before the runtime rechecks a reused pane", async () => {
  const h = await boundProgress();
  try {
    const runtime = new HerdrRuntime({ homeDir: h.directory });
    let observations = 0;
    runtime.client.get = async () => ({
      ...h.live,
      sessionId: ++observations === 1 ? "observed-session" : "replacement-session",
    });
    let nativeReads = 0;
    (
      runtime as unknown as {
        transcripts: { conversation: NonNullable<HerdrPort["conversation"]> };
      }
    ).transcripts.conversation = async () => {
      nativeReads++;
      return { entries: [], truncated: false };
    };
    const result = await taskProgress(
      { tasks: h.app.tasks, herdr: runtime, store: h.store },
      actor,
      h.task.id,
      h.participant.id,
    );
    const observed = result.participants.find((entry) => entry.id === h.participant.id);
    assert.ok(observed && "readError" in observed);
    assert.match(observed.readError ?? "", /参与者会话已变化/);
    assert.equal(observations, 2);
    assert.equal(nativeReads, 0);
    assert.deepEqual(h.store.get<Participant>("participants", h.participant.id), h.participant);
  } finally {
    await h.close();
  }
});
