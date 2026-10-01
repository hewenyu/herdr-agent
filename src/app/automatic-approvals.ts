import { realpath } from "node:fs/promises";
import { fail, isNotExecuted, safeError } from "../core/errors.js";
import { canonical, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { HerdrPort, Logger } from "../core/ports.js";
import type {
  ActorContext,
  AgentScreen,
  Participant,
  StoredMessage,
  Task,
  UserRequestSource,
} from "../core/types.js";
import { approvalFailureEvidence } from "../herdr/approval-error.js";
import {
  menuAction,
  type NativeMenu,
  type NativeMenuAction,
  nativeMenu,
} from "../herdr/native-menu.js";
import { screenFingerprint } from "../herdr/screen.js";
import type { ChoiceCandidate, JevOptions } from "../orchestration/jev.js";
import type { ConversationEngine } from "../runtime/types.js";
import type { Store } from "../storage/store.js";
import { executionGeneration, startupTrustStatus } from "../tasks/readiness.js";
import { type ApprovalChoice, approvalCandidates, chooseApproval } from "./approval-choice.js";
import { approvalIngress } from "./approval-priority.js";
import type { Approvals } from "./approvals.js";

const namespace = "automatic_approval_decisions";
interface ApprovalContext {
  signal: AbortSignal;
  allowed: () => boolean;
}
interface Decision {
  id: string;
  taskId: string;
  participantId: string;
  /** Execution generation this decision belongs to; never inherited by another. */
  generation?: string;
  execution: NonNullable<Participant["execution"]>;
  terminalId: string;
  stateSeq: string;
  fingerprint: string;
  inputRevision: string;
  userRevision: string;
  directoryIdentity: string;
  approvalNonce: string;
  retryIdentity: string;
  state:
    | "selecting"
    | "selected"
    | "executing"
    | "executed"
    | "failed"
    | "uncertain"
    | "waiting_user";
  attempts: number;
  retryAt?: string;
  candidates: ChoiceCandidate[];
  observation: { screen: AgentScreen; userInput: unknown; menu?: NativeMenu };
  selection?: ApprovalChoice;
  action?: NativeMenuAction;
  effect?: { status: string; selectedOptionId?: string };
  failure?: ReturnType<typeof approvalFailureEvidence>;
  key?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** Selector only adds evidence; all effects use the existing consumed approval nonce. */
export class AutomaticApprovals {
  private readonly locks = new KeyedMutex();
  constructor(
    private readonly ports: {
      store: Store;
      herdr: HerdrPort;
      approvals: Approvals;
      engine: ConversationEngine;
      logger: Logger;
      signal: AbortSignal;
      config: () => JevOptions | undefined;
      fetch?: typeof fetch;
    },
  ) {}

  private userInput(task: Task) {
    const revisions = this.ports.store
      .list<{ taskId: string; source: UserRequestSource; at: string }>("task_user_revisions")
      .filter((r) => r.taskId === task.id && r.source.ownerId === task.ownerId)
      .map((r) => ({ text: r.source.text, at: r.at }));
    const messages = this.ports.store
      .list<StoredMessage>("messages")
      .filter((m) => m.taskId === task.id && m.role === "user" && m.source === "user")
      .map((m) => ({ text: m.text, at: m.createdAt }));
    return {
      source: task.userRequest ? "user_request" : "legacy_requirements",
      request: task.userRequest?.text ?? task.requirements,
      ...(task.requestContext?.length
        ? { context: task.requestContext.map(({ messageId, text }) => ({ messageId, text })) }
        : {}),
      kind: task.kind,
      participantIds: task.participantIds,
      authorizedDirectories: task.directories,
      boardDirectory: task.boardDirectory,
      pauseRevision: this.ports.store.get<number>("task_pause_revision", task.id) ?? 0,
      revisions: [...revisions, ...messages].sort((a, b) => a.at.localeCompare(b.at)),
    };
  }

  private revisionInput(task: Task, userInput = this.userInput(task)) {
    // Keep v1 retry/waiting-user identities across upgrades. The historical
    // requirements field participates only in freshness, never model authority.
    return canonical({
      ...Object.fromEntries(Object.entries(userInput).filter(([key]) => key !== "source")),
      requirements: task.requirements,
    });
  }

  private inputRevision(task: Task, userInput = this.userInput(task)) {
    // Every accepted event invalidates a pending choice, even if processing
    // proves it harmless. It is execution freshness, not renewed retry credit.
    return stableId(
      this.revisionInput(task, userInput),
      approvalIngress(this.ports.store, task).revision,
    );
  }

  private scope(
    task: Task,
    participant: Participant,
    screen: AgentScreen,
    actor: ActorContext,
    context: ApprovalContext,
  ) {
    const t = this.ports.store.get<Task>("tasks", task.id);
    const p = this.ports.store.get<Participant>("participants", participant.id);
    const ref = participant.execution;
    if (
      !t ||
      !p ||
      !ref ||
      this.ports.signal.aborted ||
      context.signal.aborted ||
      !context.allowed() ||
      !this.ports.config()?.apiKey ||
      t.ownerId !== actor.ownerId ||
      actor.taskId !== t.id ||
      p.taskId !== t.id ||
      !t.participantIds.includes(p.id) ||
      !p.started ||
      // Generic permission menus remain subject to the business pause; only the
      // tightly scoped startup directory trust is exempt.
      t.discussion.paused ||
      ["paused", "completed", "destroying", "destroyed"].includes(t.status) ||
      t.closeRequested ||
      t.completionRequest ||
      t.groupDeleted ||
      t.syncError ||
      approvalIngress(this.ports.store, t).pending ||
      ["removed", "gone"].includes(p.status) ||
      p.execution?.paneId !== ref.paneId ||
      p.execution.workspaceId !== ref.workspaceId ||
      p.execution.kind !== ref.kind ||
      p.execution.cwd !== ref.cwd ||
      p.execution.sessionId !== ref.sessionId ||
      screen.agent.status !== "blocked" ||
      screen.agent.paneId !== ref.paneId ||
      screen.agent.workspaceId !== ref.workspaceId ||
      screen.agent.kind !== ref.kind ||
      screen.agent.cwd !== ref.cwd ||
      !screen.agent.terminalId ||
      (ref.sessionId && ref.sessionId !== screen.agent.sessionId) ||
      screen.source !== "visible" ||
      screen.truncated ||
      !screen.text.trim()
    )
      return;
    return { task: t, participant: p };
  }

  private async current(
    task: Task,
    participant: Participant,
    screen: AgentScreen,
    actor: ActorContext,
    context: ApprovalContext,
  ) {
    const scope = this.scope(task, participant, screen, actor, context);
    if (!scope || !participant.execution) return;
    const { task: t, participant: p } = scope;
    try {
      const cwd = await realpath(participant.execution.cwd);
      if (!(await Promise.all(t.directories.map((directory) => realpath(directory)))).includes(cwd))
        return;
    } catch {
      return;
    }
    // Filesystem checks yield; pause/remove/config changes must still win.
    if (
      this.ports.signal.aborted ||
      context.signal.aborted ||
      !context.allowed() ||
      !this.ports.config()?.apiKey ||
      canonical(this.ports.store.get<Task>("tasks", task.id)) !== canonical(t) ||
      canonical(this.ports.store.get<Participant>("participants", participant.id)) !== canonical(p)
    )
      return;
    return t;
  }

  async handle(
    task: Task,
    participant: Participant,
    screen: AgentScreen,
    actor: ActorContext,
    context: ApprovalContext = { signal: this.ports.signal, allowed: () => true },
  ): Promise<"handled" | "pending" | "manual"> {
    return this.locks.run(participant.id, () =>
      this.handleCurrent(task, participant, screen, actor, context),
    );
  }

  private async handleCurrent(
    task: Task,
    participant: Participant,
    screen: AgentScreen,
    actor: ActorContext,
    context: ApprovalContext,
  ): Promise<"handled" | "pending" | "manual"> {
    const config = this.ports.config();
    const current = await this.current(task, participant, screen, actor, context);
    if (!current || !config) return "manual";
    const ref = participant.execution as NonNullable<Participant["execution"]>;
    const userInput = this.userInput(current);
    const userRevision = stableId(this.revisionInput(current, userInput));
    const inputRevision = this.inputRevision(current, userInput);
    const fingerprint = screenFingerprint(screen.text);
    const directoryIdentity = await realpath(ref.cwd).catch(() => undefined);
    if (!directoryIdentity) return "manual";
    const generation = executionGeneration(participant);
    const history = this.ports.store
      .list<Decision>(namespace)
      .filter(
        (d) =>
          d.participantId === participant.id &&
          (d.generation === undefined || d.generation === generation) &&
          d.execution.paneId === ref.paneId &&
          d.execution.workspaceId === ref.workspaceId &&
          d.terminalId === screen.agent.terminalId,
      );
    // A lost effect ACK freezes this execution, even if its menu/stateSeq changes.
    // A definitely new generation is not frozen by a retired generation's loss.
    if (history.some((d) => ["executing", "uncertain"].includes(d.state))) return "manual";
    const menu = nativeMenu(screen.text);
    if (!menu) return "manual";
    // A same-execution startup-trust effect whose result is unknown can never be
    // bypassed by the generic route, even if its menu/stateSeq changed; a
    // definitely new generation is not governed by the retired receipts. A
    // confirmed trust never freezes a later, unrelated permission menu.
    if (startupTrustStatus(this.ports.store, participant).frozen) return "manual";
    const chatId = task.chatId ?? actor.chatId;
    const approval = this.ports.approvals.create(task.ownerId, chatId, ref, screen);
    if (approval.consumed || approval.screenFingerprint !== fingerprint) return "manual";
    const id = stableId("native-approval-v2", approval.nonce, inputRevision);
    const previous = this.ports.store.get<Decision>(namespace, id);
    // Nonces bind writes to full snapshots, but dynamic text (even inside an
    // option) must not replenish the selection budget. Only confirmed progress
    // through the shared automatic/manual approval chain starts another epoch.
    const retryIdentity = stableId(
      "native-approval-retry-v1",
      canonical({
        workspaceId: ref.workspaceId,
        paneId: ref.paneId,
        kind: ref.kind,
        cwd: ref.cwd,
        sessionId: ref.sessionId,
      }),
      screen.agent.terminalId as string,
      directoryIdentity,
      userRevision,
      this.ports.approvals.progressRevision(ref, screen.agent.terminalId as string),
    );
    const retry = history
      .filter((d) => d.retryIdentity === retryIdentity)
      .sort((a, b) => b.attempts - a.attempts)[0];
    if (
      retry &&
      (retry.attempts >= 3 ||
        retry.state === "waiting_user" ||
        (retry.state === "failed" &&
          !["stale_guard", "approval_scope_changed"].includes(retry.error ?? "")))
    )
      return "manual";
    if (retry?.retryAt && Date.parse(retry.retryAt) > Date.now()) return "pending";
    // Catch navigation cycles without constraining the task's discussion rounds.
    if (
      history.filter(
        (d) =>
          d.fingerprint === fingerprint &&
          d.userRevision === userRevision &&
          d.stateSeq === screen.agent.stateSeq &&
          d.state === "executed",
      ).length >= 2
    )
      return "manual";
    const candidates = approvalCandidates(menu);
    const at = new Date().toISOString();
    const decision: Decision = {
      id,
      taskId: task.id,
      participantId: participant.id,
      generation,
      execution: ref,
      terminalId: screen.agent.terminalId as string,
      stateSeq: screen.agent.stateSeq,
      fingerprint,
      inputRevision,
      userRevision,
      directoryIdentity,
      approvalNonce: approval.nonce,
      retryIdentity,
      state: "selecting",
      attempts: (retry?.attempts ?? 0) + 1,
      candidates,
      observation: { screen, userInput, menu },
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    };
    const save = () => {
      decision.updatedAt = new Date().toISOString();
      this.ports.store.set(namespace, id, decision);
    };
    if (decision.attempts > 3) return "manual";
    decision.retryAt = new Date(Date.now() + 30_000).toISOString();
    save();
    const signal = AbortSignal.any([this.ports.signal, context.signal]);
    const selection = await chooseApproval({
      jev: config,
      engine: this.ports.engine,
      actor,
      id,
      state: {
        userInput,
        taskId: task.id,
        participantId: participant.id,
        kind: ref.kind,
        directory: ref.cwd,
        screen: screen.text,
        menu,
      },
      candidates,
      signal,
      fetch: this.ports.fetch,
    });
    decision.selection = selection;
    decision.action = selection.candidateId ? menuAction(menu, selection.candidateId) : undefined;
    decision.state = "selected";
    save();
    this.ports.logger.info("原生菜单选择已记录", {
      event: "approval.automatic_selected",
      taskId: task.id,
      participantId: participant.id,
      source: selection.source,
      candidateId: selection.candidateId,
      jevStatus: selection.jev.status,
      jevConfidence: selection.jev.confidence,
      jevReason: selection.jev.reason,
      pressed: decision.action?.key,
      beforeOptionId: decision.action?.beforeOptionId,
      targetOptionId: decision.action?.targetOptionId,
    });
    if (!selection.candidateId) {
      decision.state = decision.attempts < 3 ? "selecting" : "waiting_user";
      decision.retryAt =
        decision.attempts < 3 ? new Date(Date.now() + 30_000).toISOString() : undefined;
      save();
      return decision.retryAt ? "pending" : "manual";
    }
    if (selection.candidateId === "wait_user") {
      decision.state = "waiting_user";
      decision.retryAt = undefined;
      save();
      return "manual";
    }
    const beforeWrite = async () => {
      const latest = await this.current(task, participant, screen, actor, context);
      if (
        !latest ||
        this.inputRevision(latest) !== inputRevision ||
        (await realpath(ref.cwd).catch(() => undefined)) !== directoryIdentity
      )
        fail("approval_scope_changed", "任务或用户要求已变化，未发送按键。");
    };
    // No I/O here: this runs after the final native read, immediately before keys.
    // A new startup-trust unknown for this same generation vetoes the write too.
    const assertCurrent = () => {
      const latest = this.scope(task, participant, screen, actor, context)?.task;
      if (
        !latest ||
        this.inputRevision(latest) !== inputRevision ||
        startupTrustStatus(this.ports.store, participant, decision.id).frozen
      )
        fail("approval_scope_changed", "任务或用户要求已变化，未发送按键。");
    };
    const action = decision.action;
    if (!action || !candidates.some((c) => c.id === selection.candidateId)) return "manual";
    // The compiler sees the actual cursor; a selector's prose cannot make Enter
    // confirm a different row. The existing full-screen guard revalidates this
    // exact observation immediately before the single key is written.
    const key = action.key;
    decision.key = key;
    decision.state = "executing";
    save();
    try {
      await beforeWrite();
      await this.ports.approvals.answer(task.ownerId, chatId, approval.nonce, key, {
        signal,
        literalKey: true,
        beforeWrite,
        assertCurrent,
      });
      decision.state = "executed";
      decision.retryAt = undefined;
      save();
      const after = await this.ports.herdr.screen(ref, signal).catch(() => undefined);
      if (
        after &&
        after.agent.terminalId === screen.agent.terminalId &&
        after.agent.cwd === ref.cwd
      ) {
        const afterMenu = !after.truncated ? nativeMenu(after.text) : undefined;
        decision.effect = {
          status: after.agent.status,
          selectedOptionId: afterMenu?.options[afterMenu.selected]?.id,
        };
        save();
      }
      this.ports.logger.info("原生菜单选择已执行并回读", {
        event: "approval.automatic_completed",
        taskId: task.id,
        participantId: participant.id,
        source: selection.source,
        candidateId: selection.candidateId,
        jevConfidence: selection.jev.confidence,
        pressed: decision.action?.key,
        beforeOptionId: decision.action?.beforeOptionId,
        targetOptionId: decision.action?.targetOptionId,
        afterOptionId: decision.effect?.selectedOptionId,
        afterStatus: decision.effect?.status,
      });
      return "handled";
    } catch (error) {
      decision.state = isNotExecuted(error) ? "failed" : "uncertain";
      decision.error = safeError(error).code;
      decision.failure = approvalFailureEvidence(error);
      decision.retryAt =
        decision.state === "failed" &&
        ["stale_guard", "approval_scope_changed"].includes(decision.error) &&
        decision.attempts < 3
          ? new Date(Date.now() + 30_000).toISOString()
          : undefined;
      save();
      this.ports.logger.warn("原生菜单选择未完成", {
        event: "approval.automatic_failed",
        taskId: task.id,
        participantId: participant.id,
        code: decision.error,
        outcome: decision.state,
        failurePhase: decision.failure?.phase,
        causeCode: decision.failure?.causeCode,
        readbackReason: decision.failure?.reason,
        pressed: decision.action?.key,
        beforeOptionId: decision.action?.beforeOptionId,
        targetOptionId: decision.action?.targetOptionId,
      });
      return "manual";
    }
  }
}
