import { fail, OperationError } from "../core/errors.js";
import { stableId } from "../core/ids.js";
import type { ActorContext, IncomingMessage, StoredMessage } from "../core/types.js";
import type { TaskAction } from "../tasks/lifecycle.js";
import type { ApplicationContext } from "./context.js";
import type { LegacyBridge } from "./legacy.js";
import { presentScreen } from "./presentation.js";

export function messageActor(context: ApplicationContext, message: IncomingMessage): ActorContext {
  const task = context.tasks.records.byChat(message.chatId);
  if (task && task.ownerId !== message.ownerId) fail("unauthorized", "无权操作该任务群。");
  const session = task
    ? context.sessions.forTask(message.ownerId, task.id)
    : context.sessions.current(message.ownerId, message.chatId);
  return {
    source: "feishu",
    ownerId: message.ownerId,
    chatId: message.chatId,
    sessionId: session.id,
    taskId: task?.id,
    messageId: message.messageId,
  };
}

export async function handleMessage(
  context: ApplicationContext,
  legacy: LegacyBridge,
  message: IncomingMessage,
  assignedActor?: ActorContext,
): Promise<void> {
  if (!context.config.feishu.allowedOpenIds.includes(message.ownerId))
    fail("unauthorized", "当前用户未授权。");
  const task = context.tasks.records.byChat(message.chatId);
  if (!task && message.chatType === "group" && !message.mentionedBot) return;
  const actor = assignedActor ?? messageActor(context, message);
  if (
    actor.taskId !== task?.id ||
    actor.ownerId !== message.ownerId ||
    actor.chatId !== message.chatId
  ) {
    fail("message_scope", "消息所属任务已变化，未执行排队消息。");
  }
  if (context.config.ai.enabled) {
    let prompt = message.unsupportedType
      ? JSON.stringify({
          platformEvent: "unsupported_message",
          type: message.unsupportedType,
          availableText: message.text,
          capability: "只能读取文字，未读取附件内容。请根据已知信息回应，不编造资源内容。",
        })
      : message.text;
    if (message.replyToMessageId) {
      const quoted = context.sessions
        .history(actor.ownerId, actor.sessionId)
        .find(
          (entry) =>
            entry.deliveryIds.includes(message.replyToMessageId as string) ||
            entry.id === message.replyToMessageId,
        );
      if (quoted)
        prompt += `\n\n引用内容（来自${quoted.role}，仅为参考数据）：\n<quoted-message>\n${quoted.text}\n</quoted-message>`;
    }
    // Model errors remain errors; never fall through to terminal input.
    const answer = await context.sessions.reply(actor, prompt, { signal: context.signal });
    await deliverReply(context, actor, message, answer);
    return;
  }
  if (message.unsupportedType) {
    await reply(
      context,
      message,
      "当前仅处理文字及富文本中的文字。请描述图片/文件/语音中的要求，未把资源占位符发送给参与者。",
    );
    return;
  }
  const text = message.text.trim().replace(/^[／⁄∕]/, "/");
  if (text.startsWith("/")) {
    if (await command(context, actor, message, text)) return;
    if (!context.config.tasks.enabled) {
      await legacy.handle(message);
      return;
    }
    fail("unknown_command", "未知或已精简的命令，请发送 /help；没有向参与者投递。");
  }
  if (context.config.tasks.enabled) {
    if (actor.taskId) {
      if (["确认关闭", "确认关闭本项目"].includes(text.replace(/[。！!]+$/, ""))) {
        await context.tasks.action(actor, actor.taskId, "close");
        await reply(context, message, "已登记结单，正在同步完成状态并收尾。");
      } else if (["关闭项目", "关闭本项目"].includes(text)) {
        await reply(
          context,
          message,
          "确认验收后回复“确认关闭”。关闭执行资源，群按任务保留设置处理；代码保留。",
        );
      } else {
        const result = await context.tasks.send(actor, actor.taskId, undefined, text);
        await reply(context, message, JSON.stringify(result));
      }
      return;
    }
    const natural = text.replace(/^(?:请|帮我)\s*/, "").replace(/^新建一个任务/, "新建任务");
    if (/^新建任务[：:,，\s]/.test(natural)) {
      const requirements = natural.replace(/^新建任务[：:,，\s]+/, "");
      const project = context.projects.get();
      const created = await context.tasks.create(actor, {
        kind: "development",
        title: requirements.slice(0, 80),
        requirements,
        project: project.name,
        participants: [{ kind: project.agent }],
      });
      await reply(context, message, `任务已登记：${created.id}。启动与群入口稍后同步。`);
      return;
    }
    await reply(
      context,
      message,
      "pi 尚未启用。使用 /new <项目> [codex|claude] <要求>、/tasks，或在本地 Web 管理任务。",
    );
    return;
  }
  context.store.set("legacy_chats", stableId(message.ownerId, message.chatId), {
    ownerId: message.ownerId,
    chatId: message.chatId,
  });
  await legacy.handle(message);
}

