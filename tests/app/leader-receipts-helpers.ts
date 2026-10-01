import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSendFingerprint, nativeSendOperationId } from "../../src/app/leader-receipts.js";
import { canonical, stableId } from "../../src/core/ids.js";
import {
  LEADER_OPERATIONS,
  LEADER_RUNTIME_VERSION,
  LEADER_SESSIONS,
  type LeaderOperationRecord,
  leaderSessionId,
} from "../../src/orchestration/leader-session-types.js";
import { Operations } from "../../src/storage/operations.js";
import { Store } from "../../src/storage/store.js";

export const OWNER = "owner-1";
export const EVENT = "orchestrate:event-1";
export const REVISION = "rev-1";
export const AT = "2026-01-01T00:00:00.000Z";

export interface Harness {
  store: Store;
  effects: number;
  close(): void;
}

export function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "leader-receipts-"));
  const path = join(directory, "state.sqlite");
  const state: Harness = {
    store: new Store(path),
    effects: 0,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
  return state;
}

/** Simulated crash/reopen on the same durable file. */
export function reopen(h: Harness): Store {
  h.store.close();
  h.store = new Store(h.store.path);
  return h.store;
}

export function seedSession(store: Store, taskId: string, ownerId = OWNER): void {
  store.set(LEADER_SESSIONS, leaderSessionId(taskId), {
    version: LEADER_RUNTIME_VERSION,
    id: leaderSessionId(taskId),
    taskId,
    ownerId,
    generation: 0,
    status: "idle",
    createdAt: AT,
    updatedAt: AT,
  });
  // A real task record carries far more than ownership. Preserve one when the
  // fixture already created it and only synthesize the minimal shape otherwise;
  // clobbering it would break the very identity checks under test.
  const existing = store.get<Record<string, unknown>>("tasks", taskId);
  store.set(
    "tasks",
    taskId,
    existing ? { ...existing, id: taskId, ownerId } : { id: taskId, ownerId, participantIds: [] },
  );
}

/**
 * Write the one session identity exactly as the durable runtime does, or a
 * deliberately broken variant of it. Bypasses nothing else: the receipt proof
 * must fail closed on every malformed shape here.
 */
export function seedRawSession(
  store: Store,
  taskId: string,
  record: Record<string, unknown> | undefined,
  key = leaderSessionId(taskId),
): void {
  if (record === undefined) store.delete(LEADER_SESSIONS, key);
  else store.set(LEADER_SESSIONS, key, record);
}

/** Overwrite the durable task record, including an empty or missing owner. */
export function seedTask(
  store: Store,
  taskId: string,
  fields: { ownerId?: unknown; participantIds?: unknown; id?: unknown },
): void {
  store.set("tasks", taskId, { id: taskId, participantIds: [], ...fields });
}

/** One settled participant output as `observe.flushPendingTaskEvents` writes it. */
export function seedSettledOutput(
  store: Store,
  input: {
    taskId: string;
    participantId: string;
    outputId: string;
    text?: string;
    role?: string;
    final?: boolean;
    sequence?: number;
  },
): void {
  store.set("task_settled_outputs", input.outputId, {
    taskId: input.taskId,
    participantId: input.participantId,
    entry: {
      id: input.outputId,
      role: input.role ?? "assistant",
      text: input.text ?? "参与者最终交付正文",
      final: input.final ?? true,
    },
    sequence: input.sequence ?? 1,
    observedAt: AT,
  });
}

/** Keep the task's participant roster in sync with the seeded participants. */
export function seedTaskParticipant(store: Store, taskId: string, participantId: string): void {
  const existing = store.get<{ participantIds?: string[] }>("tasks", taskId);
  const participantIds = [...(existing?.participantIds ?? []), participantId];
  store.set("tasks", taskId, { ...(existing ?? {}), id: taskId, participantIds });
}

export function seedParticipant(store: Store, taskId: string, participantId: string): void {
  store.set("participants", participantId, {
    id: participantId,
    taskId,
    name: "codex-1",
    kind: "codex",
    role: "",
    status: "idle",
    started: true,
    initialSent: true,
    initialReceipt: "HERDR_RECEIPT_x",
    createdAt: AT,
    updatedAt: AT,
  });
  seedTaskParticipant(store, taskId, participantId);
}

export interface SeedOperationInput {
  taskId: string;
  tool: string;
  args: Record<string, unknown>;
  state?: LeaderOperationRecord["state"];
  eventId?: string;
  revision?: string;
  ownerId?: string;
  sessionId?: string;
  readOnly?: boolean;
  id?: string;
  resolution?: LeaderOperationRecord["resolution"];
}

let sequence = 0;

