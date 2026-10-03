import { fail, isNotExecuted, OperationError } from "../core/errors.js";
import { canonical, newId, now, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { HerdrPort, PlatformPort } from "../core/ports.js";
import type { AgentScreen, ExecutionRef } from "../core/types.js";
import { menuState } from "../herdr/menu-state.js";
import { screenFingerprint } from "../herdr/screen.js";
import type { Store } from "../storage/store.js";
import { defaultPresentation, presentScreen, type ScreenPresentation } from "./presentation.js";

export const APPROVAL_OPTIONS_VERSION = "current-native-menu-v3";
interface AnswerOptions {
  signal?: AbortSignal;
  literalKey?: boolean;
  beforeWrite?: () => Promise<void>;
  assertCurrent?: () => void;
}

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
  confirmed?: boolean;
  navigationCompleted?: boolean;
  reobserveAllowed?: boolean;
  invalidatedReason?: string;
  messageId?: string;
  publication?: "sending" | "uncertain" | "retryable" | "sent";
  menuFingerprint?: string;
  replacesNonce?: string;
  screenFingerprint?: string;
  menuState?: string;
  terminalId?: string;
  cwd?: string;
}

/**
 * Narrow structural check for one persisted approval. It only asks whether the
 * fields every caller relies on can be interpreted; it never rewrites, repairs
 * or drops the record. `Date.parse` is reached only after the string check, so a
 * corrupt value such as `{ toString: null }` cannot become a raw TypeError.
 * `consumed` is mandatory because a missing/non-boolean flag must not read as
 * "not yet consumed", and the stored nonce must equal exactly the row key so a
 * renamed or spliced record cannot authorize the key of another live card.
 */
function readableApproval(record: unknown, key: string): record is Approval {
  if (record === null || typeof record !== "object") return false;
  const value = record as Partial<Approval>;
  return (
    typeof value.nonce === "string" &&
    value.nonce.length > 0 &&
    value.nonce === key &&
    typeof value.ownerId === "string" &&
    typeof value.chatId === "string" &&
    typeof value.ref === "object" &&
    value.ref !== null &&
    typeof value.ref.workspaceId === "string" &&
    typeof value.ref.paneId === "string" &&
    typeof value.ref.kind === "string" &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    typeof value.consumed === "boolean" &&
    Array.isArray(value.keys) &&
    value.keys.every((entry) => typeof entry === "string")
  );
}

/**
 * Fail-closed read boundary: refuse an uninterpretable approval record with a
 * typed diagnostic instead of letting a coercion TypeError escape. The original
 * row is preserved, and a refusal here never authorizes a fresh nonce, a native
 * key or the release of an existing card.
 */
function approvalRecord(record: unknown, ref: string): Approval {
  if (readableApproval(record, ref)) return record;
  throw new OperationError(
    "approval_record_invalid",
    `审批记录（${ref}）无法解读；本次审批操作已拒绝，原始记录保留供诊断。`,
    "not_executed",
  );
}

export class Approvals {
  private readonly locks = new KeyedMutex();
  constructor(
    private readonly store: Store,
    private readonly herdr: HerdrPort,
    private readonly platform: () => PlatformPort | undefined,
    private readonly presentation: ScreenPresentation = defaultPresentation,
  ) {}

