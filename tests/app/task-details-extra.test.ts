import assert from "node:assert/strict";
import test from "node:test";
import { taskDetailPage } from "../../src/app/task-details.js";
import { stableId } from "../../src/core/ids.js";
import type { ActorContext, Participant, Task } from "../../src/core/types.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { setup } from "./helpers.js";

const actor: ActorContext = {
  ownerId: "owner",
  chatId: "entry",
  sessionId: "entry",
  messageId: "extra",
};

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
}

/** Reads every page of a section and returns the concatenated canonical text. */
async function readAll(
  services: Parameters<typeof taskDetailPage>[0],
  taskId: string,
  section: string,
  limitBytes = 16_000,
) {
  const bodies: string[] = [];
  const ids = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 500; page++) {
    const result = await taskDetailPage(services, actor, taskId, {
      section,
      cursor,
      limitBytes,
    });
    assert.ok(
      bytes(result) <= limitBytes,
      `${section} page returned ${bytes(result)} bytes over ${limitBytes}`,
    );
    for (const entry of result.entries) {
      ids.add(entry.id);
      if (typeof entry.body === "string") bodies.push(entry.body);
      // Field values are canonical content too: a reader reconstructs the
      // record from both the paged body and the inline field projection.
      if (entry.fields) bodies.push(JSON.stringify(entry.fields));
    }
    if (result.complete) {
      assert.equal(result.cursor, undefined, "a complete page must not offer a cursor");
      return { text: bodies.join(""), ids, pages: page + 1, result };
    }
    assert.ok(result.cursor, "an incomplete page must offer a continuation cursor");
    assert.notEqual(result.cursor, cursor, "each page must advance");
    cursor = result.cursor;
  }
  assert.fail(`${section} did not terminate`);
}

async function fixture(requirements = "读取全部规范记录。") {
  const h = setup();
  const task = await h.app.tasks.create(actor, {
    kind: "discussion",
    title: "补充边界",
    requirements,
    participants: [{ kind: "claude" }],
    createGroup: false,
    createRemoteTask: false,
    orchestration: { mode: "manual" },
  });
  const current = h.store.get<Task>("tasks", task.id);
  assert.ok(current);
  const services = { store: h.store, tasks: h.app.tasks };
  return { h, task: current, services };
}

/** Minimal durable workflow state so state-backed sections have a real record. */
function seedWorkflow(
  h: ReturnType<typeof setup>,
  task: Task,
  consumedOutputs: string[] = [],
): WorkflowState {
  const state = {
    taskId: task.id,
    plan: {
      id: "plan-1",
      version: 1,
      templateVersion: 1,
      template: "discussion",
      goal: "读取记录",
      nodes: [
        {
          id: "node-1",
          phase: "discussing",
          role: "analyst",
          purpose: "讨论",
          instruction: "讨论",
          dependsOn: [],
          access: "read",
        },
      ],
      deliveryRequirements: ["给出结论"],
    },
    phase: "discussing",
    userRevision: "revision",
    nodes: {},
    issues: [],
    evidence: [],
    artifacts: [],
    consumedOutputs,
    batches: [],
    stall: { open: [], unchanged: 0, awaitingUser: false },
  } as unknown as WorkflowState;
  h.store.set(WORKFLOWS, task.id, state);
  return state;
}

