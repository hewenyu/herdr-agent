import assert from "node:assert/strict";
import test from "node:test";
import { applicationTools } from "../../src/app/tools.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { Participant, Task, TranscriptEntry } from "../../src/core/types.js";
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
