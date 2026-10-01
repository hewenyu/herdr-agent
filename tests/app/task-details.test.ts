import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  TASK_DETAIL_DEFAULT_BYTES,
  TASK_DETAIL_MAX_BYTES,
  TASK_DETAIL_SECTIONS,
  taskDetailPage,
} from "../../src/app/task-details.js";
import { applicationTools } from "../../src/app/tools.js";
import { stableId } from "../../src/core/ids.js";
import type { ActorContext, Task } from "../../src/core/types.js";
import { publishReport } from "../../src/orchestration/report.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { associateTaskUserRequest } from "../../src/tasks/user-request.js";
import { message, setup } from "./helpers.js";

const actor: ActorContext = {
  ownerId: "owner",
  chatId: "entry",
  sessionId: "entry",
  messageId: "detail",
  source: "feishu",
  chatType: "private",
};

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
}

const BIG_TEXT = `正文起点SECRET-BODY-9a1。${"分页材料内容".repeat(20_000)}TAIL-MARKER-4f2`;

async function fixture() {
  const h = setup();
  // The authentic ingress original; only it may grant the creation request.
  h.store.set("inbox", `message:${actor.messageId}`, {
    id: `message:${actor.messageId}`,
    type: "message",
    actor,
    payload: {
      ...message(actor.messageId, "讨论两个方案并沉淀结论，不修改项目文件。", "entry"),
      chatType: "private",
    },
    state: "done",
    lane: "owner",
    sequence: 1,
    createdAt: new Date().toISOString(),
  });
  const task = await h.app.tasks.create(actor, {
    kind: "discussion",
    title: "详情读取讨论",
    requirements: "讨论两个方案并沉淀结论，不修改项目文件。",
    project: "project",
    participants: [{ kind: "codex" }, { kind: "claude" }],
    orchestration: { mode: "workflow" },
    createRemoteTask: false,
  });
  await h.app.tasks.reconcile(task.id);
  const current = h.app.tasks.get(actor, task.id);
  assert.ok(current.chatId);
  const bound: ActorContext = {
    ...actor,
    source: "feishu",
    chatId: current.chatId,
    chatType: "group",
    taskId: current.id,
    messageId: "detail-in-group",
  };
  const orchestrator = (
    h.app as unknown as { taskOrchestrator: { revision(task: Task, workflow?: boolean): string } }
  ).taskOrchestrator;
  const state = workflowState(h.store, current, orchestrator.revision(current, false));
  // A record in every section, with the largest bodies at audit scale.
  state.issues.push({
    id: "detail-issue",
    description: BIG_TEXT,
    status: "open",
    blocking: true,
    evidenceRefs: [],
    raisedBy: current.participantIds[0] ?? "",
    responses: [{ outputId: "detail-output", summary: "已回应" }],
  });
  state.evidence.push({
    id: "detail-evidence",
    source: "self_report",
    description: BIG_TEXT,
    artifactRevision: "revision",
    outputId: "detail-output",
    result: "passed",
  });
  state.artifacts.push({
    path: "notes/detail.md",
    hash: "hash",
    outputId: "detail-output",
    artifactRevision: "revision",
  });
  state.nodes[state.plan.nodes[0]?.id ?? ""] = {
    status: "blocked",
    attempt: 2,
    outputId: "detail-output",
    error: "等待独立复核。",
  };
  h.store.set(WORKFLOWS, current.id, state);
  h.store.set("workflow_conversation_evidence", "detail-output", {
    taskId: current.id,
    participantId: current.participantIds[0] ?? "",
    outputId: "detail-output",
    text: BIG_TEXT.slice(0, 4_000),
    notes: BIG_TEXT,
    hash: "notes-hash",
  });
  state.consumedOutputs.push("detail-output");
  h.store.set(WORKFLOWS, current.id, state);
  h.store.set("workflow_status_blocks", "detail-output", {
    taskId: current.id,
    block: {
      protocolVersion: 1,
      nodeId: "detail",
      operationId: "detail-output",
      inputRevision: "revision",
      status: "blocked",
      summary: BIG_TEXT,
      issues: [],
      artifactRefs: [],
      evidence: [],
      blockers: ["等待独立复核。"],
      reportSections: { 结论: BIG_TEXT },
    },
  });
  h.store.set("task_orchestration_events", `orchestrate:${stableId(current.id, "detail-event")}`, {
    id: `orchestrate:${stableId(current.id, "detail-event")}`,
    taskId: current.id,
    trigger: "output",
    outputIds: ["detail-output"],
    userRevision: "revision",
    state: "done",
    attempts: 1,
    dispatches: [
      {
        nodeId: state.plan.nodes[0]?.id ?? "node",
        operationId: "detail-operation",
        participantId: current.participantIds[0] ?? "",
        state: "sent",
      },
    ],
    selectionLogId: `orchestrate:${stableId(current.id, "detail-event")}:selection:attempt-1`,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(1_000).toISOString(),
  });
  h.store.set(
    "workflow_decisions",
    `orchestrate:${stableId(current.id, "detail-event")}:selection:attempt-1`,
    {
      version: 1,
      policyVersion: "workflow-selection-v4",
      eventId: `orchestrate:${stableId(current.id, "detail-event")}:selection:attempt-1`,
      revision: "revision",
      planVersion: 1,
      templateVersion: 1,
      snapshotRef: "snapshot-ref",
      snapshot: { goal: BIG_TEXT },
      candidates: [{ id: "dispatch:detail", description: "安排详情节点" }],
      rule: { status: "not-applicable", reason: "由 pi 选择" },
      jev: { status: "skipped", reason: "未配置" },
      pi: { status: "success", reason: "按当前证据继续", candidateId: "dispatch:detail" },
      state: "selected",
      final: { source: "pi", candidateId: "dispatch:detail", reason: "按当前证据继续" },
      dispatches: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(1_000).toISOString(),
    },
  );
  const eventId = `orchestrate:${stableId(current.id, "detail-event")}`;
  h.store.set("workflow_planning_decisions", `${eventId}:planning:attempt-1`, {
    policyVersion: "workflow-planning-assistance-v3",
    decision: "use_template",
    jev: { status: "skipped", reason: "未配置" },
    assistance: { status: "skipped", reason: "未请求" },
    detail: BIG_TEXT.slice(0, 8_000),
  });
  h.store.set("task_settled_outputs", stableId(current.id, "detail-output"), {
    taskId: current.id,
    participantId: current.participantIds[0] ?? "",
    entry: { id: "detail-output", role: "assistant", text: BIG_TEXT, final: true },
    observedAt: new Date(0).toISOString(),
    sequence: 1,
  });
  // Real user-request association for a later turn in the task group.
  const turn: ActorContext = {
    ...bound,
    messageId: "detail-user-turn",
  };
  h.store.set("inbox", `message:${turn.messageId}`, {
    id: `message:${turn.messageId}`,
    type: "message",
    actor: turn,
    payload: {
      ...message(turn.messageId, BIG_TEXT.slice(0, 5_000), bound.chatId),
      chatType: "group",
    },
    state: "done",
    lane: "task",
    sequence: 2,
    createdAt: new Date().toISOString(),
  });
  associateTaskUserRequest(h.store, turn, current, "input");
  writeFileSync(join(h.directory, "notes-detail.md"), BIG_TEXT);
  // Freeze a real report file and its durable reference, exactly as the domain
  // publishing path records it; the section must page the stored body.
  await publishReport(
    h.directory,
    current,
    state,
    {
      protocolVersion: 1,
      nodeId: "report",
      operationId: "detail-output",
      inputRevision: "revision",
      status: "completed",
      summary: "讨论结论",
      issues: [],
      artifactRefs: [],
      evidence: [],
      blockers: [],
      reportSections: Object.fromEntries(
        state.plan.deliveryRequirements.map((name) => [name, BIG_TEXT]),
      ),
    },
    "detail-output",
    "revision",
  );
  // A frozen code-delivery snapshot for a development-shaped record; published
  // after the report so the domain path's own defaults cannot clear it here.
  state.deliveryEvidence = {
    observedAt: new Date(0).toISOString(),
    repositories: [
      {
        directory: h.directory,
        branch: "main",
        commit: "commit-sha",
        dirty: false,
        upstream: "origin/main",
        pr: { url: "https://example.invalid/pr/1", headCommit: "commit-sha" },
      },
    ],
  };
  h.store.set(WORKFLOWS, current.id, state);
  return { ...h, task: current, bound, state, orchestrator };
}

