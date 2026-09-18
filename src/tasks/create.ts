import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fail } from "../core/errors.js";
import { canonical, newId, now, stableId } from "../core/ids.js";
import type { ActorContext, Participant, Task, TaskCreateInput } from "../core/types.js";
import { assertActive, type TaskContext } from "./context.js";

export async function createTask(
  context: TaskContext,
  actor: ActorContext,
  input: TaskCreateInput,
): Promise<Task> {
  assertActive(context);
  const { records, catalog, config, store } = context;
  records.authorize(actor.ownerId);
  if (!config.tasks.enabled) fail("tasks_disabled", "任务管理尚未启用。");
  if (!actor.messageId || !actor.sessionId || !actor.chatId)
    fail("task_identity", "任务来源身份不完整。");
  if (actor.taskId) fail("task_scope", "任务群不能创建其他任务，请回飞书主入口创建。");
  if (records.byChat(actor.chatId))
    fail("task_scope", "任务群不能创建其他任务，请回飞书主入口创建。");
  if (!input.requirements.trim() || !input.title.trim())
    fail("task_requirements", "请填写任务名称和完整要求。");
  if (!["discussion", "development", "review", "test"].includes(input.kind))
    fail("task_kind", "任务类型无效。");
  if (!input.participants.length || input.participants.length > 8)
    fail("participants", "任务需要 1 到 8 位参与者。");
  for (const participant of input.participants) {
    if (!["codex", "claude"].includes(participant.kind))
      fail("participant_kind", "参与者仅支持 Codex 或 Claude。");
  }
  if (input.directoryMode && !["shared", "worktree"].includes(input.directoryMode))
    fail("directory_mode", "目录隔离模式无效。");
  if (input.discussion?.mode && !["manual", "round_robin"].includes(input.discussion.mode))
    fail("discussion_mode", "讨论模式无效。");
  const maxRounds = input.discussion?.maxRounds ?? 4;
  const maxMinutes = input.discussion?.maxMinutes ?? 30;
  if (
    !Number.isInteger(maxRounds) ||
    maxRounds < 1 ||
    maxRounds > 50 ||
    !Number.isFinite(maxMinutes) ||
    maxMinutes < 1 ||
    maxMinutes > 240
  ) {
    fail("discussion_budget", "讨论轮数为 1 到 50，时长为 1 到 240 分钟。");
  }
  const parent = input.parentTaskId ? records.get(actor, input.parentTaskId) : undefined;
  // A message identity is only unique inside its bound pi session.  Keeping
  // the session in the durable task key prevents two independently selected
  // sessions that happen to reuse a Web request id from returning the first
  // session's task (and silently discarding the second project's input).
  // Feishu retries remain idempotent because the durable inbox pins the same
  // session id to every delivery of one message.
  const id = `task_${stableId(actor.ownerId, actor.sessionId, actor.messageId, canonical(input))}`;
  const previous = store.get<Task>("tasks", id);
  if (previous) return records.get(actor, id);
  // A task created before sessionId became part of the key may still receive
  // a retry after an upgrade. Reuse that legacy record only when its persisted
  // session matches; a different session must remain an independent intent.
  const legacyId = `task_${stableId(actor.ownerId, actor.messageId, canonical(input))}`;
  const legacy = store.get<Task>("tasks", legacyId);
  if (legacy?.sessionId === actor.sessionId) return records.get(actor, legacyId);
  if (input.newProject && !input.project) fail("project_name", "新建项目需要明确名称。");
  if (input.newProject && input.project) {
    await context.operations.run(`${id}:project`, { name: input.project }, () =>
      catalog.create(input.project as string, input.participants[0]?.kind),
    );
  }
  let directories: string[] = [];
  let project: string | undefined;
  if (input.project || input.kind !== "discussion") {
    const selected = catalog.get(input.project);
    directories = [...selected.directories];
    project = selected.name;
  }
  if (!directories.length) {
    const directory = join(config.stateDir, "discussions", id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    directories = [directory];
  }
  const timestamp = now();
  const participants: Participant[] = input.participants.map((spec, index) => ({
    id: `${id}:p${index + 1}`,
    taskId: id,
    name: spec.name || `${spec.kind}-${index + 1}`,
    kind: spec.kind,
    role: spec.role ?? "",
    status: "pending",
    started: false,
    initialSent: false,
    initialReceipt: `HERDR_RECEIPT_${newId("r").slice(2)}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const task: Task = {
    id,
    ownerId: actor.ownerId,
    sessionId: actor.sessionId,
    entryChatId: actor.chatId,
    project,
    kind: input.kind,
    title: input.title,
    requirements: input.requirements,
    directories,
    sourceDirectories: [...directories],
    directoryMode: input.directoryMode ?? "shared",
    bypass: catalog.snapshot().bypass,
    status: "queued",
    participantIds: participants.map((p) => p.id),
    groupDeleted: false,
    createGroup: input.createGroup ?? true,
    createRemoteTask: input.createRemoteTask ?? true,
    keepGroup: input.keepGroup ?? config.runtime.groupRetention === "retain",
    groupRetentionSource: input.keepGroup === undefined ? "default" : "explicit",
    worktreeReady: false,
    parentTaskId: input.parentTaskId,
    parentContext: parent
      ? {
          taskId: parent.id,
          title: parent.title,
          requirements: parent.requirements,
          result: parent.result,
          participants: records.participants(parent).map((entry) => ({
            name: entry.name,
            kind: entry.kind,
            lastOutput: entry.lastOutput ?? "",
          })),
        }
      : undefined,
    discussion: {
      mode:
        input.discussion?.mode ??
        (input.kind === "discussion" && participants.length > 1 ? "round_robin" : "manual"),
      maxRounds,
      maxMinutes,
      rounds: 0,
      nextParticipant: 0,
      paused: false,
      activeParticipant: participants[0]?.id,
    },
    result: "",
    closeRequested: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.transaction(() => {
    records.save(task);
    for (const participant of participants) records.saveParticipant(participant);
  });
  context.hooks.changed?.(task);
  return task;
}
