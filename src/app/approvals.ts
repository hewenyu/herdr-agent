import { fail, isNotExecuted, OperationError } from "../core/errors.js";
import { newId, now, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { HerdrPort, PlatformPort } from "../core/ports.js";
import type { AgentScreen, ExecutionRef } from "../core/types.js";
import type { Store } from "../storage/store.js";
import { defaultPresentation, presentScreen, type ScreenPresentation } from "./presentation.js";

interface Approval {
  nonce: string;
  ownerId: string;
  chatId: string;
  ref: ExecutionRef;
  stateSeq: string;
  sessionId?: string;
  expiresAt: string;
  keys: string[];
  consumed: boolean;
  messageId?: string;
  publication?: "sending" | "uncertain" | "retryable" | "sent";
}

export class Approvals {
  private readonly locks = new KeyedMutex();
  constructor(
    private readonly store: Store,
    private readonly herdr: HerdrPort,
    private readonly platform: () => PlatformPort | undefined,
    private readonly presentation: ScreenPresentation = defaultPresentation,
  ) {}

  create(ownerId: string, chatId: string, ref: ExecutionRef, screen: AgentScreen): Approval {
    if (
      screen.agent.status !== "blocked" ||
      screen.agent.paneId !== ref.paneId ||
      screen.agent.kind !== ref.kind ||
      screen.agent.workspaceId !== ref.workspaceId
    ) {
      fail("approval_target", "当前现场不属于等待审批的参与者。");
    }
    const identity = stableId(
      ownerId,
      chatId,
      ref.workspaceId,
      ref.paneId,
      ref.kind,
      screen.agent.stateSeq,
      screen.agent.sessionId ?? "",
    );
    const nonce = this.store.get<string>("approval_identity", identity);
    const previous = nonce ? this.store.get<Approval>("approvals", nonce) : undefined;
    if (previous && Date.parse(previous.expiresAt) > Date.now()) return previous;
    const approval: Approval = {
      nonce: newId("approval"),
      ownerId,
      chatId,
      ref,
      stateSeq: screen.agent.stateSeq,
      sessionId: screen.agent.sessionId,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      keys: [...new Set([...screen.options.map((option) => option.key), "esc"])],
      consumed: false,
    };
    this.store.set("approvals", approval.nonce, approval);
    this.store.set("approval_identity", identity, approval.nonce);
    return approval;
  }

  async publish(
    ownerId: string,
    chatId: string,
    ref: ExecutionRef,
    screen: AgentScreen,
  ): Promise<Approval> {
    const approval = this.create(ownerId, chatId, ref, screen);
    return this.locks.run(approval.nonce, async () => {
      const latest = this.store.get<Approval>("approvals", approval.nonce) as Approval;
      if (latest.messageId || latest.consumed) return latest;
      if (latest.publication === "sending" || latest.publication === "uncertain") {
        throw new OperationError(
          "card_uncertain",
          "审批卡片发送结果未知；可从 Web 查看现场。",
          "unknown",
        );
      }
      const platform = this.platform();
      if (!platform) fail("platform_unavailable", "飞书未连接。");
      this.store.set("approvals", latest.nonce, { ...latest, publication: "sending" });
      try {
        const messageId = await platform.sendCard(chatId, this.card(latest, screen), latest.nonce);
        if (!messageId) throw new OperationError("card_uncertain", "缺少卡片发送回执。", "unknown");
        // A callback can arrive before sendCard resolves. Never restore a consumed nonce.
        const current = this.store.get<Approval>("approvals", latest.nonce) as Approval;
        const published: Approval = { ...current, messageId, publication: "sent" };
        this.store.set("approvals", latest.nonce, published);
        if (published.consumed) await this.disableCard(published);
        return published;
      } catch (error) {
        const current = this.store.get<Approval>("approvals", latest.nonce) as Approval;
        this.store.set("approvals", latest.nonce, {
          ...current,
          publication: isNotExecuted(error) ? "retryable" : "uncertain",
        });
        throw error;
      }
    });
  }

  async answer(ownerId: string, chatId: string, nonce: string, key: string): Promise<void> {
    const approval = this.store.get<Approval>("approvals", nonce);
    if (!approval || approval.ownerId !== ownerId || approval.chatId !== chatId)
      fail("approval_scope", "审批不属于当前会话。");
    if (approval.consumed || Date.parse(approval.expiresAt) < Date.now())
      fail("approval_expired", "审批已处理或已过期，请刷新现场。");
    if (!approval.keys.includes(key)) fail("approval_key", "该审批没有此选项。");
    approval.consumed = true;
    this.store.set("approvals", nonce, approval);
    let failure: unknown;
    try {
      await this.herdr.answer(approval.ref, key, approval);
    } catch (error) {
      failure = error;
    } finally {
      await this.disableCard(approval, !!failure);
    }
    if (failure)
      throw failure instanceof OperationError
        ? failure
        : new OperationError("approval_unknown", "审批写入结果未知，请查看现场。", "unknown");
  }

  private async disableCard(approval: Approval, failed = false): Promise<void> {
    if (approval.messageId)
      await this.platform()
        ?.updateCard(approval.messageId, {
          schema: "2.0",
          body: {
            elements: [
              {
                tag: "markdown",
                content: failed
                  ? "审批已消费，结果尚未确认；请查看现场，不要重复点击。"
                  : `已处理 · ${now()}`,
              },
            ],
          },
        })
        .catch(() => {});
  }

  private card(approval: Approval, screen: AgentScreen): Record<string, unknown> {
    return {
      schema: "2.0",
      header: { title: { tag: "plain_text", content: `${approval.ref.kind} 等待你处理` } },
      body: {
        elements: [
          {
            tag: "markdown",
            content: presentScreen(screen.question || screen.text, this.presentation),
          },
          ...[...screen.options, { key: "esc", label: "取消 / Esc" }].map((option) => ({
            tag: "button",
            text: { tag: "plain_text", content: option.label },
            type: "default",
            value: { action: "approval", nonce: approval.nonce, key: option.key },
          })),
        ],
      },
    };
  }
}