function event(taskId: string, id = "extra-event", overrides: Record<string, unknown> = {}) {
  return {
    id,
    taskId,
    trigger: "ready",
    userRevision: "revision",
    state: "done",
    attempts: 1,
    outputIds: [],
    dispatches: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("every canonical field of an orchestration event survives paging, including nested errors", async () => {
  const { h, task, services } = await fixture();
  try {
    const nested = `${"E".repeat(20_000)}NESTED_ERROR_TAIL`;
    const dispatchText = `${"D".repeat(9_000)}DISPATCH_TEXT_TAIL`;
    h.store.set(
      "task_orchestration_events",
      "extra-event",
      event(task.id, "extra-event", {
        trigger: "output",
        state: "attention",
        outputIds: Array.from({ length: 80 }, (_, index) => `output-${index}`),
        dispatches: [
          {
            operationId: "op-1",
            participantId: "participant-1",
            nodeId: "node-1",
            state: "uncertain",
            inputRevision: "revision",
            artifactRevision: "artifact",
            text: dispatchText,
          },
        ],
        error: { code: "transport", outcome: "unknown", message: nested },
        decision: {
          action: "deliver",
          reason: "X".repeat(5_000),
          outputId: "output-0",
          participantId: "participant-1",
          candidateId: "candidate-1",
          source: "pi",
        },
        workflow: {
          candidate: {
            id: "dispatch:node-1",
            kind: "dispatch",
            description: "Y".repeat(6_000),
            assignments: Array.from({ length: 40 }, (_, index) => ({
              nodeId: `node-${index}`,
              participantId: `participant-${index}`,
            })),
          },
          planVersion: 3,
          artifactRevision: "artifact",
          applied: true,
        },
        notificationCause: "Z".repeat(4_000),
      }),
    );
    const read = await readAll(services, task.id, "orchestration");
    // Every canonical value is reachable, including the tails of nested values.
    for (const marker of [
      "NESTED_ERROR_TAIL",
      "DISPATCH_TEXT_TAIL",
      "output-79",
      "participant-39",
      "candidate-1",
    ])
      assert.ok(read.text.includes(marker), `${marker} must stay readable`);
    // Nothing is projected through a fields-only view: the section has bodies.
    assert.ok(read.text.length > 40_000, `only ${read.text.length} canonical chars were readable`);
    assert.equal(h.herdr.sends.length, 0);
    assert.equal(h.engine.calls.length, 0);
  } finally {
    await h.close();
  }
});

test("decision snapshots, candidates and selector controls are readable in full", async () => {
  const { h, task, services } = await fixture();
  try {
    h.store.set("task_orchestration_events", "extra-event", event(task.id, "extra-event"));
    const snapshotBody = `${"S".repeat(18_000)}SNAPSHOT_TAIL`;
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      id: `dispatch:node-${index}`,
      kind: "dispatch",
      description: `${"C".repeat(2_000)}CANDIDATE_${index}_TAIL`,
      assignments: [{ nodeId: `node-${index}`, participantId: `participant-${index}` }],
    }));
    h.store.set("workflow_decisions", "extra-event:selection:review", {
      version: 1,
      policyVersion: "workflow-selection-v4",
      eventId: "extra-event:selection:review",
      revision: "revision",
      planVersion: 1,
      templateVersion: 1,
      snapshotRef: "durable-snapshot",
      snapshot: { original: snapshotBody, nested: { deep: snapshotBody } },
      candidates,
      selectorCandidates: candidates.slice(0, 20),
      rule: { status: "not-applicable", reason: "由 pi 选择" },
      jev: { status: "skipped", reason: "未配置" },
      pi: { status: "success", reason: "继续", candidateId: "dispatch:node-0" },
      state: "selected",
      final: { source: "pi", candidateId: "dispatch:node-0", reason: "继续" },
      dispatches: [{ operationId: "op", state: "sent", receiptId: "receipt" }],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(1_000).toISOString(),
    });
    const read = await readAll(services, task.id, "decisions");
    assert.ok(read.text.includes("SNAPSHOT_TAIL"), "the snapshot tail must be readable");
    assert.ok(read.text.includes("CANDIDATE_39_TAIL"), "every candidate must be readable");
    // Both copies of the nested snapshot body are preserved: the canonical
    // record genuinely contains the value twice at two different paths.
    const occurrences = read.text.split("SNAPSHOT_TAIL").length - 1;
    assert.equal(occurrences, 2, "each canonical path must be returned exactly once");
    assert.ok(read.text.includes("durable-snapshot"));
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    await h.close();
  }
});