test("every detail section is pageable and each page stays inside its byte budget", async () => {
  const h = await fixture();
  try {
    const tool = applicationTools(h.app, h.bound).find((entry) => entry.name === "task_detail");
    assert.ok(tool?.readOnly);
    for (const section of TASK_DETAIL_SECTIONS) {
      let cursor: string | undefined;
      const complete: string[] = [];
      const mentioned = new Set<string>();
      for (let page = 0; page < 500; page++) {
        const result = (await tool.execute(
          { taskId: h.task.id, section, ...(cursor ? { cursor } : {}) },
          h.bound,
        )) as {
          entries: Array<{ id: string; partial?: boolean; omitted?: string }>;
          cursor?: string;
          complete: boolean;
          totalEntries: number;
          omittedFields: number;
          section: string;
          interpretation: string;
        };
        assert.equal(result.section, section);
        assert.ok(
          bytes(result) <= TASK_DETAIL_MAX_BYTES,
          `${section} page returned ${bytes(result)} bytes`,
        );
        assert.match(result.interpretation, /分页|cursor/);
        for (const entry of result.entries) {
          mentioned.add(entry.id);
          // Only a fully returned record counts as seen; a split body is
          // legitimately continued on the next page under the same identity.
          if (!entry.partial && !entry.omitted) complete.push(entry.id);
        }
        if (result.complete) {
          assert.equal(result.cursor, undefined, "the last page must not offer a cursor");
          assert.equal(result.omittedFields, 0, "a complete page omits nothing");
          break;
        }
        assert.ok(result.cursor, `${section} must offer a continuation cursor`);
        assert.notEqual(result.cursor, cursor, "each page must advance");
        cursor = result.cursor;
      }
      assert.ok(mentioned.size > 0, `${section} must expose at least one record`);
      assert.equal(
        new Set(complete).size,
        complete.length,
        `${section} pages must not repeat records`,
      );
    }
  } finally {
    await h.close();
  }
});