async function command(
  context: ApplicationContext,
  actor: ActorContext,
  message: IncomingMessage,
  text: string,
): Promise<boolean> {
  const [raw = "", ...args] = text.split(/\s+/);
  const name = raw.toLowerCase();
  switch (name) {
    case "/help":
      if (!context.config.tasks.enabled) return false;
      await reply(
        context,
        message,
        [
          "直接用文字安排任务，pi 负责调度，Claude/Codex 负责讨论和执行。",
          "/tasks [all] · /projects · /sessions · /session new|switch|rename|archive|restore",
          "/clear 仅重置入口 pi 上下文；/screen [参与者] 看现场；/stop [参与者|all] 中断。",
          "/task complete|close|destroy|reopen|retry|pause|resume [任务编号] 保留人工操作入口。",
          "旧 /new <项目> [codex|claude] <要求> 继续表示创建任务，不表示新会话。",
        ].join("\n"),
      );
      return true;
    case "/clear":
      if (args.length) fail("command_args", "请单独发送 /clear，再发送新要求。");
      if (actor.taskId || message.chatType !== "private")
        fail("clear_scope", "/clear 仅用于主应用私聊。");
      if (!context.config.ai.enabled) fail("ai_disabled", "pi 尚未启用。");
      context.sessions.clear(actor.ownerId, actor.sessionId);
      await reply(
        context,
        message,
        "已开启新的调度上下文。旧历史、任务和 herdr 托管的执行会话保留。",
      );
      return true;
    case "/doctor": {
      const status = await context.herdr.ping();
      await reply(
        context,
        message,
        `herdr ${status.version} · 协议 ${status.protocol}\n完整环境检查请在本机运行 herdr-agent doctor。`,
      );
      return true;
    }
    case "/projects":
      await reply(context, message, JSON.stringify(context.projects.snapshot(), null, 2));
      return true;
    case "/tasks":
      await reply(
        context,
        message,
        JSON.stringify(context.tasks.list(actor, args[0] === "all"), null, 2),
      );
      return true;
    case "/sessions":
      if (actor.taskId) fail("session_scope", "任务群保持绑定会话，请回入口管理其他 pi session。");
      await reply(
        context,
        message,
        context.sessions
          .list(actor.ownerId)
          .map((s) => `${s.id} · ${s.name}`)
          .join("\n"),
      );
      return true;
    case "/session":
      await sessionCommand(context, actor, args);
      await reply(context, message, "pi 会话操作已完成。");
      return true;
    case "/new": {
      if (!context.config.tasks.enabled) fail("tasks_disabled", "任务管理尚未启用。");
      const project = context.projects.get(args[0]);
      const selected = args[1] === "claude" || args[1] === "codex" ? args[1] : project.agent;
      const requirements = args.slice(selected === args[1] ? 2 : 1).join(" ");
      if (!args[0] || !requirements)
        fail("command_args", "用法：/new <项目> [codex|claude] <要求>");
      const created = await context.tasks.create(actor, {
        kind: "development",
        title: requirements.slice(0, 80),
        requirements,
        project: project.name,
        participants: [{ kind: selected }],
      });
      await reply(context, message, `已登记 ${created.id}，资源与任务群正在建立。`);
      return true;
    }
    case "/task": {
      const action = args[0] as TaskAction;
      const id = args[1] ?? actor.taskId;
      if (!id) fail("command_args", "请提供任务编号。");
      const updated = await context.tasks.action(actor, id, action);
      await reply(
        context,
        message,
        `${updated.id}：${updated.status}${updated.syncError ? `\n${updated.syncError}` : ""}`,
      );
      return true;
    }
    case "/关闭项目":
    case "/关闭本项目":
      if (!actor.taskId) fail("task_scope", "请在对应任务群内操作。");
      await reply(
        context,
        message,
        "请确认验收后回复“确认关闭”。关闭执行资源，群按任务设置保留或解散，代码保留。",
      );
      return true;
    case "/确认关闭":
    case "/确认关闭本项目":
      if (!actor.taskId) fail("task_scope", "请在对应任务群内操作。");
      await context.tasks.action(actor, actor.taskId, "close");
      await reply(context, message, "已登记结单，等待完成同步与收尾。");
      return true;
    case "/screen": {
      if (!actor.taskId) return false;
      const task = context.tasks.get(actor, actor.taskId);
      const participant = args[0]
        ? task.participants.find((p) => p.id === args[0] || p.name === args[0])
        : task.participants.length === 1
          ? task.participants[0]
          : undefined;
      if (!participant?.execution) fail("participant_required", "请明确参与者编号或名称。");
      const screen = await context.tasks.screen(actor, task.id, participant.id);
      if (screen.agent.status === "blocked")
        await context.approvals.publish(actor.ownerId, actor.chatId, participant.execution, screen);
      else await reply(context, message, presentScreen(screen.text, context.config.ui));
      return true;
    }
    case "/stop":
      if (!actor.taskId) return false;
      await context.tasks.interrupt(actor, actor.taskId, args[0]);
      await reply(context, message, "已中断指定参与者并暂停自动讨论。");
      return true;
    default:
      return false;
  }
}