test("status block reportSections, issues and evidence bodies are readable in full", async () => {
  const { h, task, services } = await fixture();
  try {
    seedWorkflow(h, task, ["output-block"]);
    const report = `${"R".repeat(15_000)}REPORT_SECTION_TAIL`;
    h.store.set("workflow_status_blocks", "output-block", {
      taskId: task.id,
      block: {
        protocolVersion: 1,
        nodeId: "report",
        operationId: "output-block",
        inputRevision: "revision",
        status: "completed",
        summary: `${"M".repeat(3_000)}SUMMARY_TAIL`,
        issues: [
          {
            id: "blocked-issue",
            description: `${"I".repeat(7_000)}ISSUE_TAIL`,
            status: "open",
            blocking: true,
            evidenceRefs: ["evidence-1"],
          },
        ],
        evidence: [
          {
            id: "evidence-1",
            description: `${"V".repeat(7_000)}EVIDENCE_TAIL`,
            command: "npm test",
            result: "failed",
          },
        ],
        blockers: [`${"B".repeat(5_000)}BLOCKER_TAIL`],
        artifactRefs: ["notes/report.md"],
        reportSections: {
          结论: report,
          风险: `${"K".repeat(12_000)}RISK_TAIL`,
        },
        responses: [{ outputId: "peer", comment: `${"P".repeat(4_000)}RESPONSE_TAIL` }],
      },
    });
    const read = await readAll(services, task.id, "status_blocks");
    for (const marker of [
      "SUMMARY_TAIL",
      "ISSUE_TAIL",
      "EVIDENCE_TAIL",
      "BLOCKER_TAIL",
      "REPORT_SECTION_TAIL",
      "RISK_TAIL",
      "RESPONSE_TAIL",
    ])
      assert.ok(read.text.includes(marker), `${marker} must be readable`);
    assert.ok(read.text.includes("npm test"), "evidence commands stay visible");
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    await h.close();
  }
});

test("participant errors, session notes and last output remain readable", async () => {
  const { h, task, services } = await fixture();
  try {
    const participant = h.app.tasks.records.participants(task)[0];
    assert.ok(participant);
    h.app.tasks.records.saveParticipant({
      ...participant,
      status: "error",
      error: `${"X".repeat(12_000)}PARTICIPANT_ERROR_TAIL`,
      sessionNote: `${"N".repeat(9_000)}SESSION_NOTE_TAIL`,
      lastOutput: `${"O".repeat(6_000)}LAST_OUTPUT_TAIL`,
      cursor: "cursor-1",
    } as unknown as Participant);
    const read = await readAll(services, task.id, "participants");
    for (const marker of ["PARTICIPANT_ERROR_TAIL", "SESSION_NOTE_TAIL", "LAST_OUTPUT_TAIL"])
      assert.ok(read.text.includes(marker), `${marker} must be readable`);
    assert.ok(read.text.includes("cursor-1"), "the durable cursor stays visible");
  } finally {
    await h.close();
  }
});

test("legacy requirements are readable without any authenticated request metadata", async () => {
  const original = `${"L".repeat(25_000)}LEGACY_TAIL`;
  const { h, task, services } = await fixture(original);
  try {
    assert.equal(h.store.get<Task>("tasks", task.id)?.userRequest, undefined);
    const read = await readAll(services, task.id, "requirements");
    assert.ok(read.text.includes("LEGACY_TAIL"), "the task's own requirements are canonical");
    assert.ok(read.text.includes("task_requirements"), "the reader names what it returned");
  } finally {
    await h.close();
  }
});

test("a nested planning record keeps every key readable across pages", async () => {
  const { h, task, services } = await fixture();
  try {
    h.store.set("task_orchestration_events", "extra-event", event(task.id, "extra-event"));
    h.store.set("workflow_planning_decisions", "extra-event:planning:attempt-1", {
      policyVersion: "workflow-planning-assistance-v3",
      decision: "use_template",
      jev: { status: "skipped", reason: `${"J".repeat(8_000)}JEV_TAIL` },
      assistance: {
        status: "requested",
        reason: "需要协助",
        candidates: Array.from({ length: 30 }, (_, index) => ({
          id: `candidate-${index}`,
          description: `${"A".repeat(1_500)}ASSIST_${index}_TAIL`,
        })),
      },
      detail: `${"D".repeat(11_000)}PLANNING_TAIL`,
    });
    h.store.set("workflow_contract_decisions", "contract-1", {
      taskId: task.id,
      planVersion: 1,
      change: { removeDocumentDelivery: true, authorizationId: "authorization" },
      decision: "denied",
      reason: `${"C".repeat(6_000)}CONTRACT_TAIL`,
      policyVersion: "workflow-contract-authorization-v2",
      pi: { status: "success", reason: "拒绝", candidateId: "denied" },
    });
    const read = await readAll(services, task.id, "planning");
    for (const marker of ["JEV_TAIL", "ASSIST_29_TAIL", "PLANNING_TAIL", "CONTRACT_TAIL"])
      assert.ok(read.text.includes(marker), `${marker} must be readable`);
  } finally {
    await h.close();
  }
});