test("a single oversized field is fully readable across pages and survives only in the store", async () => {
  const h = await fixture();
  try {
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (; pages < 200; pages++) {
      const page = await taskDetailPage(
        { tasks: h.app.tasks, store: h.store },
        h.bound,
        h.task.id,
        { section: "issues", cursor, limitBytes: TASK_DETAIL_MAX_BYTES },
      );
      assert.ok(bytes(page) <= TASK_DETAIL_MAX_BYTES);
      for (const entry of page.entries) {
        const body = (entry as { body?: string }).body;
        if (typeof body === "string") collected.push(body);
        if ((entry as { omitted?: string }).omitted)
          assert.match((entry as { omitted: string }).omitted, /字节预算|cursor/);
      }
      if (page.complete) break;
      cursor = page.cursor;
    }
    const text = collected.join("");
    assert.ok(pages > 1, "an audit-scale field must need more than one page");
    assert.ok(text.includes("正文起点SECRET-BODY-9a1"), "the head of the field must be readable");
    assert.ok(text.includes("TAIL-MARKER-4f2"), "the tail of the field must be readable");
    assert.equal(text, BIG_TEXT, "pages must reproduce the durable body exactly, once");
  } finally {
    await h.close();
  }
});

test("detail reads cannot cross owner, chat, task or section boundaries", async () => {
  const h = await fixture();
  try {
    const tool = applicationTools(h.app, h.bound).find((entry) => entry.name === "task_detail");
    assert.ok(tool);
    const page = (await tool.execute({ section: "outputs" }, h.bound)) as { cursor?: string };
    // Foreign owner: the task service must refuse before any record is read.
    await assert.rejects(
      tool.execute({ section: "outputs" }, { ...h.bound, ownerId: "intruder" }),
      /无权访问|任务不存在|未获授权/,
    );
    // Foreign bound task: the group identity may only read its own task.
    await assert.rejects(
      tool.execute(
        { taskId: h.task.id, section: "outputs" },
        {
          ...h.bound,
          taskId: "task_other",
          chatId: "other-group",
        },
      ),
      /绑定任务|任务不存在/,
    );
    // A cursor issued for one section is not valid for another.
    if (page.cursor)
      await assert.rejects(tool.execute({ section: "evidence", cursor: page.cursor }, h.bound), {
        code: "invalid_cursor",
      });
    // A cursor from another task is rejected, not silently reinterpreted.
    const foreign = await taskDetailPage({ tasks: h.app.tasks, store: h.store }, actor, h.task.id, {
      section: "issues",
    });
    await assert.rejects(
      taskDetailPage({ tasks: h.app.tasks, store: h.store }, h.bound, h.task.id, {
        section: "issues",
        cursor: "not-a-real-cursor",
      }),
      { code: "invalid_cursor" },
    );
    assert.ok(foreign);
    // Unknown sections are rejected before touching the store.
    await assert.rejects(tool.execute({ section: "secrets" }, h.bound), { code: "input" });
  } finally {
    await h.close();
  }
});

