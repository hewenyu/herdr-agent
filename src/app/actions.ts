import { saveConfigSection } from "../config/save.js";
import { modelProvider, validateConfig } from "../config/validate.js";
import { fail } from "../core/errors.js";
import { newId } from "../core/ids.js";
import type { ActorContext, Session, StoredMessage } from "../core/types.js";
import type { TaskAction } from "../tasks/lifecycle.js";
import type { ApplicationContext } from "./context.js";
import { presentScreen } from "./presentation.js";
import { agentKind, boolean, optionalString, string, strings, taskInput } from "./validation.js";

function localOwner(context: ApplicationContext): string | undefined {
  const selected = context.store.get<unknown>("web_identity", "selected");
  if (typeof selected === "string" && context.config.feishu.allowedOpenIds.includes(selected))
    return selected;
  if (selected !== undefined) context.store.delete("web_identity", "selected");
  return context.config.feishu.allowedOpenIds[0];
}

function localSession(context: ApplicationContext, ownerId: string): Session {
  const selected = context.store.get<string>("web_selection", ownerId);
  if (selected) {
    const session = context.store.get<Session>("sessions", selected);
    if (session?.ownerId === ownerId && !session.archived) return session;
    context.store.delete("web_selection", ownerId);
  }
  return context.sessions.current(ownerId, `web:${ownerId}`);
}

export function localActor(
  context: ApplicationContext,
  input: Record<string, unknown> = {},
): ActorContext {
  const ownerId = localOwner(context);
  if (!ownerId) fail("setup_required", "请先通过 setup 设置允许用户，再管理会话和任务。");
  const expectedOwnerId = optionalString(input, "expectedOwnerId");
  if (expectedOwnerId && expectedOwnerId !== ownerId)
    fail("web_identity_changed", "本机管理身份已切换，请刷新后重新操作。");
  if ("ownerId" in input) fail("web_identity_input", "请通过本机管理身份选择控件切换用户。");
  const taskId = optionalString(input, "taskId");
  if (taskId) {
    const task = context.tasks.records.get({ ownerId, chatId: `web:${ownerId}` }, taskId);
    const session = context.sessions.forTask(ownerId, taskId);
    return {
      source: "web",
      ownerId,
      taskId,
      sessionId: session.id,
      chatId: task.chatId ?? `web:${ownerId}`,
      messageId: optionalString(input, "requestId") ?? newId("web"),
    };
  }
  const explicitSession = optionalString(input, "sessionId");
  const session = explicitSession
    ? context.sessions.get(ownerId, explicitSession)
    : localSession(context, ownerId);
  if (session.taskId) {
    const task = context.tasks.records.get({ ownerId, chatId: `web:${ownerId}` }, session.taskId);
    return {
      source: "web",
      ownerId,
      taskId: task.id,
      sessionId: session.id,
      chatId: task.chatId ?? `web:${ownerId}`,
      messageId: optionalString(input, "requestId") ?? newId("web"),
    };
  }
  return {
    source: "web",
    ownerId,
    chatId: `web:${ownerId}`,
    sessionId: session.id,
    messageId: optionalString(input, "requestId") ?? newId("web"),
  };
}

export function snapshot(context: ApplicationContext): Record<string, unknown> {
  const ownerId = localOwner(context);
  const catalog = context.projects.snapshot();
  let session: Session | undefined;
  if (ownerId) session = localSession(context, ownerId);
  const tasks = ownerId ? context.tasks.records.list(ownerId, true) : [];
  return {
    activeOwnerId: ownerId,
    identities: [...new Set(context.config.feishu.allowedOpenIds)].map((id) => ({
      id,
      sessionCount: context.sessions.list(id, { archived: true }).length,
    })),
    projects: catalog.projects,
    catalog,
    sessions: ownerId
      ? context.sessions.list(ownerId, { archived: true }).map((item) => ({
          ...item,
          name:
            item.taskId && item.name === `任务 ${item.taskId}`
              ? (tasks.find((task) => task.id === item.taskId)?.title ?? item.name)
              : item.name,
        }))
      : [],
    activeSessionId: session?.id,
    messages: ownerId && session ? context.sessions.history(ownerId, session.id) : [],
    tasks,
    participants: tasks.flatMap((task) => context.tasks.records.participants(task)),
    authorization: context.authorization,
    runtime: context.runtime,
    model: { ...context.config.ai, apiKey: undefined, keyConfigured: !!context.config.ai.apiKey },
  };
}