test("the status section exposes the complete durable workflow state", async () => {
  const { h, task, services } = await fixture();
  try {
    const filler = `${"W".repeat(12_000)}STATUS_TAIL`;
    const state = {
      taskId: task.id,
      plan: {
        id: "plan-1",
        version: 2,
        templateVersion: 1,
        template: "discussion",
        goal: filler,
        nodes: [
          {
            id: "node-1",
            phase: "discussing",
            role: "analyst",
            purpose: filler,
            instruction: filler,
            dependsOn: [],
            access: "read",
          },
        ],
        deliveryRequirements: [filler],
        validation: { mode: "not_run", reason: filler },
      },
      phase: "discussing",
      userRevision: "revision",
      documentSource: { directories: [h.directory], paths: ["notes.md"], revision: "revision" },
      nodes: { "node-1": { status: "blocked", attempt: 2, error: filler } },
      implementationParticipants: ["participant-1"],
      issues: [],
      evidence: [],
      artifacts: [],
      consumedOutputs: [],
      consensusApprovals: [
        { participantId: "p", outputId: "o", artifactRevision: "a", documents: [] },
      ],
      batches: ["batch-1"],
      stall: { open: ["node-1"], unchanged: 2, awaitingUser: true },
      planning: "needed",
      planningReason: filler,
      assistanceWait: { eventId: "e", fingerprint: "f", reason: filler },
      error: filler,
    } as unknown as WorkflowState;
    h.store.set(WORKFLOWS, task.id, state);
    const read = await readAll(services, task.id, "status");
    assert.ok(read.text.includes("STATUS_TAIL"), "oversized status fields must be pageable");
    assert.ok(read.text.includes("consensusApprovals"), "every state key stays named");
    assert.ok(read.text.includes('"awaitingUser":true') || read.text.includes("awaitingUser"));
    assert.ok(read.text.includes("batch-1"));
  } finally {
    await h.close();
  }
});

test("evidence notes and settled outputs keep their canonical text", async () => {
  const { h, task, services } = await fixture();
  try {
    h.store.set("workflow_conversation_evidence", "output-1", {
      taskId: task.id,
      participantId: "participant-1",
      outputId: "output-1",
      text: `${"T".repeat(5_000)}NOTE_TEXT_TAIL`,
      notes: `${"Q".repeat(14_000)}NOTES_TAIL`,
      hash: "hash",
    });
    h.store.set("task_settled_outputs", stableId(task.id, "output-1"), {
      taskId: task.id,
      participantId: "participant-1",
      entry: {
        id: "output-1",
        role: "assistant",
        text: `${"U".repeat(13_000)}OUTPUT_TAIL`,
        final: true,
      },
      observedAt: new Date(0).toISOString(),
      sequence: 1,
    });
    const notes = await readAll(services, task.id, "evidence_notes");
    assert.ok(notes.text.includes("NOTES_TAIL"), "conversation notes must be readable");
    assert.ok(notes.text.includes("hash"), "the canonical hash stays visible");
    const outputs = await readAll(services, task.id, "outputs");
    assert.ok(outputs.text.includes("OUTPUT_TAIL"), "settled output text must be readable");
    assert.ok(outputs.text.includes("output-1"));
  } finally {
    await h.close();
  }
});

test("delivery evidence and task revisions keep every canonical field readable", async () => {
  const { h, task, services } = await fixture();
  try {
    const state = {
      taskId: task.id,
      plan: {
        id: "plan",
        version: 1,
        templateVersion: 1,
        template: "development",
        goal: "交付",
        nodes: [
          {
            id: "node",
            phase: "implementing",
            role: "implementer",
            purpose: "实现",
            instruction: "实现",
            dependsOn: [],
            access: "write",
          },
        ],
        deliveryRequirements: ["交付"],
      },
      phase: "reporting",
      userRevision: "revision",
      nodes: {},
      issues: [],
      evidence: [],
      artifacts: [],
      consumedOutputs: [],
      batches: [],
      stall: { open: [], unchanged: 0, awaitingUser: false },
      deliveryEvidence: {
        observedAt: new Date(0).toISOString(),
        repositories: [
          {
            directory: h.directory,
            branch: "main",
            commit: "commit",
            dirty: false,
            statusRevision: "s",
            indexRevision: "i",
            upstream: "origin/main",
            pr: { url: "https://example.invalid/pr/1", headCommit: "commit" },
            error: `${"R".repeat(6_000)}REPO_ERROR_TAIL`,
          },
        ],
      },
    } as unknown as WorkflowState;
    h.store.set(WORKFLOWS, task.id, state);
    h.store.set("task_user_revisions", stableId(task.id, "message-1"), {
      taskId: task.id,
      source: {
        source: "feishu",
        ownerId: "owner",
        sessionId: "entry",
        chatId: "group",
        messageId: "message-1",
        eventId: "event-1",
        text: `${"V".repeat(10_000)}REVISION_TAIL`,
      },
      at: new Date(0).toISOString(),
      usage: "input",
    });
    const delivery = await readAll(services, task.id, "delivery");
    assert.ok(delivery.text.includes("REPO_ERROR_TAIL"), "repository errors must be readable");
    assert.ok(delivery.text.includes("origin/main"));
    const requirements = await readAll(services, task.id, "requirements");
    assert.ok(requirements.text.includes("REVISION_TAIL"), "later revisions must be readable");
    assert.ok(requirements.text.includes('"usage":"input"'));
  } finally {
    await h.close();
  }
});

