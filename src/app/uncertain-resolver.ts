import { OperationError, safeError } from "../core/errors.js";
import { now, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { Logger, PlatformPort } from "../core/ports.js";
import type { ActorContext, Task } from "../core/types.js";
import type { ReportDelivery } from "../orchestration/report-delivery.js";
import type { ConversationEngine } from "../runtime/types.js";
import type { OperationReceipt, OperationResolution } from "../storage/operations.js";
import type { Store } from "../storage/store.js";
import { assertActive, type TaskContext } from "../tasks/context.js";
import {
  applyUncertainResolution,
  listUncertainEffects,
  reconcileUncertain,
  type UncertainEffect,
} from "../tasks/uncertain-effects.js";
import { type UncertainCard, UncertainCards } from "./uncertain-cards.js";
import { chooseUncertain, uncertainCandidates } from "./uncertain-choice.js";

const choices = {
  treat_as_done: "treat_done",
  retry_once: "retry",
  abandon_step: "abandon",
  escalate_to_user: undefined,
} as const;
const attempts = "uncertain_pi_attempts";

/** Resolves receipts only; the normal scheduler remains the sole executor of effects. */
export class UncertainResolver {
  readonly cards: UncertainCards;
  private readonly locks = new KeyedMutex();
  constructor(
    private readonly ports: {
      store: Store;
      engine: ConversationEngine;
      logger: Logger;
      context: () => TaskContext;
      platform: () => PlatformPort | undefined;
      actor: (task: Task, messageId: string) => ActorContext;
    },
  ) {
    this.cards = new UncertainCards(
      ports.store,
      ports.platform,
      async (card, choice) => {
        const effect = this.cardEffect(card);
        if (!effect || choice === "escalate_to_user")
          throw new OperationError("uncertain_card_stale", "未知操作卡片已失效。");
        // Persist synchronously, before any await (including card disabling).
        this.resolve(effect, choices[choice], "user", `用户卡片选择：${choice}`);
      },
      (card) => !!this.cardEffect(card),
    );
  }

  private revision(effect: UncertainEffect): string {
    const { store } = this.ports;
    if (effect.kind === "report_file") {
      const record = store.get<ReportDelivery>(
        "workflow_report_deliveries",
        effect.id.slice("report-file:".length),
      );
      return stableId(
        effect.id,
        String(record?.fileHistory?.length ?? 0),
        record?.fingerprint ?? "",
      );
    }
    const receipt = store.get<OperationReceipt>("operations", effect.id);
    return stableId(effect.id, String(receipt?.history?.length ?? 0), receipt?.fingerprint ?? "");
  }

  private cardEffect(card: UncertainCard): UncertainEffect | undefined {
    const task = this.ports.store.get<Task>("tasks", card.taskId);
    if (!task || task.groupDeleted || task.ownerId !== card.ownerId || task.chatId !== card.chatId)
      return;
    return listUncertainEffects(this.ports.store, task).find(
      (effect) => effect.id === card.operationId && this.revision(effect) === card.revision,
    );
  }

  private resolve(
    effect: UncertainEffect,
    choice: OperationResolution["choice"],
    decidedBy: OperationResolution["decidedBy"],
    reason: string,
  ): void {
    applyUncertainResolution(this.ports.store, effect, { choice, decidedBy, reason });
    this.ports.logger.info("uncertain.resolved", {
      effectId: effect.id,
      kind: effect.kind,
      choice,
      decidedBy,
    });
  }

  async tick(tasks: readonly Task[]): Promise<void> {
    for (const snapshot of tasks) {
      if (snapshot.status === "destroyed" || (!snapshot.chatId && snapshot.status !== "destroying"))
        continue;
      await this.locks.run(snapshot.id, async () => {
        const context = this.ports.context();
        if (context.signal.aborted) return;
        const task = this.ports.store.get<Task>("tasks", snapshot.id);
        if (
          !task ||
          task.status === "destroyed" ||
          !context.config.feishu.allowedOpenIds.includes(task.ownerId)
        )
          return;
        try {
          const before = listUncertainEffects(context.store, task);
          const result = await reconcileUncertain(context, task);
          for (const id of result.resolved) {
            const effect = before.find((entry) => entry.id === id);
            if (effect)
              this.ports.logger.info("uncertain.resolved", {
                effectId: id,
                kind: effect.kind,
                choice: "treat_done",
                decidedBy: "evidence",
              });
          }
          for (const effect of result.remaining) {
            try {
              await this.decide(context, task, effect);
            } catch (error) {
              this.ports.logger.warn("uncertain.effect_failed", {
                effectId: effect.id,
                kind: effect.kind,
                code: safeError(error).code,
              });
            }
          }
        } catch (error) {
          this.ports.logger.warn("uncertain.reconcile_failed", {
            taskId: task.id,
            code: safeError(error).code,
          });
        }
      });
    }
  }

  private async decide(context: TaskContext, task: Task, effect: UncertainEffect): Promise<void> {
    const revision = this.revision(effect);
    const current = () => {
      assertActive(context);
      const latest = this.ports.store.get<Task>("tasks", task.id);
      const active =
        latest &&
        latest.status !== "destroyed" &&
        listUncertainEffects(this.ports.store, latest).find((entry) => entry.id === effect.id);
      if (!active || this.revision(active) !== revision)
        throw new OperationError("uncertain_effect_stale", "未知操作已变化。");
      return latest;
    };
    current();
    if (!this.ports.store.get(attempts, revision)) {
      // Write before invoking pi: failure/restart cannot cause a second attempt.
      this.ports.store.set(attempts, revision, {
        effectId: effect.id,
        at: now(),
        state: "selecting",
      });
      const candidates = uncertainCandidates.filter(
        (candidate) =>
          candidate.id === "escalate_to_user" ||
          (effect.options.some((option) => option.choice === choices[candidate.id]) &&
            !(effect.kind === "pane_close" && candidate.id === "abandon_step")),
      );
      const selection = await chooseUncertain({
        engine: this.ports.engine,
        actor: this.ports.actor(task, `uncertain:${revision}`),
        id: revision,
        state: { effect },
        candidates,
        signal: context.signal,
        assertCurrent: current,
      });
      this.ports.store.set(attempts, revision, {
        effectId: effect.id,
        at: now(),
        state: "selected",
        selection,
      });
      current();
      this.ports.logger.info("uncertain.selected", {
        effectId: effect.id,
        kind: effect.kind,
        choice: selection.choice,
        decidedBy: selection.source,
      });
      if (selection.source === "pi" && selection.choice !== "escalate_to_user") {
        this.resolve(effect, choices[selection.choice], "pi", selection.reason);
        return;
      }
    }
    const latest = current();
    if (!latest?.chatId || latest.groupDeleted) return;
    const candidates = uncertainCandidates.filter(
      (candidate) =>
        candidate.id !== "escalate_to_user" &&
        effect.options.some((option) => option.choice === choices[candidate.id]),
    );
    await this.cards.publish({
      operationId: effect.id,
      taskId: task.id,
      ownerId: latest.ownerId,
      chatId: latest.chatId,
      step: effect.summary,
      evidence: effect.evidence,
      candidates,
      revision,
    });
  }
}
