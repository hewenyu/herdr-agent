import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  TASK_DETAIL_SECTION_BUILDERS,
  TASK_DETAIL_SECTIONS,
  taskDetailSectionEntries,
  type WorkflowStateReader,
} from "../../src/app/task-detail-sections.js";
import { taskDetailPage } from "../../src/app/task-details.js";
import type { ActorContext, Participant, Task } from "../../src/core/types.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import type { Store } from "../../src/storage/store.js";
import { setup } from "./helpers.js";

const actor: ActorContext = {
  ownerId: "owner",
  chatId: "entry",
  sessionId: "entry",
  messageId: "lazy",
};

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
}

interface Scan {
  method: "get" | "entries" | "list";
  namespace: string;
  key?: string;
}

/**
 * Read-only store proxy that records every namespace a code path touches, so a
 * section page can be proven to consult only the records it claims to need.
 * `forbidden` namespaces fail loudly instead of being recorded: a section that
 * reaches one is a structural regression, not a slow path.
 */
function scanSpy(store: Store, forbidden: readonly string[] = []) {
  const scans: Scan[] = [];
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const method = String(property);
      if (method !== "get" && method !== "entries" && method !== "list") return value.bind(target);
      return (namespace: string, ...rest: unknown[]) => {
        if (forbidden.includes(namespace))
          throw new Error(`section read forbidden namespace ${namespace}`);
        scans.push({
          method: method as Scan["method"],
          namespace,
          ...(rest.length ? { key: String(rest[0]) } : {}),
        });
        return (value as (...args: unknown[]) => unknown).apply(target, [namespace, ...rest]);
      };
    },
  }) as Store;
  return { store: proxy, scans };
}

/** Namespaces every detail read must touch: task lookup and participant projection. */
const AUTHORIZATION_NAMESPACES = ["tasks", "input_deliveries", "operations", "participants"];

/**
 * Exact namespaces each section may consult. A section that grows a read of a
 * sibling section's records fails here rather than silently regressing the fix.
 */
const SECTION_NAMESPACES: Record<string, string[]> = {
  status: [...AUTHORIZATION_NAMESPACES, "task_workflows"],
  participants: [...AUTHORIZATION_NAMESPACES],
  requirements: [
    ...AUTHORIZATION_NAMESPACES,
    "task_creation_summaries",
    "task_user_revisions",
    "messages",
  ],
  orchestration: [...AUTHORIZATION_NAMESPACES, "task_orchestration_events"],
  decisions: [...AUTHORIZATION_NAMESPACES, "task_orchestration_events", "workflow_decisions"],
  planning: [
    ...AUTHORIZATION_NAMESPACES,
    "task_orchestration_events",
    "workflow_planning_decisions",
    "workflow_document_decisions",
    "workflow_contract_decisions",
    "workflow_plans",
    "workflow_staged_plans",
  ],
  evidence_notes: [
    ...AUTHORIZATION_NAMESPACES,
    "workflow_conversation_evidence",
    "workflow_recovery_materials",
  ],
  status_blocks: [...AUTHORIZATION_NAMESPACES, "task_workflows", "workflow_status_blocks"],
  outputs: [...AUTHORIZATION_NAMESPACES, "task_settled_outputs"],
};

const REPORT_BODY = `${"R".repeat(12_000)}REPORT_FILE_SENTINEL_TAIL`;
const PARTICIPANT_OUTPUT = `${"O".repeat(9_000)}PARTICIPANT_OUTPUT_TAIL`;

