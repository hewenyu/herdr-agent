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
import { screenFingerprint } from "../herdr/screen.js";
import type { ChoiceCandidate, JevOptions } from "../orchestration/jev.js";
import type { ConversationEngine } from "../runtime/types.js";
import type { Store } from "../storage/store.js";
import { type ApprovalChoice, approvalCandidates, chooseApproval } from "./approval-choice.js";
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
  execution: NonNullable<Participant["execution"]>;
  terminalId: string;
  stateSeq: string;
  fingerprint: string;
  inputRevision: string;
  directoryIdentity: string;
  approvalNonce: string;
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
  observation: { screen: AgentScreen; userInput: unknown };
  selection?: ApprovalChoice;
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
      request: task.userRequest?.text ?? task.requirements,
      requirements: task.requirements,
      kind: task.kind,
      authorizedDirectories: task.directories,
      boardDirectory: task.boardDirectory,
      pauseRevision: this.ports.store.get<number>("task_pause_revision", task.id) ?? 0,
      revisions: [...revisions, ...messages].sort((a, b) => a.at.localeCompare(b.at)),
    };
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
      ["paused", "completed", "destroying", "destroyed"].includes(t.status) ||
      t.discussion.paused ||
      t.closeRequested ||
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
    const inputRevision = stableId(canonical(userInput));
    const fingerprint = screenFingerprint(screen.text);
    const directoryIdentity = await realpath(ref.cwd).catch(() => undefined);
    if (!directoryIdentity) return "manual";
    const history = this.ports.store
      .list<Decision>(namespace)
      .filter(
        (d) =>
          d.participantId === participant.id &&
          d.execution.paneId === ref.paneId &&
          d.terminalId === screen.agent.terminalId,
      );
    // A lost effect ACK freezes this execution, even if its menu/stateSeq changes.
    if (history.some((d) => ["executing", "uncertain"].includes(d.state))) return "manual";
    const chatId = task.chatId ?? actor.chatId;
    const approval = this.ports.approvals.create(task.ownerId, chatId, ref, screen);
    if (approval.consumed || approval.screenFingerprint !== fingerprint) return "manual";
    const id = stableId("native-approval-v1", approval.nonce, inputRevision);
    const previous = this.ports.store.get<Decision>(namespace, id);
    if (previous && ["executed", "waiting_user", "failed"].includes(previous.state))
      return "manual";
    if (previous?.retryAt && Date.parse(previous.retryAt) > Date.now()) return "pending";
    // Catch navigation cycles without constraining the task's discussion rounds.
    if (
      history.filter(
        (d) =>
          d.fingerprint === fingerprint &&
          d.inputRevision === inputRevision &&
          d.stateSeq === screen.agent.stateSeq &&
          d.state === "executed",
      ).length >= 2
    )
      return "manual";
    const candidates = approvalCandidates(screen.options);
    if (!candidates.length) return "manual";
    const at = new Date().toISOString();
    const decision: Decision = {
      id,
      taskId: task.id,
      participantId: participant.id,
      execution: ref,
      terminalId: screen.agent.terminalId as string,
      stateSeq: screen.agent.stateSeq,
      fingerprint,
      inputRevision,
      directoryIdentity,
      approvalNonce: approval.nonce,
      state: "selecting",
      attempts: (previous?.attempts ?? 0) + 1,
      candidates,
      observation: { screen, userInput },
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
        options: screen.options,
      },
      candidates,
      signal,
      fetch: this.ports.fetch,
    });
    decision.selection = selection;
    decision.state = "selected";
    decision.retryAt = undefined;
    save();
    this.ports.logger.info("原生菜单选择已记录", {
      event: "approval.automatic_selected",
      taskId: task.id,
      participantId: participant.id,
      source: selection.source,
      candidateId: selection.candidateId,
      confidence: selection.jev.confidence,
      reason: selection.jev.reason,
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
      save();
      return "manual";
    }
    const beforeWrite = async () => {
      const latest = await this.current(task, participant, screen, actor, context);
      if (
        !latest ||
        stableId(canonical(this.userInput(latest))) !== inputRevision ||
        (await realpath(ref.cwd).catch(() => undefined)) !== directoryIdentity
      )
        fail("approval_scope_changed", "任务或用户要求已变化，未发送按键。");
    };
    // No I/O here: this runs after the final native read, immediately before keys.
    const assertCurrent = () => {
      const latest = this.scope(task, participant, screen, actor, context)?.task;
      if (!latest || stableId(canonical(this.userInput(latest))) !== inputRevision)
        fail("approval_scope_changed", "任务或用户要求已变化，未发送按键。");
    };
    const key = selection.candidateId.slice(4);
    if (
      !selection.candidateId.startsWith("key:") ||
      !candidates.some((c) => c.id === selection.candidateId)
    )
      return "manual";
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
      save();
      this.ports.logger.info("原生菜单选择已执行并回读", {
        event: "approval.automatic_completed",
        taskId: task.id,
        participantId: participant.id,
        source: selection.source,
        candidateId: selection.candidateId,
        confidence: selection.jev.confidence,
      });
      return "handled";
    } catch (error) {
      decision.state = isNotExecuted(error) ? "failed" : "uncertain";
      decision.error = safeError(error).code;
      save();
      this.ports.logger.warn("原生菜单选择未完成", {
        event: "approval.automatic_failed",
        taskId: task.id,
        participantId: participant.id,
        code: decision.error,
        outcome: decision.state,
      });
      return "manual";
    }
  }
}