test("a minimal budget either pages the section or refuses with a typed budget error", async () => {
  const { h, task, services } = await fixture(`${"M".repeat(20_000)}MIN_BUDGET_TAIL`);
  try {
    h.store.set(
      "task_orchestration_events",
      "extra-event",
      event(task.id, "extra-event", {
        error: { code: "transport", outcome: "unknown", message: `${"X".repeat(20_000)}ERR_TAIL` },
      }),
    );
    for (const section of ["requirements", "orchestration"]) {
      // 2000 bytes is enough for the mandatory framing plus real content; the
      // minimal 512 budget may legitimately refuse with context_budget rather
      // than dropping required metadata.
      const read = await readAll(services, task.id, section, 2000);
      assert.ok(read.pages > 1, `${section} must page at a tight but workable budget`);
      assert.ok(
        read.text.includes("MIN_BUDGET_TAIL") || read.text.includes("ERR_TAIL"),
        `${section} must reach the canonical tail`,
      );
    }
    // The smallest accepted budget never silently overshoots or omits: either
    // it returns a bounded page, or it fails closed with the typed error.
    for (const section of ["requirements", "orchestration"]) {
      try {
        const page = await taskDetailPage(services, actor, task.id, { section, limitBytes: 512 });
        assert.ok(bytes(page) <= 512, `${section} exceeded the 512 byte budget`);
        if (page.cursor)
          assert.ok(
            page.entries.every((entry) => entry.partial || !entry.omitted),
            "a paged record must state its continuation, never a silent skip",
          );
      } catch (error) {
        assert.equal((error as { code?: string }).code, "context_budget");
      }
    }
  } finally {
    await h.close();
  }
});

test("a cursor cannot be reused after the canonical content changes shape", async () => {
  const { h, task, services } = await fixture(`${"A".repeat(8_000)}`);
  try {
    const first = await taskDetailPage(services, actor, task.id, {
      section: "requirements",
      limitBytes: 2000,
    });
    assert.ok(first.cursor);
    // Same byte length, different content, and a different record count.
    const current = h.store.get<Task>("tasks", task.id);
    assert.ok(current);
    h.store.set<Task>("tasks", task.id, { ...current, requirements: "B".repeat(8_000) });
    await assert.rejects(
      taskDetailPage(services, actor, task.id, {
        section: "requirements",
        cursor: first.cursor,
        limitBytes: 2000,
      }),
      { code: "invalid_cursor" },
    );
    const added = h.store.get<Task>("tasks", task.id);
    assert.ok(added);
    h.store.set<Task>("tasks", task.id, {
      ...added,
      requestContext: [
        {
          source: "feishu",
          ownerId: "owner",
          sessionId: "entry",
          chatId: "entry",
          messageId: "context-1",
          eventId: "event-1",
          text: "新增上下文",
        },
      ],
    });
    // A freshly issued cursor tracks the new content shape.
    const later = await taskDetailPage(services, actor, task.id, {
      section: "requirements",
      limitBytes: 2000,
    });
    assert.ok(later.cursor ?? later.complete);
    if (later.cursor) {
      const second = await taskDetailPage(services, actor, task.id, {
        section: "requirements",
        cursor: later.cursor,
        limitBytes: 2000,
      });
      assert.ok(second.totalEntries >= later.totalEntries);
    }
  } finally {
    await h.close();
  }
});