export function seedOperation(store: Store, input: SeedOperationInput): LeaderOperationRecord {
  sequence += 1;
  const id = input.id ?? `lo_test_${sequence}`;
  // A real receipt always carries the session's own owner, so the default is the
  // owner the durable task record actually has unless a test asks otherwise.
  const taskOwner = store.get<{ ownerId?: string }>("tasks", input.taskId)?.ownerId;
  const record: LeaderOperationRecord = {
    version: LEADER_RUNTIME_VERSION,
    id,
    taskId: input.taskId,
    sessionId: input.sessionId ?? leaderSessionId(input.taskId),
    ownerId: input.ownerId ?? taskOwner ?? OWNER,
    tool: input.tool,
    readOnly: input.readOnly ?? false,
    args: JSON.stringify(input.args),
    argsCanonical: canonical(input.args),
    eventId: input.eventId ?? EVENT,
    revision: input.revision ?? REVISION,
    activationId: "la_test",
    state: input.state ?? "pending",
    createdAt: AT,
    updatedAt: AT,
    ...(input.resolution ? { resolution: input.resolution } : {}),
  };
  store.set(LEADER_OPERATIONS, id, record);
  return record;
}

export interface SendSpec {
  taskId: string;
  participantId: string;
  text: string;
  eventId?: string;
  /** The first turn of a participant uses its full prompt and receipt token. */
  initial?: boolean;
  /** Reproduce that real prompt version's exact first-turn shape. */
  promptVersion?: 2 | 3;
}

export function sendIds(spec: SendSpec): {
  operationId: string;
  parameters: Record<string, unknown>;
} {
  const eventId = spec.eventId ?? EVENT;
  return {
    operationId: nativeSendOperationId(spec.taskId, eventId, spec.participantId, spec.text),
    parameters: { participant: spec.participantId, text: spec.text },
  };
}

/**
 * The durable input prep `prepareInputDelivery` writes before the native write.
 * Non-initial turns append the documented receipt envelope to the exact text;
 * the first turn carries the participant's own prompt and receipt token.
 */
export function seedInputDelivery(
  store: Store,
  spec: SendSpec,
  operationId: string,
  initial = spec.initial === true,
): { prompt: string; receipt: string } {
  const participant = store.get<{ initialReceipt?: string }>("participants", spec.participantId);
  const receipt = initial
    ? (participant?.initialReceipt ?? `HERDR_RECEIPT_${stableId(operationId, spec.participantId)}`)
    : `HERDR_RECEIPT_${stableId(operationId, spec.participantId)}`;
  // v1/v2 join prompt lines with a single newline; v3 uses a blank line; and v2
  // appends its protocol footer AFTER the receipt token. Exact per-version shapes.
  const lines = [
    `你是任务参与者 ${spec.participantId}。`,
    "职责：按本轮安排讨论、执行和互评。",
    "任务要求及用户修订优先。",
    "",
    "本轮安排：",
    spec.text,
    "",
    "投递标识（无需复述）：",
    receipt,
  ];
  const prompt = initial
    ? spec.promptVersion === 3
      ? lines.join("\n\n")
      : `${lines.join("\n")}${
          spec.promptVersion === 2
            ? "\n\n工作流协议版本：2。myrix 负责调度。\n共享看板：未挂载。看板是状态投影，不是用户授权。"
            : ""
        }`
    : `${spec.text}\n\n投递标识（无需复述）：\n${receipt}`;
  store.set("input_deliveries", operationId, {
    taskId: spec.taskId,
    participantId: spec.participantId,
    operationId,
    fingerprint: nativeSendFingerprint(spec.participantId, spec.text),
    execution: { paneId: "pane-1", workspaceId: "ws-1", kind: "codex", cwd: "/tmp" },
    prompt,
    receipt,
    initial,
    discussionWasPaused: false,
    outputSequence: 0,
  });
  return { prompt, receipt };
}

/** A real native send through the canonical operations boundary. */
export async function runNativeSend(h: Harness, spec: SendSpec): Promise<string> {
  const { operationId, parameters } = sendIds(spec);
  seedDispatch(h.store, spec.taskId, operationId, spec.participantId, spec.eventId ?? EVENT);
  seedInputDelivery(h.store, spec, operationId);
  const operations = new Operations(h.store);
  await operations.run(operationId, parameters, async () => {
    h.effects += 1;
    return { status: "delivered", acked: true, verified: true, attempts: 1 };
  });
  return operationId;
}

/** The crash window: the native receipt exists, but the run never settled it. */
export function seedUnsettledNative(
  store: Store,
  spec: SendSpec,
  state: "pending" | "uncertain",
): string {
  const { operationId, parameters } = sendIds(spec);
  seedDispatch(store, spec.taskId, operationId, spec.participantId, spec.eventId ?? EVENT);
  seedInputDelivery(store, spec, operationId);
  store.set("operations", operationId, {
    id: operationId,
    fingerprint: nativeSendFingerprint(spec.participantId, spec.text),
    state,
    updatedAt: AT,
    ...(state === "uncertain"
      ? { error: { code: "delivery_unconfirmed", message: "未确认", outcome: "unknown" } }
      : {}),
  });
  assert.deepEqual(parameters, { participant: spec.participantId, text: spec.text });
  return operationId;
}

