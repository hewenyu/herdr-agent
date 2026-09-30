import { fail, isNotExecuted, OperationError } from "../core/errors.js";
import { canonical, newId, now, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { PlatformPort } from "../core/ports.js";
import type { Task } from "../core/types.js";
import type { Store } from "../storage/store.js";
import { listUncertainEffects } from "../tasks/uncertain-effects.js";
import type { UncertainCandidate, UncertainChoice } from "./uncertain-choice.js";

export interface UncertainCardRequest {
  operationId: string;
  taskId: string;
  ownerId: string;
  chatId: string;
  step: string;
  evidence: unknown;
  candidates: UncertainCandidate[];
  /** Effect revision: a retried or otherwise changed effect gets its own card. */
  revision?: string;
}
export interface UncertainCard extends UncertainCardRequest {
  nonce: string;
  expiresAt: string;
  consumed: boolean;
  choice?: UncertainChoice;
  consumedAt?: string;
  messageId?: string;
  publication?: "sending" | "sent" | "uncertain" | "retryable";
}
const namespace = "uncertain_cards";

/** Durable single-use cards; callbacks delegate auditing/effects to the resolver. */
export class UncertainCards {
  private readonly locks = new KeyedMutex();
  constructor(
    private readonly store: Store,
    private readonly platform: () => PlatformPort | undefined,
    private readonly apply: (card: UncertainCard, choice: UncertainChoice) => Promise<void>,
    private readonly current: (card: UncertainCard) => boolean = () => true,
  ) {}

  /** Durable read of the card bound to this request identity, if any. */
  lookup(request: UncertainCardRequest): UncertainCard | undefined {
    const nonce = this.store.get<string>("uncertain_card_identity", this.identity(request));
    return nonce ? this.store.get<UncertainCard>(namespace, nonce) : undefined;
  }

  private identity(request: UncertainCardRequest): string {
    return stableId(
      "uncertain-card",
      request.operationId,
      request.ownerId,
      request.chatId,
      ...(request.revision ? [request.revision] : []),
    );
  }

  async publish(request: UncertainCardRequest): Promise<UncertainCard> {
    const identity = this.identity(request);
    return this.locks.run(`publish:${identity}`, async () => {
      const task = this.store.get<Task>("tasks", request.taskId);
      const effect = task
        ? listUncertainEffects(this.store, task).find((entry) => entry.id === request.operationId)
        : undefined;
      request = {
        ...request,
        candidates: request.candidates.filter(
          (candidate) =>
            candidate.id !== "escalate_to_user" &&
            (candidate.id !== "retry_once" ||
              !!effect?.options.some((option) => option.choice === "retry")),
        ),
      };
      const nonce = this.store.get<string>("uncertain_card_identity", identity);
      let card = nonce ? this.store.get<UncertainCard>(namespace, nonce) : undefined;
      if (card?.consumed) return card;
      // Never silently replay a card whose publication could have succeeded.
      if (card?.publication === "sending" || card?.publication === "uncertain")
        throw new OperationError(
          "card_uncertain",
          "未知操作卡片发送结果未知，请核对群中的原卡片。",
          "unknown",
        );
      if (card?.messageId && Date.parse(card.expiresAt) > Date.now()) return card;
      if (card && Date.parse(card.expiresAt) <= Date.now()) {
        this.store.set(namespace, card.nonce, { ...card, consumed: true });
        card = undefined;
      }
      if (!card) {
        card = {
          ...request,
          nonce: newId("uncertain"),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          consumed: false,
        };
        const created = card;
        this.store.transaction(() => {
          this.store.set(namespace, created.nonce, created);
          this.store.set("uncertain_card_identity", identity, created.nonce);
        });
      }
      if (!this.current(card)) fail("uncertain_card_stale", "此步骤已更新，卡片已失效。");
      const platform = this.platform();
      if (!platform) fail("platform_unavailable", "飞书未连接。");
      this.store.set(namespace, card.nonce, { ...card, publication: "sending" });
      try {
        const messageId = await platform.sendCard(card.chatId, this.card(card), card.nonce);
        if (!messageId) throw new OperationError("card_uncertain", "缺少卡片发送回执。", "unknown");
        const latest = this.store.get<UncertainCard>(namespace, card.nonce) as UncertainCard;
        const published: UncertainCard = { ...latest, messageId, publication: "sent" };
        this.store.set(namespace, card.nonce, published);
        if (published.consumed) await this.disable(published);
        return published;
      } catch (error) {
        const latest = this.store.get<UncertainCard>(namespace, card.nonce) as UncertainCard;
        this.store.set(namespace, card.nonce, {
          ...latest,
          publication: isNotExecuted(error) ? "retryable" : "uncertain",
        });
        throw error;
      }
    });
  }

  async answer(ownerId: string, chatId: string, nonce: string, choice: string): Promise<void> {
    return this.locks.run(`answer:${nonce}`, async () => {
      const card = this.store.get<UncertainCard>(namespace, nonce);
      if (!card || card.ownerId !== ownerId || card.chatId !== chatId)
        fail("uncertain_card_scope", "卡片不属于当前所有者/会话。");
      if (card.consumed) fail("uncertain_card_consumed", "此卡片已处理。");
      if (Date.parse(card.expiresAt) <= Date.now())
        fail("uncertain_card_expired", "此卡片已过期。");
      if (!card.candidates.some((candidate) => candidate.id === choice))
        fail("uncertain_choice", "卡片没有此选项。");
      if (!this.current(card)) fail("uncertain_card_stale", "此步骤已更新，卡片已失效。");
      const consumed: UncertainCard = {
        ...card,
        consumed: true,
        choice: choice as UncertainChoice,
        consumedAt: now(),
      };
      // Consumption precedes any async work, including failures or process death.
      this.store.set(namespace, nonce, consumed);
      try {
        await this.apply(consumed, choice as UncertainChoice);
      } finally {
        await this.disable(consumed);
      }
    });
  }

  private async disable(card: UncertainCard) {
    card = this.store.get<UncertainCard>(namespace, card.nonce) ?? card;
    if (card.messageId)
      await this.platform()
        ?.updateCard(card.messageId, {
          schema: "2.0",
          body: {
            elements: [
              { tag: "markdown", content: "此决定已消费；请查看步骤最新状态，不要重复点击。" },
            ],
          },
        })
        .catch(() => {});
  }

  private card(card: UncertainCard): Record<string, unknown> {
    return {
      schema: "2.0",
      header: { title: { tag: "plain_text", content: "操作结果未知，请决定" } },
      body: {
        elements: [
          {
            tag: "markdown",
            content: `未知步骤：${card.step}\n操作：${card.operationId}\n已知证据：${canonical(card.evidence)}\n有效期至：${card.expiresAt}`,
          },
          ...card.candidates.map((candidate) => ({
            tag: "button",
            text: { tag: "plain_text", content: `${candidate.id} — ${candidate.description}` },
            type: "default",
            value: { action: "uncertain", nonce: card.nonce, choice: candidate.id },
          })),
        ],
      },
    };
  }
}
