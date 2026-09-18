import { fail, OperationError } from "../core/errors.js";
import { stableId } from "../core/ids.js";
import type { AgentSnapshot, ExecutionRef, IncomingMessage } from "../core/types.js";
import type { ApplicationContext } from "./context.js";
import { presentScreen } from "./presentation.js";

interface Selection {
  ref: ExecutionRef;
  mirror: boolean;
  cursor?: string;
  lastSeq?: string;
}
export class LegacyBridge {
  constructor(private readonly context: ApplicationContext) {}

  async handle(message: IncomingMessage): Promise<void> {
    if (this.context.signal.aborted) fail("stopping", "服务正在停止。");
    const text = message.text.trim().replace(/^[／⁄∕]/, "/");
    const [rawCommand = "", ...args] = text.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const key = stableId(message.ownerId, message.chatId);
    this.context.store.set("legacy_chats", key, {
      ownerId: message.ownerId,
      chatId: message.chatId,
    });
    if (command === "/ls") {
      const agents = await this.context.herdr.list();
      const card = {
        schema: "2.0",
        body: {
          elements: agents.flatMap((agent) => [
            {
              tag: "markdown",
              content: `${agent.kind ?? "unknown"} · ${agent.paneId} · ${agent.status}\n${agent.cwd}`,
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "选择" },
              value: { action: "select", paneId: agent.paneId },
            },
          ]),
        },
      };
      await this.context.platform?.sendCard(
        message.chatId,
        card,
        stableId(message.messageId, "picker"),
      );
      return;
    }
    if (command === "/close") {
      this.context.store.delete("legacy_selection", key);
      this.context.store.set("legacy_selection_cleared", key, true);
      await this.reply(message, "已解除当前 agent 选择，执行会话继续运行。");
      return;
    }
    if (command === "/help") {
      await this.reply(
        message,
        "已有 agent 模式：/ls 选择；/card <pane> 查看现场；/stop <pane> 中断；/mirror <pane> on|off；/close 解除选择。任务模式请在配置中启用。",
      );
      return;
    }
    if (command.startsWith("/") && !["/card", "/stop", "/say", "/mirror"].includes(command)) {
      fail("unknown_command", "未知或已精简的命令，请发送 /help；没有向终端投递。");
    }
    let target = message.replyToMessageId ? await this.route(message.replyToMessageId) : undefined;
    if (!target && args[0] && command.startsWith("/")) target = await this.ref(args[0]);
    if (!target) target = (await this.selection(message.ownerId, message.chatId))?.ref;
    if (!target) {
      const agents = (await this.context.herdr.list()).filter((agent) => agent.kind);
      if (agents.length === 1 && agents[0]) target = this.fromSnapshot(agents[0]);
    }
    if (!target) {
      await this.reply(message, "请先发送 /ls 并选择要继续对话的 agent。");
      return;
    }
    if (command === "/card") {
      const screen = await this.context.herdr.screen(target);
      if (screen.agent.status === "blocked")
        await this.context.approvals.publish(message.ownerId, message.chatId, target, screen);
      else await this.reply(message, presentScreen(screen.text, this.context.config.ui), target);
      return;
    }
    if (command === "/stop") {
      await this.context.herdr.interrupt(target, this.context.signal);
      await this.reply(message, "已向选定 agent 发送中断。", target);
      return;
    }
    if (command === "/mirror") {
      if (args[1] !== "on" && args[1] !== "off")
        fail("command_args", "用法：/mirror <pane> on|off");
      this.context.store.set<Selection>("legacy_selection", key, {
        ref: target,
        mirror: args[1] === "on",
        cursor: (await this.context.herdr.transcript(target)).cursor,
      });
      await this.reply(
        message,
        args[1] === "on" ? "已开启输出镜像，从当前末尾开始。" : "已关闭输出镜像。",
        target,
      );
      return;
    }
    const body = command === "/say" ? args.slice(1).join(" ") : message.text;
    if (!body.trim()) fail("command_args", "消息不能为空。");
    const delivery = await this.context.herdr.send(target, body, { signal: this.context.signal });
    await this.reply(
      message,
      `${target.kind} · ${target.paneId}：${
        delivery.status === "delivered"
          ? "已确认送达"
          : delivery.status === "queued"
            ? "已进入 agent 队列"
            : "已尝试发送，尚未确认；请查看现场"
      }`,
      target,
    );
  }

  async select(ownerId: string, chatId: string, paneId: string): Promise<void> {
    const ref = await this.ref(paneId);
    const cursor = (await this.context.herdr.transcript(ref)).cursor;
    const key = stableId(ownerId, chatId);
    this.context.store.set("legacy_chats", key, { ownerId, chatId });
    this.context.store.set<Selection>("legacy_selection", key, {
      ref,
      cursor,
      mirror: this.context.config.mirrorDefaultOn,
    });
  }

  async tick(): Promise<void> {
    if (!this.context.platform || this.context.signal.aborted) return;
    const subscriptions: Array<{
      ownerId: string;
      chatId: string;
      key: string;
      selection: Selection;
    }> = [];
    for (const record of this.context.store.list<{ ownerId: string; chatId: string }>(
      "legacy_chats",
    )) {
      try {
        const selection = await this.selection(record.ownerId, record.chatId);
        if (selection)
          subscriptions.push({
            ...record,
            key: stableId(record.ownerId, record.chatId),
            selection,
          });
      } catch {
        this.context.logger.warn("旧桥目标暂不可读，请重新选择或检查现场。");
      }
    }
    const notifyChat = this.context.config.feishu.notifyChatId;
    const owner = this.context.config.feishu.allowedOpenIds[0];
    if (notifyChat && owner) {
      for (const agent of await this.context.herdr.list()) {
        if (
          !agent.kind ||
          subscriptions.some(
            (item) => item.chatId === notifyChat && item.selection.ref.paneId === agent.paneId,
          )
        )
          continue;
        const key = stableId(owner, notifyChat, agent.paneId);
        const selection = this.context.store.get<Selection>("legacy_monitors", key) ?? {
          ref: this.fromSnapshot(agent),
          mirror: this.context.config.mirrorDefaultOn,
          cursor: (await this.context.herdr.transcript(this.fromSnapshot(agent))).cursor,
        };
        subscriptions.push({ ownerId: owner, chatId: notifyChat, key, selection });
      }
    }
    for (const record of subscriptions) {
      if (this.context.signal.aborted) return;
      const { key, selection } = record;
      if (!selection || !this.context.config.feishu.allowedOpenIds.includes(record.ownerId))
        continue;
      try {
        const agent = await this.context.herdr.get(selection.ref.paneId);
        if (agent.kind !== selection.ref.kind) continue;
        selection.ref.sessionId = agent.sessionId;
        if (agent.status === "blocked" && agent.stateSeq !== selection.lastSeq) {
          if (this.context.signal.aborted) return;
          await this.context.approvals.publish(
            record.ownerId,
            record.chatId,
            selection.ref,
            await this.context.herdr.screen(selection.ref),
          );
          selection.lastSeq = agent.stateSeq;
        }
        if (selection.mirror) {
          const page = await this.context.herdr.transcript(selection.ref, selection.cursor);
          for (const entry of page.entries)
            if (entry.role === "assistant") {
              if (this.context.signal.aborted) return;
              const ids = await this.context.outbox.send(
                record.chatId,
                `${selection.ref.kind}：\n${entry.text}`,
                `legacy:${record.chatId}:${selection.ref.paneId}:${entry.id}`,
              );
              for (const id of ids) this.context.store.set("legacy_routes", id, selection.ref);
            }
          selection.cursor = page.cursor;
        }
        this.context.store.set(
          key === stableId(record.ownerId, record.chatId) ? "legacy_selection" : "legacy_monitors",
          key,
          selection,
        );
      } catch (error) {
        if (!(error instanceof OperationError))
          this.context.logger.warn("已有 agent 状态暂不可读。");
      }
    }
  }

  private async selection(ownerId: string, chatId: string): Promise<Selection | undefined> {
    const key = stableId(ownerId, chatId);
    const selected = this.context.store.get<Selection>("legacy_selection", key);
    if (selected || this.context.store.get("legacy_selection_cleared", key)) return selected;
    const legacy = this.context.store.get<{ t?: { pane: string; kind: string } }>(
      "legacy_selection",
      chatId,
    );
    if (!legacy?.t) return undefined;
    const ref = await this.ref(legacy.t.pane);
    if (ref.kind !== legacy.t.kind) fail("target_changed", "旧选择中的 agent 已变化，请重新选择。");
    const result = {
      ref,
      mirror: this.context.config.mirrorDefaultOn,
      cursor: (await this.context.herdr.transcript(ref)).cursor,
    };
    this.context.store.set("legacy_selection", key, result);
    return result;
  }

  private async route(messageId: string): Promise<ExecutionRef | undefined> {
    const route = this.context.store.get<ExecutionRef | { p: string }>("legacy_routes", messageId);
    if (!route) return undefined;
    if ("paneId" in route) return this.verifyRoute(route);
    let binding: { p?: string; k?: string };
    try {
      binding = JSON.parse(route.p);
    } catch {
      fail("route_unverified", "旧引用缺少 agent 身份，请通过 /ls 重新选择。");
    }
    if (!binding.p || !binding.k) fail("route_unverified", "旧引用缺少 agent 身份，请重新选择。");
    const ref = await this.ref(binding.p);
    if (ref.kind !== binding.k) fail("target_changed", "被引用的 agent 已变化，未投递。");
    return ref;
  }

  private async verifyRoute(route: ExecutionRef): Promise<ExecutionRef> {
    if (!route.paneId || !route.workspaceId || !route.kind || !route.cwd || !route.sessionId)
      fail("route_unverified", "旧引用缺少 agent 身份，请通过 /ls 重新选择。");
    const agent = await this.context.herdr.get(route.paneId);
    if (
      !agent.kind ||
      agent.paneId !== route.paneId ||
      agent.workspaceId !== route.workspaceId ||
      agent.kind !== route.kind ||
      agent.cwd !== route.cwd ||
      agent.sessionId !== route.sessionId
    )
      fail("target_changed", "被引用的 agent 已变化，未投递。");
    return this.fromSnapshot(agent);
  }

  private async ref(paneId: string): Promise<ExecutionRef> {
    return this.fromSnapshot(await this.context.herdr.get(paneId));
  }
  private fromSnapshot(agent: AgentSnapshot): ExecutionRef {
    if (!agent.kind) fail("agent_missing", "该 pane 没有可用的 Codex/Claude。");
    return {
      paneId: agent.paneId,
      workspaceId: agent.workspaceId,
      kind: agent.kind,
      cwd: agent.cwd,
      sessionId: agent.sessionId,
    };
  }
  private async reply(message: IncomingMessage, text: string, ref?: ExecutionRef): Promise<void> {
    const ids = await this.context.outbox.send(
      message.chatId,
      text,
      `${message.messageId}:legacy-reply`,
      message.messageId,
    );
    if (ref) for (const id of ids) this.context.store.set("legacy_routes", id, ref);
  }
}