async function fixture() {
  const h = setup();
  const created = await h.app.tasks.create(actor, {
    kind: "discussion",
    title: "惰性分节",
    requirements: "只读取请求的 section。",
    participants: [{ kind: "claude" }],
    createGroup: false,
    createRemoteTask: false,
    orchestration: { mode: "manual" },
  });
  const task = h.store.get<Task>("tasks", created.id);
  assert.ok(task);
  const participant = h.app.tasks.records.participants(task)[0];
  assert.ok(participant);
  h.app.tasks.records.saveParticipant({
    ...participant,
    lastOutput: PARTICIPANT_OUTPUT,
  } as unknown as Participant);
  // Every section namespace gets one distinct canonical record so a leak is
  // observable in the section's own text and in the scan spy.
  h.store.set("task_orchestration_events", "lazy-event", {
    id: "lazy-event",
    taskId: task.id,
    trigger: "ready",
    userRevision: "revision",
    state: "done",
    attempts: 1,
    outputIds: [],
    dispatches: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  h.store.set("workflow_decisions", "lazy-event:selection:1", {
    policyVersion: "v",
    state: "selected",
    revision: "revision",
    snapshot: { secret: "DECISION_SENTINEL" },
    candidates: [],
    dispatches: [],
  });
  h.store.set("workflow_planning_decisions", "lazy-event:planning:1", {
    decision: "use_template",
    detail: "PLANNING_SENTINEL",
  });
  h.store.set("workflow_contract_decisions", "lazy-contract", {
    taskId: task.id,
    decision: "denied",
    reason: "CONTRACT_SENTINEL",
  });
  h.store.set("workflow_plans", `${task.id}:1`, {
    taskId: task.id,
    plan: { goal: "FROZEN_PLAN_SENTINEL" },
  });
  h.store.set("workflow_staged_plans", "lazy-event:1", {
    id: "plan",
    version: 1,
    goal: "STAGED_PLAN_SENTINEL",
  });
  h.store.set("workflow_conversation_evidence", "lazy-note", {
    taskId: task.id,
    participantId: participant.id,
    outputId: "lazy-note",
    text: "NOTE_SENTINEL",
    notes: "NOTES_SENTINEL",
    hash: "h",
  });
  h.store.set("workflow_recovery_materials", "lazy-material", {
    taskId: task.id,
    text: "RECOVERY_SENTINEL",
    notes: "RECOVERY_NOTES_SENTINEL",
  });
  h.store.set("workflow_status_blocks", "lazy-block", {
    taskId: task.id,
    block: { summary: "BLOCK_SENTINEL", issues: [], evidence: [], artifactRefs: [] },
  });
  h.store.set("task_settled_outputs", "lazy-output", {
    taskId: task.id,
    participantId: participant.id,
    entry: { id: "lazy-output", role: "assistant", text: "OUTPUT_SENTINEL", final: true },
    observedAt: new Date(0).toISOString(),
    sequence: 1,
  });
  h.store.set("task_creation_summaries", task.id, {
    requirements: "SUMMARY_SENTINEL",
    sourceMessageId: "message",
    contextMessageIds: [],
    at: new Date(0).toISOString(),
  });
  // A frozen report: the only durable way to reach its body is reading the
  // workflow record and then the report file.
  const reportPath = join(h.directory, "lazy-report.md");
  writeFileSync(reportPath, REPORT_BODY);
  const { createHash } = await import("node:crypto");
  const state = {
    taskId: task.id,
    plan: {
      id: "plan-1",
      version: 1,
      templateVersion: 1,
      template: "discussion",
      goal: "STATUS_SENTINEL",
      nodes: [
        {
          id: "node-1",
          phase: "discussing",
          role: "analyst",
          purpose: "讨论",
          instruction: "NODE_SENTINEL",
          dependsOn: [],
          access: "read",
        },
      ],
      deliveryRequirements: ["结论"],
    },
    phase: "discussing",
    userRevision: "revision",
    nodes: {},
    issues: [],
    evidence: [],
    artifacts: [],
    consumedOutputs: [],
    batches: [],
    stall: { open: [], unchanged: 0, awaitingUser: false },
    report: {
      id: "report-1",
      path: reportPath,
      hash: createHash("sha256").update(REPORT_BODY).digest("hex"),
      outputId: "lazy-output",
      artifactRevision: "revision",
    },
  } as unknown as WorkflowState;
  h.store.set(WORKFLOWS, task.id, state);
  return { h, task, state, services: { store: h.store, tasks: h.app.tasks } };
}

test("only the requested section's namespaces are scanned; reports stay unread", async () => {
  const { h, task, services } = await fixture();
  try {
    for (const section of TASK_DETAIL_SECTIONS) {
      const allowed = SECTION_NAMESPACES[section] ?? [
        ...AUTHORIZATION_NAMESPACES,
        "task_workflows",
      ];
      const { store, scans } = scanSpy(services.store);
      const page = await taskDetailPage({ tasks: services.tasks, store }, actor, task.id, {
        section,
        limitBytes: 16_000,
      });
      const touched = new Set(scans.map((scan) => scan.namespace));
      for (const namespace of touched)
        assert.ok(
          allowed.includes(namespace),
          `${section} must not read ${namespace} (read: ${[...touched].join(", ")})`,
        );
      assert.ok(bytes(page) <= 16_000, `${section} must stay inside its byte budget`);
    }
  } finally {
    await h.close();
  }
});

test("a participants-only page never touches decisions, planning, contracts, outputs or the report", async () => {
  const { h, task, services } = await fixture();
  try {
    const unrelated = [
      "task_workflows",
      "workflow_decisions",
      "workflow_planning_decisions",
      "workflow_document_decisions",
      "workflow_contract_decisions",
      "workflow_plans",
      "workflow_staged_plans",
      "task_settled_outputs",
    ];
    // Forbidden reads throw, so a single stray lookup fails the page instead of
    // merely being counted. Reading the report requires `task_workflows` first,
    // so an unread workflow record also proves the report file stays unread.
    const { store, scans } = scanSpy(services.store, unrelated);
    const page = await taskDetailPage({ tasks: services.tasks, store }, actor, task.id, {
      section: "participants",
      limitBytes: 16_000,
    });
    for (const namespace of unrelated)
      assert.ok(
        !scans.some((scan) => scan.namespace === namespace),
        `participants must not read ${namespace}`,
      );
    const text = JSON.stringify(page);
    assert.ok(text.includes("PARTICIPANT_OUTPUT_TAIL"), "the participant record stays readable");
    assert.ok(!text.includes("REPORT_FILE_SENTINEL_TAIL"), "no report body may reach participants");
    assert.ok(!text.includes("DECISION_SENTINEL"));
    assert.ok(!text.includes("PLANNING_SENTINEL"));
    assert.ok(!text.includes("CONTRACT_SENTINEL"));
    assert.ok(!text.includes("OUTPUT_SENTINEL"));
  } finally {
    await h.close();
  }
});

test("sibling section builders are never invoked for another section", async () => {
  const { h, task, state, services } = await fixture();
  try {
    const original = { ...TASK_DETAIL_SECTION_BUILDERS };
    const counts = new Map<string, number>();
    for (const section of TASK_DETAIL_SECTIONS) {
      const builder = original[section];
      TASK_DETAIL_SECTION_BUILDERS[section] = (...args) => {
        counts.set(section, (counts.get(section) ?? 0) + 1);
        return builder(...args);
      };
    }
    try {
      const reader: WorkflowStateReader = () => state;
      const participants = services.tasks.get(actor, task.id).participants as Participant[];
      const entries = await taskDetailSectionEntries(
        services.store,
        task,
        reader,
        participants,
        "participants",
      );
      assert.ok(entries.length > 0);
    } finally {
      Object.assign(TASK_DETAIL_SECTION_BUILDERS, original);
    }
    assert.equal(counts.get("participants"), 1, "the requested builder runs exactly once");
    for (const [section, count] of counts) {
      if (section === "participants") continue;
      assert.equal(count, undefined, `${section} must not be built for a participants page`);
    }
  } finally {
    await h.close();
  }
});

test("the workflow record is resolved only for state-backed sections", async () => {
  const { h, task, services } = await fixture();
  try {
    for (const section of TASK_DETAIL_SECTIONS) {
      const { store, scans } = scanSpy(services.store);
      await taskDetailPage({ tasks: services.tasks, store }, actor, task.id, {
        section,
        limitBytes: 16_000,
      });
      const workflowReads = scans.filter(
        (scan) => scan.namespace === WORKFLOWS && scan.method === "get",
      ).length;
      const stateBacked = (
        SECTION_NAMESPACES[section] ?? [...AUTHORIZATION_NAMESPACES, "task_workflows"]
      ).includes("task_workflows");
      assert.equal(
        workflowReads,
        stateBacked ? 1 : 0,
        `${section}: workflow record reads must be ${stateBacked ? 1 : 0}, got ${workflowReads}`,
      );
    }
  } finally {
    await h.close();
  }
});

test("participants pagination stays lossless, cursor-bound and content-sensitive", async () => {
  const { h, task, services } = await fixture();
  try {
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (; pages < 500; pages++) {
      const page = await taskDetailPage(services, actor, task.id, {
        section: "participants",
        cursor,
        limitBytes: 1_000,
      });
      assert.ok(bytes(page) <= 1_000, "every participants page must respect the byte budget");
      assert.equal(page.section, "participants");
      for (const entry of page.entries) collected.push(entry.body ?? "");
      if (page.complete) {
        assert.equal(page.cursor, undefined, "a complete page must not offer a cursor");
        assert.equal(page.omittedFields, 0);
        break;
      }
      assert.ok(page.cursor, "an incomplete page must offer a continuation cursor");
      assert.notEqual(page.cursor, cursor, "each page must advance");
      cursor = page.cursor;
    }
    assert.ok(pages > 1, "a 9KB participant output must need several 1KB pages");
    assert.equal(
      collected.join("").includes(PARTICIPANT_OUTPUT),
      true,
      "pagination must reproduce the participant body",
    );

    // A cursor is scoped to this section and this content: unrelated sections
    // changing must not invalidate it, while the section's own records must.
    const first = await taskDetailPage(services, actor, task.id, {
      section: "participants",
      limitBytes: 1_000,
    });
    assert.ok(first.cursor);
    await assert.rejects(
      taskDetailPage(services, actor, task.id, {
        section: "outputs",
        cursor: first.cursor,
        limitBytes: 1_000,
      }),
      { code: "invalid_cursor" },
    );
    h.store.set("workflow_decisions", "later-decision", {
      policyVersion: "v",
      state: "selected",
      snapshot: { secret: "LATE" },
      candidates: [],
      dispatches: [],
    });
    const afterUnrelatedChange = await taskDetailPage(services, actor, task.id, {
      section: "participants",
      cursor: first.cursor,
      limitBytes: 1_000,
    });
    assert.equal(afterUnrelatedChange.section, "participants");

    h.app.tasks.records.saveParticipant({
      ...h.app.tasks.records.participants(task)[0],
      cursor: "changed",
    } as unknown as Participant);
    await assert.rejects(
      taskDetailPage(services, actor, task.id, {
        section: "participants",
        cursor: first.cursor,
        limitBytes: 1_000,
      }),
      { code: "invalid_cursor" },
      "a changed participants record must invalidate its cursor",
    );
  } finally {
    await h.close();
  }
});

test("scope authorization still precedes every lazy section read", async () => {
  const { h, task, services } = await fixture();
  try {
    const intruder: ActorContext = { ...actor, ownerId: "intruder" };
    for (const section of ["participants", "decisions", "report"]) {
      const { store, scans } = scanSpy(services.store);
      await assert.rejects(
        taskDetailPage({ tasks: services.tasks, store }, intruder, task.id, { section }),
        /无权访问|任务不存在|未获授权/,
        `${section} must refuse a foreign owner`,
      );
      assert.deepEqual(scans, [], `${section} must authorize before any section read`);
    }
  } finally {
    await h.close();
  }
});
