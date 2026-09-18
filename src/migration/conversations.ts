import type { Session, StoredMessage, Task } from "../core/types.js";
import {
  booleans,
  type Fields,
  fields,
  generation,
  hash,
  type ImportPlan,
  invalid,
  list,
  type SourceFile,
  sessionId,
  strings,
  text,
  timestamp,
  version,
} from "./common.js";

function receiptValid(value: Fields): void {
  booleans(value, ["finished", "failed", "context_reset"]);
  generation(value.generation);
  const delivery = text(value.delivery);
  if (!["", "prepared", "sending", "delivered", "uncertain", "retryable"].includes(delivery))
    invalid("旧会话投递状态无效");
  if (
    (value.finished && !value.failed && !text(value.reply).trim()) ||
    (!value.finished && (value.reply || value.failed))
  )
    invalid("旧会话回执不完整");
  if (delivery && (!value.finished || value.failed)) invalid("旧会话投递与执行状态冲突");
  if (
    delivery === "delivered" &&
    (!strings(value.delivery_ids).length || strings(value.delivery_ids).includes(""))
  )
    invalid("旧会话缺少投递确认");
  if (
    ["", "prepared", "sending", "retryable"].includes(delivery) &&
    strings(value.delivery_ids).length
  )
    invalid("旧会话投递确认与状态冲突");
}

/** Archives get separate, archived sessions and are never injected into active context. */
export function importConversation(file: SourceFile, plan: ImportPlan): void {
  const data = fields(file.data);
  const archive = file.name.includes("/archive/");
  const compacted = archive && data.version === undefined;
  if (!compacted) version(data);
  const scope = compacted ? fields(data.scope) : data;
  const ownerId = text(compacted ? scope.owner_id : scope.owner);
  const chatId = text(compacted ? scope.chat_id : scope.chat);
  const taskId = text(scope.task_id);
  if (!ownerId || !chatId) invalid("旧对话缺少可信作用域");
  const task = taskId ? plan.get<Task>("tasks", taskId) : undefined;
  if (task && (task.ownerId !== ownerId || (task.chatId && task.chatId !== chatId)))
    invalid("旧对话与任务群身份不一致");
  const id = sessionId(ownerId, chatId, taskId, archive ? file.name : "");
  if (plan.get("legacy_conversation_sources", id)) invalid("旧对话作用域重复，不能覆盖导入");
  plan.add("legacy_conversation_sources", id, file.name);
  const gen = generation(data.generation);
  const receipts = compacted ? {} : fields(data.receipts);
  const messages = list(data.messages);
  for (const [key, raw] of Object.entries(receipts)) {
    if (!key) invalid("旧对话回执缺少消息标识");
    const receipt = fields(raw);
    receiptValid(receipt);
    plan.add("legacy_message_receipts", hash(ownerId, chatId, key), {
      ownerId,
      chatId,
      messageId: key,
      receipt,
    });
  }
  if (
    data.pending &&
    (!receipts[text(data.pending)] || fields(receipts[text(data.pending)]).finished)
  )
    invalid("旧对话 pending 回执不匹配");
  const memoryValue = compacted ? data.previous_memory : data.memory;
  const memory = memoryValue ? fields(memoryValue) : {};
  const summary = text(memory.summary);
  const existing = plan.get<Session>("sessions", id);
  const session: Session = {
    id,
    ownerId,
    name: archive ? "旧版对话归档" : taskId ? `旧任务：${task?.title ?? taskId}` : "旧版主会话",
    taskId: taskId || undefined,
    generation: gen,
    archived: archive || task?.status === "destroyed",
    summary,
    createdAt: existing?.createdAt ?? file.modifiedAt,
    updatedAt: file.modifiedAt,
  };
  plan.add("sessions", id, session);
  plan.add("memory", id, {
    summary,
    revision: text(memory.revision) || (summary ? hash(summary) : ""),
  });
  // Checkpoint summary covers compacted archives, not the retained messages imported here.
  plan.add("summary_cursor", id, { generation: gen, sequence: 0 });
  const clearedAt = timestamp(data.cleared_at, "");
  if (clearedAt) plan.add("session_clear", id, { at: clearedAt, generation: gen });
  if (!archive && !taskId) plan.add("session_selection", hash(ownerId, chatId), id);
  if (!archive && task) {
    task.sessionId = id;
    plan.add("tasks", task.id, task);
  }
  let sequence = 0;
  for (const raw of messages) {
    const old = fields(raw);
    if (old.role !== "user" && old.role !== "assistant")
      invalid("旧对话含未知角色，未作为指令导入");
    if (typeof old.content !== "string") invalid("旧对话正文格式无效");
    const turnId = text(old.turn_id);
    const receipt = turnId && receipts[turnId] ? fields(receipts[turnId]) : undefined;
    const uncertain =
      old.role === "assistant" &&
      (["failure", "receipt", "delivery_pending"].includes(text(old.kind)) ||
        (receipt && (receipt.failed || (receipt.delivery && receipt.delivery !== "delivered"))));
    sequence++;
    const row: StoredMessage & { sequence: number } = {
      id: `legacy_m_${hash(file.name, String(sequence)).slice(0, 32)}`,
      sessionId: id,
      taskId: taskId || undefined,
      role: old.role,
      source: archive ? "legacy_archive" : "legacy",
      text: old.content,
      createdAt: file.modifiedAt,
      delivery: uncertain ? "uncertain" : "delivered",
      deliveryIds: old.role === "user" ? (turnId ? [turnId] : []) : strings(receipt?.delivery_ids),
      generation: gen,
      sequence,
    };
    plan.add("messages", row.id, row);
    if (turnId && old.role === "user")
      plan.add("legacy_message_receipts", hash(ownerId, chatId, turnId), {
        ownerId,
        chatId,
        messageId: turnId,
        receipt: receipt ?? { finished: false },
      });
  }
  plan.add("message_sequence", id, sequence);
}

export function importMemory(file: SourceFile, plan: ImportPlan): void {
  const data = fields(file.data);
  version(data);
  const scope = fields(data.scope);
  const entry = fields(data.entry);
  const ownerId = text(scope.owner_id);
  const chatId = text(scope.chat_id);
  const taskId = text(scope.task_id);
  if (!ownerId || !chatId || typeof entry.summary !== "string") invalid("旧摘要作用域无效");
  const activeId = sessionId(ownerId, chatId, taskId);
  // The conversation checkpoint is authoritative, especially after /clear.
  if (plan.get("sessions", activeId)) return;
  const id = sessionId(ownerId, chatId, taskId, file.name);
  const session: Session = {
    id,
    ownerId,
    taskId: taskId || undefined,
    name: "旧版摘要归档",
    archived: true,
    generation: 0,
    summary: entry.summary,
    createdAt: file.modifiedAt,
    updatedAt: file.modifiedAt,
  };
  plan.add("sessions", id, session);
  plan.add("memory", id, { summary: entry.summary, revision: text(entry.revision) });
}