export async function dispatch(
  context: ApplicationContext,
  action: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (action === "identity.select") {
    const ownerId = string(input, "ownerId");
    if (!context.config.feishu.allowedOpenIds.includes(ownerId))
      fail("unauthorized", "只能选择配置允许名单中的本机管理身份。");
    context.store.set("web_identity", "selected", ownerId);
    context.changed();
    return { ownerId };
  }
  if (action.startsWith("project.") || action === "catalog.bypass") {
    return projectAction(context, action, input);
  }
  if (action === "config.ai") return modelConfig(context, input);
  const actor = localActor(context, input);
  const id = optionalString(input, "id") ?? actor.taskId ?? "";
  let result: unknown;
  switch (action) {
    case "session.create": {
      const session = context.sessions.create(actor.ownerId, {
        name: optionalString(input, "name"),
      });
      context.store.set("web_selection", actor.ownerId, session.id);
      result = session;
      break;
    }
    case "session.select": {
      const selected = context.sessions.get(actor.ownerId, string(input, "id"));
      if (selected.archived) fail("session_archived", "请先恢复归档会话。");
      context.store.set("web_selection", actor.ownerId, selected.id);
      result = selected;
      break;
    }
    case "session.rename":
      result = context.sessions.rename(actor.ownerId, string(input, "id"), string(input, "name"));
      break;
    case "session.archive":
      result = context.sessions.archive(actor.ownerId, string(input, "id"));
      break;
    case "session.restore": {
      const restored = context.sessions.restore(actor.ownerId, string(input, "id"));
      context.store.set("web_selection", actor.ownerId, restored.id);
      result = restored;
      break;
    }
    case "session.clear": {
      const session = context.sessions.get(actor.ownerId, string(input, "id"));
      if (session.taskId) fail("task_session", "任务会话保留历史，不支持清空。");
      result = context.sessions.clear(actor.ownerId, session.id);
      break;
    }
    case "session.history":
      result = context.sessions.history(actor.ownerId, string(input, "id"));
      break;
    case "chat.send": {
      if (!context.config.ai.enabled) fail("ai_disabled", "pi 尚未启用，请先配置模型并重启。");
      const reply = await context.sessions.reply(actor, string(input, "text"), {
        signal: context.signal,
      });
      context.sessions.beginDelivery(actor.ownerId, reply.id);
      result = reply;
      break;
    }
    case "chat.ack": {
      const messageId = string(input, "messageId");
      const message = context.store.get<StoredMessage>("messages", messageId);
      if (!message || message.sessionId !== actor.sessionId || message.role === "user") {
        fail("receipt_scope", "回执不属于当前会话的输出。");
      }
      if (message.delivery === "delivered") return { acknowledged: true };
      context.sessions.beginDelivery(actor.ownerId, messageId);
      context.sessions.recordDelivery(actor.ownerId, messageId, {
        complete: true,
        ids: [messageId],
      });
      result = { acknowledged: true };
      break;
    }
    case "task.create":
      result = await context.tasks.create(actor, taskInput(input));
      break;
    case "task.get": {
      const target = context.tasks.get(actor, id || string(input, "taskId"));
      await context.tasks.reconcile(target.id);
      result = context.tasks.get(actor, target.id);
      break;
    }
    case "task.action":
      result = await context.tasks.action(
        actor,
        id || string(input, "taskId"),
        string(input, "action") as TaskAction,
        {
          ...(input.keepGroup === undefined ? {} : { keepGroup: boolean(input, "keepGroup") }),
          ...(input.keepExecution === undefined
            ? {}
            : { keepExecution: boolean(input, "keepExecution") }),
        },
      );
      break;
    case "participant.send":
      result = await context.tasks.send(
        actor,
        id || string(input, "taskId"),
        optionalString(input, "participantId"),
        string(input, "text"),
      );
      break;
    case "participant.interrupt":
      result = await context.tasks.interrupt(
        actor,
        id || string(input, "taskId"),
        optionalString(input, "participantId"),
      );
      break;
    case "participant.add":
      result = await context.tasks.addParticipant(actor, id || string(input, "taskId"), {
        kind: agentKind(input.kind),
        name: optionalString(input, "name"),
        role: optionalString(input, "role"),
      });
      break;
    case "participant.remove":
      result = await context.tasks.removeParticipant(
        actor,
        id || string(input, "taskId"),
        string(input, "participantId"),
      );
      break;
    case "participant.screen": {
      const task = context.tasks.get(actor, id || string(input, "taskId"));
      const selected = optionalString(input, "participantId");
      const participant = selected
        ? task.participants.find((p) => p.id === selected || p.name === selected)
        : task.participants.length === 1
          ? task.participants[0]
          : undefined;
      if (!participant?.execution) fail("participant_required", "请选择已启动的参与者。");
      const screen = await context.tasks.screen(actor, task.id, participant.id);
      result = {
        screen: {
          ...screen,
          text: presentScreen(screen.text, context.config.ui),
          question: screen.question
            ? presentScreen(screen.question, context.config.ui)
            : screen.question,
        },
        approval:
          screen.agent.status === "blocked"
            ? context.approvals.create(actor.ownerId, actor.chatId, participant.execution, screen)
            : undefined,
      };
      break;
    }
    case "participant.answer":
      result = await context.approvals.answer(
        actor.ownerId,
        actor.chatId,
        string(input, "nonce"),
        string(input, "key"),
      );
      break;
    default:
      fail("unknown_action", "未知操作，未执行。");
  }
  context.changed();
  return result ?? { ok: true };
}