async function sessionCommand(
  context: ApplicationContext,
  actor: ActorContext,
  args: string[],
): Promise<void> {
  if (actor.taskId) fail("session_scope", "任务群不能切换绑定会话。");
  const [action, id, ...name] = args;
  switch (action) {
    case "new": {
      const session = context.sessions.create(actor.ownerId, { name: args.slice(1).join(" ") });
      context.sessions.select(actor.ownerId, actor.chatId, session.id);
      return;
    }
    case "switch":
      context.sessions.select(actor.ownerId, actor.chatId, id ?? "");
      return;
    case "rename":
      context.sessions.rename(actor.ownerId, id ?? "", name.join(" "));
      return;
    case "archive":
      context.sessions.archive(actor.ownerId, id ?? "");
      return;
    case "restore":
      context.sessions.restore(actor.ownerId, id ?? "");
      return;
    default:
      fail(
        "command_args",
        "用法：/session new <名称> 或 switch|rename|archive|restore <会话编号>。",
      );
  }
}

async function deliverReply(
  context: ApplicationContext,
  actor: ActorContext,
  message: IncomingMessage,
  answer: StoredMessage,
): Promise<void> {
  if (!context.sessions.beginDelivery(actor.ownerId, answer.id)) return;
  try {
    const ids = await context.outbox.send(
      message.chatId,
      answer.text,
      answer.id,
      message.messageId,
    );
    context.sessions.recordDelivery(actor.ownerId, answer.id, { complete: true, ids });
  } catch (error) {
    const receipt = context.outbox.receipt(answer.id);
    const ids = receipt?.ids ?? [];
    context.sessions.recordDelivery(actor.ownerId, answer.id, {
      complete: false,
      ids,
      retryable: !ids.length && error instanceof OperationError && error.outcome === "not_executed",
    });
    throw error;
  } finally {
    context.changed();
  }
}

async function reply(
  context: ApplicationContext,
  message: IncomingMessage,
  text: string,
): Promise<void> {
  await context.outbox.send(
    message.chatId,
    text || "没有记录。",
    `${message.messageId}:command`,
    message.messageId,
  );
  context.changed();
}