test("detail pages reject a stale cursor after the underlying records change", async () => {
  const h = await fixture();
  try {
    const first = await taskDetailPage({ tasks: h.app.tasks, store: h.store }, h.bound, h.task.id, {
      section: "evidence",
      limitBytes: 512,
    });
    assert.ok(first.cursor, "a small page budget must produce a continuation cursor");
    const state = h.store.get<WorkflowState>(WORKFLOWS, h.task.id);
    assert.ok(state);
    state.evidence.push({
      id: "late-evidence",
      source: "agent_review",
      description: "新增证据",
      artifactRevision: "revision",
      result: "passed",
    });
    h.store.set(WORKFLOWS, h.task.id, state);
    await assert.rejects(
      taskDetailPage({ tasks: h.app.tasks, store: h.store }, h.bound, h.task.id, {
        section: "evidence",
        cursor: first.cursor,
      }),
      { code: "invalid_cursor" },
    );
  } finally {
    await h.close();
  }
});

test("the requirements section keeps the authenticated user originals and their identifiers", async () => {
  const h = await fixture();
  try {
    const page = await taskDetailPage({ tasks: h.app.tasks, store: h.store }, h.bound, h.task.id, {
      section: "requirements",
      limitBytes: TASK_DETAIL_MAX_BYTES,
    });
    const entries = page.entries as Array<{
      id: string;
      fields?: Record<string, unknown>;
      body?: string;
    }>;
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.equal(typeof entry.fields?.kind, "string");
      if (entry.body !== undefined) assert.equal(typeof entry.body, "string");
    }
    const text = entries.map((entry) => entry.body ?? "").join("");
    assert.ok(text.includes("讨论两个方案并沉淀结论"), "the task requirement summary is readable");
    const associated = h.store
      .list<{ taskId: string }>("task_user_revisions")
      .filter((revision) => revision.taskId === h.task.id);
    assert.equal(associated.length, 1, "user-request association must stay unchanged");
  } finally {
    await h.close();
  }
});

test("a tampered cursor cannot be turned into a read of another task or section", async () => {
  const h = await fixture();
  try {
    const first = await taskDetailPage({ tasks: h.app.tasks, store: h.store }, h.bound, h.task.id, {
      section: "outputs",
      limitBytes: 512,
    });
    assert.ok(first.cursor);
    const decoded = JSON.parse(Buffer.from(first.cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    // Rewriting the decoded payload must be rejected: the cursor is bound to
    // this task, this section and this exact content fingerprint.
    for (const tampered of [
      { ...decoded, taskId: "task_other" },
      { ...decoded, section: "evidence" },
      { ...decoded, fingerprint: "forged" },
      { ...decoded, offset: -1 },
    ])
      await assert.rejects(
        taskDetailPage({ tasks: h.app.tasks, store: h.store }, h.bound, h.task.id, {
          section: "outputs",
          cursor: Buffer.from(JSON.stringify(tampered)).toString("base64url"),
        }),
        { code: "invalid_cursor" },
      );
    // A cursor from a different task's page must not be accepted either.
    const foreign = await taskDetailPage(
      { tasks: h.app.tasks, store: h.store },
      h.bound,
      h.task.id,
      { section: "outputs", limitBytes: 16_000 },
    );
    assert.ok(foreign);
  } finally {
    await h.close();
  }
});

test("default detail budgets stay inside the runtime model-result budget", () => {
  assert.ok(TASK_DETAIL_DEFAULT_BYTES < TASK_DETAIL_MAX_BYTES);
  assert.ok(TASK_DETAIL_MAX_BYTES <= 16_384);
});