async function projectAction(
  context: ApplicationContext,
  action: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  let result: unknown;
  switch (action) {
    case "project.save":
      result = await context.projects.save(
        {
          name: string(input, "name"),
          agent: agentKind(input.agent),
          directories: strings(input.directories),
        },
        boolean(input, "makeDefault"),
      );
      break;
    case "project.create":
      result = await context.projects.create(
        string(input, "name"),
        agentKind(input.agent ?? "codex"),
      );
      break;
    case "project.delete":
      result = context.projects.remove(string(input, "name"));
      break;
    case "project.default":
      result = context.projects.settings({ defaultProject: string(input, "name") });
      break;
    case "catalog.bypass":
      result = context.projects.settings({ bypass: boolean(input, "bypass") });
      break;
    default:
      fail("unknown_action", "未知项目操作。");
  }
  context.changed();
  return result ?? { ok: true };
}

async function modelConfig(
  context: ApplicationContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const previous = context.config.ai;
  const ai = {
    ...previous,
    enabled: boolean(input, "enabled", previous.enabled),
    provider: modelProvider(string(input, "provider", previous.provider)),
    model: string(input, "model", previous.model),
    baseUrl: string(input, "baseUrl", previous.baseUrl),
    apiKey: optionalString(input, "apiKey") ?? previous.apiKey,
  };
  validateConfig({ ...context.config, ai, tasks: { ...context.config.tasks, enabled: true } });
  await saveConfigSection(context.config.stateDir, "ai", {
    enabled: ai.enabled,
    provider: ai.provider,
    model: ai.model,
    base_url: ai.baseUrl,
    api_key: ai.apiKey,
  });
  await saveConfigSection(context.config.stateDir, "tasks", { enabled: true });
  context.changed();
  return { saved: true, restartRequired: true, message: "模型配置已保存，重启服务后生效。" };
}
