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

/**
 * Narrow structural check for one persisted card. It never repairs or drops the
 * record; it only proves the fields callers read are interpretable. The expiry
 * string is checked before `Date.parse`, so a corrupt value such as
 * `{ toString: null }` cannot become a raw TypeError, the card identity index
 * must be a non-empty string before it reaches the store, `consumed` must be a
 * real boolean so a falsey value cannot hide an already-consumed card, and the
 * stored nonce must equal its own key so a row cannot claim another card's
 * authority.
 */
function readableCard(record: unknown, ref: string): record is UncertainCard {
  if (record === null || typeof record !== "object") return false;
  const value = record as Partial<UncertainCard>;
  return (
    typeof value.nonce === "string" &&
    value.nonce.length > 0 &&
    value.nonce === ref &&
    typeof value.ownerId === "string" &&
    typeof value.chatId === "string" &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    typeof value.consumed === "boolean" &&
    Array.isArray(value.candidates) &&
    value.candidates.every(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        typeof candidate.id === "string" &&
        typeof candidate.description === "string",
    )
  );
}

/**
 * Fail-closed read boundary: an uninterpretable card is refused with a typed
 * diagnostic rather than coerced into a raw TypeError. The original row is kept,
 * and a refusal never applies a choice, disables a card or mints a replacement
 * nonce for an unknown effect.
 */
function cardRecord(record: unknown, ref: string): UncertainCard {
  if (readableCard(record, ref)) return record;
  throw new OperationError(
    "card_record_invalid",
    `未知操作卡片（${ref}）无法解读；本次操作已拒绝，原始记录保留供诊断。`,
    "not_executed",
  );
}

/** Identity index read boundary; a corrupt index is never treated as absence. */
function identityValue(record: unknown, ref: string): string | undefined {
  if (record === undefined) return undefined;
  if (typeof record === "string" && record.length > 0) return record;
  throw new OperationError(
    "card_record_invalid",
    `未知操作卡片索引（${ref}）无法解读；本次操作已拒绝，原始记录保留供诊断。`,
    "not_executed",
  );
}

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
    const identity = this.identity(request);
    const nonce = identityValue(
      this.store.get<unknown>("uncertain_card_identity", identity),
      identity,
    );
    if (nonce === undefined) return undefined;
    return this.indexedCard(request, nonce);
  }

  private indexedCard(request: UncertainCardRequest, nonce: string): UncertainCard {
    const card = cardRecord(this.store.get<unknown>(namespace, nonce), nonce);
    if (
      card.taskId !== request.taskId ||
      card.operationId !== request.operationId ||
      card.ownerId !== request.ownerId ||
      card.chatId !== request.chatId ||
      (card.revision ?? "") !== (request.revision ?? "")
    )
      throw new OperationError(
        "card_record_invalid",
        "未知操作卡片索引与请求身份不匹配；本次操作已拒绝，原始记录保留供诊断。",
        "not_executed",
      );
    return card;
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
      const nonce = identityValue(
        this.store.get<unknown>("uncertain_card_identity", identity),
        identity,
      );
      // An existing index must still own its exact request. Neither a missing
      // nor a foreign target can authorize a replacement card or another effect.
      let card = nonce === undefined ? undefined : this.indexedCard(request, nonce);
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
        // The card is already proven expired, so consuming it cannot replay an
        // effect; the readable record is rewritten exactly as before.
        this.store.set(namespace, card.nonce, { ...card, consumed: true });
        card = undefined;
      }
      if (!card) {
        // `card` is narrowed to a live, readable record here.
        const created: UncertainCard = {
          ...request,
          nonce: newId("uncertain"),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          consumed: false,
        };
        this.store.transaction(() => {
          this.store.set(namespace, created.nonce, created);
          this.store.set("uncertain_card_identity", identity, created.nonce);
        });
        card = created;
      }
      if (!this.current(card)) fail("uncertain_card_stale", "此步骤已更新，卡片已失效。");
      const platform = this.platform();
      if (!platform) fail("platform_unavailable", "飞书未连接。");
      this.store.set(namespace, card.nonce, { ...card, publication: "sending" });
      try {
        const messageId = await platform.sendCard(card.chatId, this.card(card), card.nonce);
        if (!messageId) throw new OperationError("card_uncertain", "缺少卡片发送回执。", "unknown");
        const latest = cardRecord(this.store.get<unknown>(namespace, card.nonce), card.nonce);
        const published: UncertainCard = { ...latest, messageId, publication: "sent" };
        this.store.set(namespace, card.nonce, published);
        if (published.consumed) await this.disable(published);
        return published;
      } catch (error) {
        const latest = cardRecord(this.store.get<unknown>(namespace, card.nonce), card.nonce);
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
      const stored = this.store.get<unknown>(namespace, nonce);
      if (stored === undefined) fail("uncertain_card_scope", "卡片不属于当前所有者/会话。");
      const card = cardRecord(stored, nonce);
      if (card.ownerId !== ownerId || card.chatId !== chatId)
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
    const stored = this.store.get<unknown>(namespace, card.nonce);
    if (stored !== undefined && readableCard(stored, card.nonce)) card = stored;
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