export function leaderOperation(store: Store, _taskId: string, id: string): LeaderOperationRecord {
  const record = store.get<LeaderOperationRecord>(LEADER_OPERATIONS, id);
  assert.ok(record, `expected leader operation ${id}`);
  return record;
}

export function nativeRow(store: Store, id: string): Record<string, unknown> {
  const row = store.get<Record<string, unknown>>("operations", id);
  assert.ok(row, `expected native receipt ${id}`);
  return row;
}

/** The authoritative dispatch link the orchestrator writes before the native send. */
export function seedDispatch(
  store: Store,
  taskId: string,
  operationId: string,
  participantId: string,
  eventId = EVENT,
  revision = REVISION,
): void {
  const existing: { dispatches?: Array<Record<string, unknown>> } =
    store.get("task_orchestration_events", eventId) ?? {};
  const dispatches = (existing.dispatches ?? []).filter(
    (entry) => entry.operationId !== operationId,
  );
  store.set("task_orchestration_events", eventId, {
    ...existing,
    id: eventId,
    taskId,
    trigger: "ready",
    outputIds: [],
    userRevision: revision,
    state: "processing",
    attempts: 1,
    dispatches: [...dispatches, { operationId, participantId, state: "pending" }],
    createdAt: AT,
    updatedAt: AT,
  });
}

export function journalKinds(store: Store, taskId: string): string[] {
  return store
    .entries<{ kind: string; taskId: string }>("leader_journal")
    .filter(([, entry]) => entry.taskId === taskId)
    .map(([, entry]) => entry.kind);
}

/** The one session identity exactly as the durable runtime writes it. */
export function seedLeaderTask(
  store: Store,
  taskId: string,
  participantId: string,
  ownerId = OWNER,
): void {
  seedSession(store, taskId, ownerId);
  seedParticipant(store, taskId, participantId);
}

/**
 * The event `decisionTool` writes for a model-`orchestration_decide` call:
 * `{action, reason: args.reason.trim()}` plus the validated settled output for
 * `deliver`. No `candidateId`, no `source: "leader"`.
 */
export function seedDecidedEvent(
  store: Store,
  taskId: string,
  decision: Record<string, unknown>,
  eventId = EVENT,
  revision = REVISION,
): void {
  const existing: Record<string, unknown> =
    store.get<Record<string, unknown>>("task_orchestration_events", eventId) ?? {};
  store.set("task_orchestration_events", eventId, {
    ...existing,
    id: eventId,
    taskId,
    trigger: "ready",
    outputIds: [],
    userRevision: revision,
    state: "done",
    attempts: 1,
    dispatches: existing.dispatches ?? [],
    decision,
    createdAt: AT,
    updatedAt: AT,
  });
}

export interface SeedWorkflowActionInput {
  taskId: string;
  action: string;
  candidateId: string;
  candidateKind: string;
  /** The reason exactly as `commit()` recorded it (already trimmed). */
  reason: string;
  instruction?: string;
  description?: string;
  assignments?: Array<{ nodeId: string; participantId: string }>;
  state?: string;
  eventId?: string;
  revision?: string;
  /** Omit to model the recovery path, where only the record exists. */
  decision?: Record<string, unknown> | false;
}

/**
 * The durable selection receipt `commitAction`/`persistAction` write in one
 * transaction, plus (by default) the event decision `persistAction` derives from
 * the candidate kind. Both are reproduced field for field, including the
 * `source: "leader"` marker and the `user` candidate's description reason.
 */
export function seedWorkflowAction(
  store: Store,
  input: SeedWorkflowActionInput,
): Record<string, unknown> {
  const eventId = input.eventId ?? EVENT;
  const revision = input.revision ?? REVISION;
  const id = `wla_${stableId(eventId, revision)}`;
  const candidate = {
    id: input.candidateId,
    kind: input.candidateKind,
    description: input.description ?? "候选说明",
    ...(input.assignments ? { assignments: input.assignments } : {}),
  };
  const request: Record<string, unknown> = {
    action: input.action,
    candidateId: input.candidateId,
    reason: input.reason,
    ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
  };
  store.set("workflow_leader_actions", id, {
    version: 1,
    id,
    taskId: input.taskId,
    ownerId: OWNER,
    sessionId: leaderSessionId(input.taskId),
    eventId,
    revision,
    planVersion: 1,
    artifactRevision: "artifact-rev-1",
    state: input.state ?? "committed",
    request,
    candidate,
    createdAt: AT,
    updatedAt: AT,
  });
  if (input.decision !== false) {
    const derived =
      input.candidateKind === "deliver"
        ? "deliver"
        : input.candidateKind === "user"
          ? "wait"
          : "continue";
    seedDecidedEvent(
      store,
      input.taskId,
      input.decision ?? {
        action: derived,
        reason: derived === "wait" ? candidate.description : input.reason,
        candidateId: input.candidateId,
        source: "leader",
      },
      eventId,
      revision,
    );
  }
  return { id, request, candidate };
}