  /** Successful manual and automatic choices advance the same durable retry epoch. */
  progressRevision(ref: ExecutionRef, terminalId: string): string {
    const identity = (execution: ExecutionRef) =>
      canonical({
        workspaceId: execution.workspaceId,
        paneId: execution.paneId,
        kind: execution.kind,
        cwd: execution.cwd,
        sessionId: execution.sessionId,
      });
    const execution = identity(ref);
    // An unreadable row could hide a confirmed approval. Skipping it would
    // change this revision and hand the automatic route a fresh retry budget,
    // so the whole read is refused instead.
    const approvals = this.store
      .entries<unknown>("approvals")
      .map(([key, record]) => approvalRecord(record, key));
    const nonces = approvals
      .filter(
        (approval) =>
          approval.confirmed &&
          approval.screenFingerprint &&
          approval.terminalId === terminalId &&
          approval.cwd === ref.cwd &&
          approval.sessionId === ref.sessionId &&
          identity(approval.ref) === execution,
      )
      .map((approval) => approval.nonce)
      .sort();
    return stableId("native-approval-progress-v1", execution, terminalId, canonical(nonces));
  }

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
    // The identity index is itself a persisted field. A non-string index cannot
    // be handed to the store (SQLite rejects it) and must not be treated as
    // absence: silently minting a new nonce could duplicate authority over a
    // card that is still live, so refuse and keep the original row.
    const indexed = this.store.get<unknown>("approval_identity", identity);
    if (indexed !== undefined && (typeof indexed !== "string" || !indexed))
      throw new OperationError(
        "approval_record_invalid",
        `审批身份索引（${identity}）无法解读；本次审批操作已拒绝，原始记录保留供诊断。`,
        "not_executed",
      );
    const nonce = indexed as string | undefined;
    const stored = nonce ? this.store.get<unknown>("approvals", nonce) : undefined;
    const previous = stored === undefined ? undefined : approvalRecord(stored, nonce ?? "");
    if (
      nonce &&
      (!previous ||
        previous.ownerId !== ownerId ||
        previous.chatId !== chatId ||
        previous.ref.workspaceId !== ref.workspaceId ||
        previous.ref.paneId !== ref.paneId ||
        previous.ref.kind !== ref.kind ||
        previous.stateSeq !== screen.agent.stateSeq ||
        previous.sessionId !== screen.agent.sessionId)
    )
      throw new OperationError(
        "approval_record_invalid",
        "审批身份索引指向缺失或不匹配的记录；本次审批已拒绝，原始记录保留供诊断。",
        "not_executed",
      );
    const keys = [...new Set([...screen.options.map((option) => option.key), "esc"])];
    const boundScreen =
      screen.source === "visible" && !screen.truncated ? screenFingerprint(screen.text) : undefined;
    const menuFingerprint = stableId(canonical({ options: screen.options, screen: boundScreen }));
    // Successful transitions may open another menu without a new stateSeq.
    // Reusing the old snapshot must never reopen the key that was just consumed.
    if (previous?.navigationCompleted && boundScreen && previous.screenFingerprint === boundScreen)
      return previous;
    let replacesNonce: string | undefined;
    let retired: Approval | undefined;
    if (previous && !previous.navigationCompleted && !previous.reobserveAllowed) {
      // Expiry or a parser upgrade is not proof that a previous key/card send
      // had no effect. Only explicit successful navigation may replace these.
      if (
        previous.consumed ||
        previous.publication === "sending" ||
        previous.publication === "uncertain"
      )
        return previous;
      const changed = previous.menuFingerprint
        ? previous.menuFingerprint !== menuFingerprint
        : canonical(previous.keys) !== canonical(keys);
      if (!changed && Date.parse(previous.expiresAt) > Date.now()) return previous;
      // Older records lack labels. Key/order changes prove a changed mapping;
      // never invent a historical label comparison from today's screen.
      retired = {
        ...previous,
        consumed: true,
        invalidatedReason: changed
          ? "审批菜单已更新，请使用新的审批卡片。"
          : "审批卡片已过期，请使用新的审批卡片。",
      };
      replacesNonce = previous.nonce;
    }
    const approval: Approval = {
      nonce: newId("approval"),
      ownerId,
      chatId,
      ref,
      stateSeq: screen.agent.stateSeq,
      sessionId: screen.agent.sessionId,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      keys,
      menuFingerprint,
      ...(replacesNonce ? { replacesNonce } : {}),
      consumed: false,
      ...(boundScreen
        ? {
            screenFingerprint: boundScreen,
            menuState: menuState(screen.text),
            terminalId: screen.agent.terminalId,
            cwd: screen.agent.cwd,
          }
        : {}),
    };
    this.store.transaction(() => {
      if (retired) this.store.set("approvals", retired.nonce, retired);
      this.store.set("approvals", approval.nonce, approval);
      this.store.set("approval_identity", identity, approval.nonce);
    });
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
      const latest = approvalRecord(
        this.store.get<unknown>("approvals", approval.nonce),
        approval.nonce,
      );
      if (latest.messageId || latest.consumed) return latest;
      if (latest.publication === "sending" || latest.publication === "uncertain") {
        throw new OperationError(
          "card_uncertain",
          "审批卡片发送结果未知，请核对飞书群中的原卡片。",
          "unknown",
        );
      }
      const platform = this.platform();
      if (!platform) fail("platform_unavailable", "飞书未连接。");
      if (latest.replacesNonce) {
        // An unreadable replaced record must not be skipped: skipping would let
        // this publication proceed while that old card may still be live.
        const stored = this.store.get<unknown>("approvals", latest.replacesNonce);
        if (stored !== undefined)
          await this.disableCard(approvalRecord(stored, latest.replacesNonce));
      }
      // Disabling an old remote card yields: an owner/cleanup action may have
      // consumed this replacement in the meantime. Never publish it afterwards.
      const current = approvalRecord(
        this.store.get<unknown>("approvals", latest.nonce),
        latest.nonce,
      );
      if (current.consumed) return current;
      this.store.set("approvals", latest.nonce, { ...latest, publication: "sending" });
      try {
        const messageId = await platform.sendCard(chatId, this.card(latest, screen), latest.nonce);
        if (!messageId) throw new OperationError("card_uncertain", "缺少卡片发送回执。", "unknown");
        // A callback can arrive before sendCard resolves. Never restore a consumed nonce.
        const current = approvalRecord(
          this.store.get<unknown>("approvals", latest.nonce),
          latest.nonce,
        );
        const published: Approval = { ...current, messageId, publication: "sent" };
        this.store.set("approvals", latest.nonce, published);
        if (published.consumed) await this.disableCard(published);
        return published;
      } catch (error) {
        const current = approvalRecord(
          this.store.get<unknown>("approvals", latest.nonce),
          latest.nonce,
        );
        this.store.set("approvals", latest.nonce, {
          ...current,
          publication: isNotExecuted(error) ? "retryable" : "uncertain",
        });
        throw error;
      }
    });
  }

  async answer(
    ownerId: string,
    chatId: string,
    nonce: string,
    key: string,
    options: AnswerOptions = {},
  ): Promise<void> {
    const stored = this.store.get<unknown>("approvals", nonce);
    // Absence is a scope failure, not corruption; a present but unreadable
    // record is refused before any owner/scope comparison can coerce it.
    if (stored === undefined) fail("approval_scope", "审批不属于当前会话。");
    const initial = approvalRecord(stored, nonce);
    if (initial.ownerId !== ownerId || initial.chatId !== chatId)
      fail("approval_scope", "审批不属于当前会话。");
    return this.locks.run(`answer:${initial.ref.workspaceId}:${initial.ref.paneId}`, () =>
      this.answerCurrent(ownerId, chatId, nonce, key, options),
    );
  }

  /** Consume synchronously, including in-flight publications, before updating remote cards. */
  async invalidate(ref: ExecutionRef, reason: string): Promise<void> {
    const updates: Promise<void>[] = [];
    for (const [key, approval] of this.store.entries<unknown>("approvals")) {
      // An unreadable row is left exactly as written. It cannot release this
      // cleanup: `answer` refuses it before any scope or expiry comparison, so
      // it is never a live card. Refusing the whole sweep would instead strand
      // the readable cards of this pane behind an unrelated corrupt record.
      if (!readableApproval(approval, key)) continue;
      if (approval.ref.paneId !== ref.paneId || approval.ref.workspaceId !== ref.workspaceId)
        continue;
      const invalidated: Approval = {
        ...approval,
        consumed: true,
        navigationCompleted: false,
        reobserveAllowed: false,
        invalidatedReason: reason,
      };
      this.store.set("approvals", approval.nonce, invalidated);
      if (!approval.consumed) updates.push(this.disableCard(invalidated));
    }
    await Promise.all(updates);
  }

  private async answerCurrent(
    ownerId: string,
    chatId: string,
    nonce: string,
    key: string,
    options: AnswerOptions,
  ): Promise<void> {
    const stored = this.store.get<unknown>("approvals", nonce);
    if (stored === undefined) fail("approval_scope", "审批不属于当前会话。");
    const approval = approvalRecord(stored, nonce);
    if (approval.ownerId !== ownerId || approval.chatId !== chatId)
      fail("approval_scope", "审批不属于当前会话。");
    if (approval.consumed || Date.parse(approval.expiresAt) < Date.now())
      fail("approval_expired", "审批已处理或已过期，请刷新现场。");
    if (!approval.keys.includes(key)) fail("approval_key", "该审批没有此选项。");
    approval.consumed = true;
    this.store.set("approvals", nonce, approval);
    let failure: unknown;
    try {
      await this.herdr.answer(approval.ref, key, {
        ...approval,
        ...options,
        assertCurrent: () => {
          options.assertCurrent?.();
          const current = this.store.get<unknown>("approvals", nonce);
          if (approvalRecord(current, nonce).invalidatedReason)
            fail("approval_expired", "审批在执行前已失效，未发送按键。");
        },
      });
      if (approval.screenFingerprint || ["up", "down", "tab"].includes(key))
        await this.refreshNavigation(approval);
      else await this.invalidate(approval.ref, "此问题已处理，请等待新的审批现场。");
    } catch (error) {
      failure = error;
      await this.invalidate(approval.ref, "审批按键未确认完成，请查看现场，不要重复点击。");
      if (
        approval.screenFingerprint &&
        isNotExecuted(error) &&
        error instanceof OperationError &&
        ["stale_guard", "approval_scope_changed"].includes(error.code)
      ) {
        const current = approvalRecord(this.store.get<unknown>("approvals", nonce), nonce);
        this.store.set("approvals", nonce, {
          ...current,
          reobserveAllowed: true,
        });
      }
    } finally {
      await this.disableCard(approval, !!failure);
    }
    if (failure)
      throw failure instanceof OperationError
        ? failure
        : new OperationError("approval_unknown", "审批写入结果未知，请查看现场。", "unknown");
  }

  private async refreshNavigation(approval: Approval): Promise<void> {
    let screen: AgentScreen;
    try {
      screen = await this.herdr.screen(approval.ref);
    } catch (cause) {
      throw new OperationError(
        "approval_refresh_required",
        "导航按键已发送，重新读取现场失败；请查看现场，不要重复导航。",
        "unknown",
        { cause },
      );
    }
    const current = approvalRecord(
      this.store.get<unknown>("approvals", approval.nonce),
      approval.nonce,
    );
    // Automatic startup confirmation or another owner action may have invalidated
    // this pane while the navigation readback was pending. Never revive its cards.
    if (current.invalidatedReason) return;
    if (
      approval.screenFingerprint &&
      (screen.source !== "visible" ||
        screen.truncated ||
        !screen.text.trim() ||
        screen.agent.paneId !== approval.ref.paneId ||
        screen.agent.workspaceId !== approval.ref.workspaceId ||
        screen.agent.kind !== approval.ref.kind ||
        screen.agent.terminalId !== approval.terminalId ||
        screen.agent.cwd !== approval.cwd ||
        (approval.sessionId && approval.sessionId !== screen.agent.sessionId) ||
        !["idle", "done", "blocked", "working"].includes(screen.agent.status) ||
        (screen.agent.status === "blocked" &&
          (!approval.menuState ||
            !menuState(screen.text) ||
            menuState(screen.text) === approval.menuState)))
    )
      throw new OperationError(
        "approval_refresh_required",
        "按键后现场尚未确认，请查看现场，不要重复操作。",
        "unknown",
      );
    if (approval.screenFingerprint)
      this.store.set("approvals", approval.nonce, { ...current, confirmed: true });
    const updates = this.invalidate(approval.ref, "菜单选择已更新，请使用新的审批卡片。");
    if (screen.agent.status !== "blocked") {
      await updates;
      return;
    }
    this.store.set("approvals", approval.nonce, {
      ...approvalRecord(this.store.get<unknown>("approvals", approval.nonce), approval.nonce),
      navigationCompleted: true,
    });
    // Only confirmed navigation may replace a consumed nonce at the same native
    // stateSeq. Confirmation and uncertain writes remain consumed across refreshes.
    this.create(approval.ownerId, approval.chatId, approval.ref, screen);
    await updates;
    if (approval.publication)
      await this.publish(approval.ownerId, approval.chatId, approval.ref, screen);
  }

  private async disableCard(approval: Approval, failed = false): Promise<void> {
    approval = this.store.get<Approval>("approvals", approval.nonce) ?? approval;
    if (approval.messageId)
      await this.platform()
        ?.updateCard(approval.messageId, {
          schema: "2.0",
          body: {
            elements: [
              {
                tag: "markdown",
                content:
                  approval.invalidatedReason ??
                  (failed
                    ? "审批已消费，结果尚未确认；请查看现场，不要重复点击。"
                    : `已处理 · ${now()}`),
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
