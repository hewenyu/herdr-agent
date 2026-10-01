import type {
  Dispatch,
  OrchestrationEvent,
  SettledTaskOutput,
  TaskOrchestratorOptions,
} from "../app/task-orchestrator.js";
import { fail, safeError } from "../core/errors.js";
import { newId, now, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { ActorContext, StoredMessage, Task } from "../core/types.js";
import { verificationConfigRevision } from "../projects/verification-config.js";
import {
  implementationNode,
  independentReviewer,
  observeImplementationParticipants,
  rememberImplementer,
  restoreImplementationParticipants,
} from "./authorship.js";
import { inspectArtifact, latestArtifacts, publishBoard } from "./board.js";
import { type WorkflowCandidate, workflowCandidates } from "./candidates.js";
import { assertCodeDelivery } from "./code-delivery.js";
import { assertConsensusDocuments } from "./consensus.js";
import { type DecisionLog, linkDecisionDispatches } from "./decision-log.js";
import { validateDocumentPaths } from "./document-delivery.js";
import { assertDocumentSource, prepareDocumentSource } from "./document-source.js";
import { legacyAssignment, prepareHandoff } from "./handoff.js";
import { runWorkflowLeaderStepFor } from "./leader-policy.js";
import { choosePlan } from "./plan-selection.js";
import { selectedReceiptRepair } from "./receipt-dispatch.js";
import { reportContract } from "./report.js";
import {
  assistanceFingerprint,
  awaitingEvidence,
  deferAssistance,
  prepareUserDecision,
  receiptRepairRule,
} from "./selection-context.js";
import { settleWorkflow } from "./settlement.js";
import { invalidateFrom, markIssuesForRevalidation, readyNodes, workflowState } from "./state.js";
import { VerificationRunner } from "./verify.js";
import { WORKFLOWS, type WorkflowState } from "./workflow.js";
import { workspaceAvailable, workspaceRevision } from "./workspace.js";

export interface WorkflowPorts extends TaskOrchestratorOptions {
  current(id: string): Task | undefined;
  foregroundPending(task: Task): boolean;
  revision(task: Task): string;
  baseRevision(task: Task): string;
  userMessages(task: Task): StoredMessage[];
  events(id: string): OrchestrationEvent[];
  outputs(id: string): SettledTaskOutput[];
  save(event: OrchestrationEvent): void;
  assertCurrent(event: OrchestrationEvent): Task;
  reconcile(event: OrchestrationEvent): void;
  notify(task: Task, event: OrchestrationEvent): Promise<void>;
  attention(task: Task, event: OrchestrationEvent): Promise<void>;
  recoverNotification(task: Task, event: OrchestrationEvent): Promise<void>;
}

const workspaceReady = (task: Task): boolean =>
  task.directoryMode !== "worktree" || task.worktreeReady;

const sameWorkspace = (left: Task, right: Task): boolean =>
  left.directoryMode === right.directoryMode &&
  left.worktreeReady === right.worktreeReady &&
  JSON.stringify(left.directories) === JSON.stringify(right.directories);

/** A workflow policy over the existing events/dispatches, not another execution queue. */
export class WorkflowOrchestrator {
  private readonly admission = new KeyedMutex();
  private readonly verification?: VerificationRunner;
  constructor(private readonly ports: WorkflowPorts) {
    if (ports.config && ports.projects)
      this.verification = new VerificationRunner({
        store: ports.store,
        stateDir: ports.config.stateDir,
        projects: ports.projects,
      });
  }

  private save(state: WorkflowState): void {
    this.ports.store.set(WORKFLOWS, state.taskId, state);
  }

  private assertWorkspace(task: Task, event: OrchestrationEvent): Task {
    const current = this.ports.assertCurrent(event);
    if (!workspaceReady(current) || !sameWorkspace(task, current))
      fail("orchestration_deferred", "任务工作目录尚未就绪或已变化，等待最新目录状态后继续。");
    return current;
  }
  private actor(task: Task, eventId: string): ActorContext {
    const { ownerId, entryChatId, chatId, id } = task;
    return {
      source: "system",
      ownerId,
      chatId: chatId ?? entryChatId,
      sessionId: `orchestration:${id}`,
      taskId: id,
      messageId: eventId,
    };
  }
  private event(task: Task, outputIds: string[], suffix = "decision"): OrchestrationEvent {
    const userRevision = this.ports.revision(task);
    const id = `orchestrate:${stableId(task.id, suffix, userRevision, ...outputIds)}`;
    return (
      this.ports.store.get<OrchestrationEvent>("task_orchestration_events", id) ?? {
        id,
        taskId: task.id,
        trigger: outputIds.length ? "output" : "ready",
        outputIds,
        userRevision,
        state: "pending",
        attempts: 0,
        dispatches: [],
        createdAt: now(),
        updatedAt: now(),
      }
    );
  }
  private commands(task: Task): string[] {
    const workflow = this.ports.store.get<WorkflowState>(WORKFLOWS, task.id);
    if (workflow?.plan.validation?.mode === "not_run") return [];
    return task.kind !== "discussion" && task.project && this.ports.projects
      ? (this.ports.projects.get(task.project).verify ?? [])
      : [];
  }

  private configRevision(task: Task): string | undefined {
    if (!task.project || !this.ports.projects) return undefined;
    return verificationConfigRevision(this.ports.projects.get(task.project));
  }

  async admit<T>(task: Task, access: "read" | "write", run: () => Promise<T>): Promise<T> {
    return this.admission.run("directories", async () => {
      if (
        !(await workspaceAvailable(
          this.ports.store,
          task,
          access,
          this.verification?.blockingDirectories() ?? [],
        ))
      )
        fail("workspace_busy", "同目录另一个任务仍在执行或结果待核验，等待其结束。");
      return run();
    });
  }

  async assertDelivery(task: Task, state: WorkflowState): Promise<void> {
    await assertDocumentSource(this.ports.store, task, state);
    restoreImplementationParticipants(this.ports.store, state);
    const artifactRevision = await workspaceRevision(task.directories);
    const missing = reportContract(
      state,
      artifactRevision,
      this.commands(task),
      this.configRevision(task),
    );
    if (missing.length) fail("workflow_report", missing.join("；"));
    await assertConsensusDocuments(task, state, artifactRevision);
    for (const artifact of latestArtifacts(state, artifactRevision)) {
      const current = await inspectArtifact(task, artifact.path);
      if (current.hash !== artifact.hash) fail("workflow_artifact", "交付产物已变化或失效。");
    }
    await assertCodeDelivery(task, state);
  }

  async process(task: Task): Promise<void> {
    const { ports } = this;
    if (!ports.config) fail("workflow_config", "工作流缺少本地配置。");
    const current = ports.current(task.id);
    if (!current || !workspaceReady(current)) return;
    task = current;
    const participants = ports
      .tasks()
      .records.participants(task)
      .filter((entry) => entry.status !== "removed");
    if (task.pending || ports.foregroundPending(task)) return;
    const state = workflowState(
      ports.store,
      { ...task, participantIds: participants.map((entry) => entry.id) },
      ports.baseRevision(task),
    );
    await observeImplementationParticipants(ports.store, task, state, participants);
    const events = ports.events(task.id);
    for (const event of events) {
      await ports.recoverNotification(task, event);
      if (
        event.dispatches.some((entry) => ["pending", "uncertain"].includes(entry.state)) ||
        event.state === "processing"
      )
        ports.reconcile(event);
      if (
        event.userRevision !== ports.revision(task) &&
        !event.dispatches.some((entry) => entry.state === "uncertain")
      ) {
        if (event.state !== "done") {
          event.state = "superseded";
          ports.save(event);
        }
        continue;
      }
      if (event.state === "attention") {
        await ports.attention(task, event);
        return;
      }
      if (event.state === "done" && event.decision && !event.notified) {
        try {
          if (task.promptVersion === 3 && event.decision.action === "wait") {
            const request = await prepareUserDecision(
              ports,
              task,
              state,
              event,
              event.workflow?.candidate.description ?? "工作流等待用户决定。",
            );
            event.decision.reason = request.text;
            ports.save(event);
          }
          await ports.notify(task, event);
        } catch (error) {
          const safe = safeError(error);
          if (event.decision.action === "wait" && safe.code === "workflow_artifact_changed") {
            event.state = "superseded";
            ports.save(event);
            continue;
          }
          if (
            ![
              "workflow_report",
              "workflow_artifact",
              "workflow_document_scope",
              "workflow_consensus",
            ].includes(safe.code)
          )
            throw error;
          // An old frozen delivery may fail the repaired evidence contract on restart.
          // Make that visible instead of retrying the same invalid report every tick.
          event.state = "attention";
          event.error = safe;
          ports.save(event);
          await ports.attention(task, event);
          return;
        }
      }
      if (
        event.decision?.action === "deliver" &&
        event.notified &&
        event.decision.reportId === state.report?.id
      ) {
        state.phase = "awaiting_acceptance";
        this.save(state);
        return;
      }
    }
    if (!ports.current(task.id)) return;
    // A new requirement invalidates the plan only after old native work is settled.
    if (state.userRevision !== ports.baseRevision(task)) {
      if (
        participants.some(
          (entry) =>
            entry.status === "working" || ports.store.get("participant_awaiting_output", entry.id),
        )
      )
        return;
      state.userRevision = ports.baseRevision(task);
      markIssuesForRevalidation(state);
      state.plan.version++;
      state.planning = "needed";
      state.planningReason = "用户要求或任务配置修订，旧计划输入已失效。";
      state.phase = "planning";
      state.report = undefined;
      state.assistanceWait = undefined;
      state.userDecision = undefined;
      state.stall = { open: [], unchanged: 0, awaitingUser: false };
      state.nodes = Object.fromEntries(
        state.plan.nodes.map((node) => [node.id, { status: "pending", attempt: 0 }]),
      );
      this.save(state);
    }
    if (state.phase === "awaiting_acceptance") return;
    // A Leader-committed, unapplied action resumes here before any new decision.
    const pending = events.find(
      (event) =>
        !!event.workflow &&
        !event.workflow.applied &&
        event.state === "pending" &&
        // A committed action whose revision changed is superseded below.
        (event.userRevision === ports.revision(task) || !!event.decision?.candidateId),
    );
    if (pending) {
      if (pending.nextAttemptAt && Date.parse(pending.nextAttemptAt) > Date.now()) return;
      // Count every execution attempt once, including successful retries after restart.
      pending.attempts++;
      pending.state = "processing";
      ports.save(pending);
      await this.executeSafely(task, state, pending);
      return;
    }
    if (state.planning === "needed") {
      await this.plan(task, state);
      return;
    }
    const activePhase = state.plan.nodes.find(
      (node) => state.nodes[node.id]?.status === "dispatched",
    )?.phase;
    if (activePhase && state.phase !== activePhase) {
      state.phase = activePhase;
      this.save(state);
    }
    await settleWorkflow(ports, task, state, participants, this.commands(task));
    if (Object.values(state.nodes).some((entry) => entry.status === "dispatched")) return;
    if (
      events.some(
        (event) =>
          event.userRevision === ports.revision(task) &&
          event.state === "done" &&
          ["wait", "deliver"].includes(event.decision?.action ?? ""),
      )
    )
      return;
    const ready = readyNodes(state);
    const nextPhase = ready[0]?.phase;
    if (nextPhase && state.phase !== nextPhase) {
      state.phase = nextPhase;
      this.save(state);
    }
    const artifactRevision = await workspaceRevision(task.directories);
    const validation = state.plan.nodes.find((node) => node.phase === "validating");
    if (
      validation &&
      state.nodes[validation.id]?.status === "completed" &&
      this.commands(task).some(
        (command) =>
          !state.evidence.some(
            (item) =>
              item.source === "configured_command" &&
              item.command === command &&
              item.configRevision === this.configRevision(task) &&
              item.artifactRevision === artifactRevision &&
              item.result === "passed",
          ),
      )
    ) {
      invalidateFrom(state, validation.id);
      state.phase = validation.phase;
      this.save(state);
      return;
    }
    // Changes after validation invalidate downstream evidence instead of reusing it.
    const stale = state.plan.nodes.find(
      (node) =>
        node.role === "reviewer" &&
        state.nodes[node.id]?.status === "completed" &&
        state.nodes[node.id]?.artifactRevision !== artifactRevision,
    );
    if (stale) {
      invalidateFrom(state, stale.id);
      state.phase = stale.phase;
      this.save(state);
      return;
    }
    let verify =
      this.verification &&
      ready.some((node) => node.phase === "validating") &&
      this.commands(task).length
        ? this.verification.candidates(task, artifactRevision)
        : [];
    verify = verify.filter(
      (candidate) =>
        !state.evidence.some(
          (item) =>
            item.verificationId &&
            item.artifactRevision === artifactRevision &&
            this.verification
              ?.list(task.id)
              .some(
                (run) =>
                  run.id === item.verificationId &&
                  run.commandIndex === candidate.commandIndex &&
                  run.configRevision === candidate.configRevision &&
                  run.status === "passed",
              ),
        ),
    );
    const complete =
      reportContract(state, artifactRevision, this.commands(task), this.configRevision(task))
        .length === 0;
    let candidates = workflowCandidates(task, state, participants, verify, complete);
    const checked: WorkflowCandidate[] = [];
    for (const candidate of candidates) {
      if (["user", "replan", "add_reviewer"].includes(candidate.kind)) {
        checked.push(candidate);
        continue;
      }
      const access =
        candidate.kind === "verify" ||
        candidate.assignments?.some(
          (assignment) =>
            state.plan.nodes.find((node) => node.id === assignment.nodeId)?.access === "write",
        )
          ? "write"
          : "read";
      if (
        await workspaceAvailable(
          ports.store,
          task,
          access,
          this.verification?.blockingDirectories() ?? [],
        )
      )
        checked.push(candidate);
    }
    candidates = checked;
    if (!candidates.length) return;
    const event = this.event(
      task,
      state.consumedOutputs,
      `decision:${stableId(JSON.stringify(state.nodes), JSON.stringify(state.evidence), artifactRevision, this.configRevision(task) ?? "", ...verify.flatMap((candidate) => (candidate.retryOf ? [candidate.retryOf] : [])))}`,
    );
    if (event.state === "done" || event.state === "superseded" || event.state === "attention")
      return;
    if (event.nextAttemptAt && Date.parse(event.nextAttemptAt) > Date.now()) return;
    const fingerprint =
      task.promptVersion === 3
        ? await assistanceFingerprint(
            ports,
            task,
            state,
            event,
            this.configRevision(task),
            candidates,
          )
        : "";
    if (awaitingEvidence(this.ports, state, fingerprint)) return;
    event.attempts++;
    event.state = "processing";
    ports.save(event);
    try {
      const repair =
        task.promptVersion === 3
          ? receiptRepairRule(ports.store, state, candidates, event.userRevision, artifactRevision)
          : undefined;
      if (repair?.noProgress) fail("workflow_receipt_no_progress", repair.diagnostic);
      const previous = event.selectionLogId
        ? ports.store.get<DecisionLog>("workflow_decisions", event.selectionLogId)
        : undefined;
      // Local deferrals refund retries, but each selection keeps immutable evidence.
      if (previous?.state !== "selected")
        event.selectionLogId = `${event.id}:selection:${newId("attempt")}`;
      ports.save(event);
      const selection = await runWorkflowLeaderStepFor({
        ports,
        actor: this.actor(task, event.id),
        task,
        state,
        event,
        candidates,
        participants,
        artifactRevision,
        ...(repair ? { repair: { candidateId: repair.candidateId, reason: repair.reason } } : {}),
      });
      ports.assertCurrent(event);
      if ("deferred" in selection && selection.deferred) {
        const request = await prepareUserDecision(ports, task, state, event, selection.reason);
        deferAssistance(ports, state, event, fingerprint, request.text);
        return;
      }
      // A committed Leader action already lives on the event; it is never
      // re-decided. The frozen v2 chooser records its decision here.
      const candidate =
        event.workflow?.candidate ?? candidates.find((entry) => entry.id === selection.candidateId);
      if (!candidate) fail("workflow_selection", "本步没有得到合法选择，保留原候选等待恢复。");
      if (!event.workflow) {
        const action =
          candidate.kind === "deliver"
            ? "deliver"
            : candidate.kind === "user"
              ? "wait"
              : "continue";
        event.workflow = { candidate, planVersion: state.plan.version, artifactRevision };
        event.decision = {
          action,
          reason: candidate.kind === "user" ? candidate.description : selection.reason,
          candidateId: candidate.id,
          source: selection.source,
          ...(candidate.kind === "deliver"
            ? { reportId: state.report?.id, outputId: state.report?.outputId }
            : {}),
        };
        ports.save(event);
      }
      await this.executeSafely(task, state, event);
    } catch (error) {
      await this.failed(task, event, error);
    }
  }

  private async plan(task: Task, state: WorkflowState): Promise<void> {
    const current = this.ports.current(task.id);
    if (!current || !workspaceReady(current) || !sameWorkspace(task, current)) return;
    const event = this.event(task, [], `plan:${state.plan.version}`);
    if (event.state === "attention") {
      await this.ports.attention(task, event);
      return;
    }
    if (event.nextAttemptAt && Date.parse(event.nextAttemptAt) > Date.now()) return;
    const fingerprint =
      task.promptVersion === 3
        ? await assistanceFingerprint(this.ports, task, state, event, this.configRevision(task))
        : "";
    if (awaitingEvidence(this.ports, state, fingerprint)) return;
    event.attempts++;
    this.ports.save(event);
    try {
      const plan = await choosePlan(
        { ...this.ports, assertCurrent: (selected) => this.assertWorkspace(task, selected) },
        task,
        state,
        event,
      );
      task = this.assertWorkspace(task, event);
      const next: WorkflowState = { ...state, plan };
      if (task.promptVersion === 3 && task.kind === "discussion")
        next.documentSource = await prepareDocumentSource(this.ports.store, task, next);
      else if (next.documentSource) await assertDocumentSource(this.ports.store, task, next);
      this.assertWorkspace(task, event);
      next.phase = plan.nodes[0]?.phase ?? "planning";
      next.nodes = Object.fromEntries(
        plan.nodes.map((node) => [node.id, { status: "pending", attempt: 0 }]),
      );
      next.planning = "ready";
      next.error = undefined;
      const acceptedEvent = { ...event, state: "done" as const, notified: true };
      this.ports.store.transaction(() => {
        const key = `${task.id}:${plan.version}`;
        if (this.ports.store.get("workflow_plans", key))
          fail("workflow_plan_version", "计划版本已经冻结，不能覆盖。");
        this.ports.store.set("workflow_plans", key, {
          taskId: task.id,
          plan,
          userRevision: state.userRevision,
          reason: state.planningReason ?? "首次根据用户要求实例化计划。",
          at: now(),
        });
        this.save(next);
        this.ports.save(acceptedEvent);
      });
      Object.assign(state, next);
      Object.assign(event, acceptedEvent);
      await publishBoard(this.ports.config?.stateDir ?? "", task, state);
    } catch (error) {
      const safe = safeError(error);
      if (safe.code === "workflow_assistance_deferred") {
        try {
          const request = await prepareUserDecision(this.ports, task, state, event, safe.message);
          deferAssistance(this.ports, state, event, fingerprint, request.text);
        } catch (recoveryError) {
          await this.failed(task, event, recoveryError);
        }
      } else await this.failed(task, event, error);
    }
  }

  private async executeSafely(
    task: Task,
    state: WorkflowState,
    event: OrchestrationEvent,
  ): Promise<void> {
    try {
      await this.execute(task, state, event);
    } catch (error) {
      await this.failed(task, event, error);
    }
  }

  private async execute(
    task: Task,
    state: WorkflowState,
    event: OrchestrationEvent,
  ): Promise<void> {
    const { ports } = this;
    this.assertWorkspace(task, event);
    const candidate = event.workflow?.candidate;
    if (!candidate || !event.workflow || event.workflow.applied) return;
    if (
      !event.dispatches.length &&
      event.workflow.artifactRevision &&
      event.workflow.artifactRevision !== (await workspaceRevision(task.directories))
    )
      fail("workflow_artifact_changed", "选择后代码版本已变化，请按当前事实重新选择。");
    if (candidate.kind === "dispatch" || candidate.kind === "rework") {
      await this.admission.run("directories", async () => {
        const access = candidate.assignments?.some(
          (item) => state.plan.nodes.find((node) => node.id === item.nodeId)?.access === "write",
        )
          ? "write"
          : "read";
        if (
          !(await workspaceAvailable(
            ports.store,
            task,
            access,
            this.verification?.blockingDirectories() ?? [],
          ))
        ) {
          // Directory admission only waits; polling must not consume failure retries.
          event.attempts--;
          event.state = "pending";
          ports.save(event);
          return;
        }
        this.assertWorkspace(task, event);
        if (!event.dispatches.length) {
          const artifactRevision = await workspaceRevision(task.directories);
          for (const assignment of candidate.assignments ?? []) {
            const node = state.plan.nodes.find((entry) => entry.id === assignment.nodeId);
            if (!node) fail("workflow_node", "派发节点不存在。");
            if (node.documentPaths?.length) {
              await validateDocumentPaths(task, node.documentPaths);
            }
            const repair = await selectedReceiptRepair(
              ports.store,
              task,
              state,
              event,
              assignment,
              artifactRevision,
            );
            if (candidate.kind === "rework") invalidateFrom(state, node.id);
            const progress = state.nodes[node.id];
            if (progress) progress.repair = repair;
            const operationId = `${task.id}:workflow:${stableId(event.id, node.id, assignment.participantId)}`;
            const identity = { nodeId: node.id, operationId, inputRevision: event.userRevision };
            const userMessages = ports.userMessages(task).map((entry) => entry.text);
            const text =
              task.promptVersion === 3
                ? await prepareHandoff(
                    ports.config?.stateDir ?? "",
                    task,
                    state,
                    candidate.kind === "rework"
                      ? {
                          ...node,
                          instruction: `${node.instruction}\n\n本次需修正：${candidate.description}`,
                        }
                      : node,
                    identity,
                    userMessages,
                    repair,
                  )
                : legacyAssignment(task, state, node, identity, userMessages);
            const sourceRevision = node.documentPaths?.length
              ? await workspaceRevision(task.directories, node.documentPaths)
              : undefined;
            event.dispatches.push({
              operationId,
              participantId: assignment.participantId,
              nodeId: node.id,
              text,
              inputRevision: event.userRevision,
              artifactRevision,
              sourceRevision,
              state: "pending",
            });
          }
          ports.store.transaction(() => {
            this.save(state);
            ports.save(event);
          });
        }
        for (const dispatch of event.dispatches) await this.dispatch(task, state, event, dispatch);
        if (event.workflow) event.workflow.applied = true;
        ports.reconcile(event);
      });
      if (!event.workflow.applied) return;
    } else if (candidate.kind === "verify") {
      if (!this.verification || !candidate.verification)
        fail("workflow_verify", "验证执行器不可用。");
      const admitted = await this.admission.run("directories", async () => {
        this.assertWorkspace(task, event);
        if (
          !(await workspaceAvailable(
            ports.store,
            task,
            "write",
            this.verification?.blockingDirectories() ?? [],
          ))
        )
          return;
        this.assertWorkspace(task, event);
        // run() synchronously reserves its durable record before spawning the configured command.
        return { running: this.runVerification(task, state, event) };
      });
      if (!admitted) {
        event.attempts--;
        event.state = "pending";
        ports.save(event);
        return;
      }
      await admitted.running;
      event.workflow.applied = true;
    } else if (candidate.kind === "replan") {
      // Agent replanning changes structure, not user inputs: current issues remain binding.
      state.plan.version++;
      state.planning = "needed";
      state.planningReason = event.decision?.reason ?? candidate.description;
      state.report = undefined;
      this.save(state);
      event.workflow.applied = true;
    } else if (candidate.kind === "add_reviewer") {
      const first = ports.tasks().records.participants(task)[0];
      await ports
        .tasks()
        .addParticipant(
          this.actor(task, event.id),
          task.id,
          { kind: first?.kind === "claude" ? "codex" : "claude", role: "独立评审者" },
          () => {
            ports.assertCurrent(event);
          },
        );
      // Adding an authorized role is a mutation, not a new user requirement.
      state.userRevision = ports.baseRevision(
        ports.tasks().records.get(this.actor(task, event.id), task.id),
      );
      this.save(state);
      event.workflow.applied = true;
    } else if (candidate.kind === "deliver") {
      await this.assertDelivery(task, state);
      event.workflow.applied = true;
    } else {
      if (task.promptVersion === 3 && candidate.kind === "user") {
        const request = await prepareUserDecision(ports, task, state, event, candidate.description);
        this.assertWorkspace(task, event);
        if (event.decision) event.decision.reason = request.text;
      }
      event.workflow.applied = true;
    }
    event.state = "done";
    event.error = undefined;
    ports.save(event);
    linkDecisionDispatches(ports.store, event.selectionLogId ?? event.id, event.dispatches);
    await ports.notify(task, event);
    if (task.promptVersion === 3 && event.decision?.action === "deliver" && event.notified) {
      state.phase = "awaiting_acceptance";
      this.save(state);
    }
  }

  private async dispatch(
    task: Task,
    state: WorkflowState,
    event: OrchestrationEvent,
    dispatch: Dispatch,
  ): Promise<void> {
    if (dispatch.state === "sent") return;
    if (!dispatch.nodeId || !dispatch.text || !dispatch.inputRevision)
      fail("workflow_dispatch", "派发缺少已保存任务书。");
    this.assertWorkspace(task, event);
    const node = state.plan.nodes.find((entry) => entry.id === dispatch.nodeId);
    if (
      node?.documentPaths?.length &&
      state.plan.nodes.some(
        (entry) => entry.role === "reviewer" && entry.participantId === dispatch.participantId,
      )
    )
      fail("workflow_document_roles", "文档委派与固定评审者冲突，请核对参与者分工后重规划。");
    if (
      state.documentSource ||
      state.plan.documentDelivery ||
      (task.promptVersion === 3 && task.kind === "discussion")
    )
      await assertDocumentSource(this.ports.store, task, state);
    if (
      node?.documentPaths?.length &&
      dispatch.sourceRevision !== (await workspaceRevision(task.directories, node.documentPaths))
    )
      fail(
        "workflow_document_scope",
        "文档委派等待期间授权范围之外的文件已变化，需核对后重新派发。",
      );
    if (node?.role === "reviewer" && !independentReviewer(state, dispatch.participantId))
      fail("workflow_review_author", "该评审委派属于历史实现者，请重新安排独立评审。");
    if (node && implementationNode(node)) rememberImplementer(state, dispatch.participantId);
    const old = state.nodes[dispatch.nodeId];
    const repair = await selectedReceiptRepair(
      this.ports.store,
      task,
      state,
      event,
      { nodeId: dispatch.nodeId, participantId: dispatch.participantId },
      dispatch.artifactRevision,
    );
    state.nodes[dispatch.nodeId] = {
      status: "dispatched",
      attempt: (old?.attempt ?? 0) + 1,
      operationId: dispatch.operationId,
      participantId: dispatch.participantId,
      inputRevision: dispatch.inputRevision,
      artifactRevision: dispatch.artifactRevision,
      sourceRevision: dispatch.sourceRevision,
      ...(repair ? { repair } : {}),
    };
    this.save(state);
    dispatch.state = "pending";
    this.ports.save(event);
    try {
      await this.ports.tasks().send(
        this.actor(task, event.id),
        task.id,
        dispatch.participantId,
        dispatch.text,
        () => {
          this.assertWorkspace(task, event);
        },
        dispatch.operationId,
      );
      dispatch.state = "sent";
      this.ports.save(event);
    } catch (error) {
      this.ports.reconcile(event);
      throw error;
    }
  }

  private async runVerification(
    task: Task,
    state: WorkflowState,
    event: OrchestrationEvent,
  ): Promise<void> {
    const candidate = event.workflow?.candidate.verification;
    if (!candidate || !this.verification) fail("workflow_verify", "缺少验证候选。");
    const cancellation = new AbortController();
    let interrupted: unknown;
    let invalidated = false;
    const inputsCurrent = () => {
      // Pause and shutdown prevent new effects, but still permit unchanged-input failure audit.
      const current = this.ports.store.get<Task>("tasks", task.id);
      return (
        !!current &&
        workspaceReady(current) &&
        sameWorkspace(task, current) &&
        this.ports.revision(current) === event.userRevision
      );
    };
    const monitor = () => {
      try {
        if (!inputsCurrent()) {
          invalidated = true;
          cancellation.abort();
        }
        this.assertWorkspace(task, event);
      } catch (error) {
        interrupted ??= error;
        cancellation.abort();
      }
    };
    const timer = setInterval(monitor, 100);
    timer.unref();
    try {
      const run = await this.verification.run(
        task,
        candidate,
        AbortSignal.any([this.ports.signal, cancellation.signal]),
        monitor,
      );
      if (run.status === "unknown")
        fail("workflow_verify_unknown", "验证执行状态尚未确认；保留目录阻塞，不能自动重跑。");
      const cancelled = run.status === "cancelled" && run.exitConfirmed;
      // Lifecycle cancellation keeps failed evidence; workspace/revision invalidation does not.
      // Either cancelled run may be selected again through its existing retryOf identity.
      if (cancelled) {
        if (invalidated || !inputsCurrent()) return;
      } else {
        if (interrupted) throw interrupted;
        this.assertWorkspace(task, event);
      }
      const after = await workspaceRevision(task.directories);
      if (cancelled) {
        if (invalidated || !inputsCurrent()) return;
      } else {
        if (interrupted) throw interrupted;
        this.assertWorkspace(task, event);
      }
      const result =
        run.status === "passed" && after === candidate.artifactRevision ? "passed" : "failed";
      if (!state.evidence.some((entry) => entry.verificationId === run.id))
        state.evidence.push({
          id: run.id,
          source: "configured_command",
          description: `${run.command}：${run.status}${after !== candidate.artifactRevision ? "；执行期间代码变化" : ""}`,
          command: run.command,
          result,
          artifactRevision: candidate.artifactRevision,
          verificationId: run.id,
          configRevision: run.configRevision,
        });
      const id = `verify-${candidate.commandIndex}`;
      const existing = state.issues.find(
        (issue) =>
          issue.raisedBy === "myrix" &&
          (issue.verificationCommandIndex === candidate.commandIndex ||
            (issue.verificationCommandIndex === undefined && issue.id === id)),
      );
      if (result === "passed" && existing) {
        existing.status = "resolved";
        existing.planVersion = state.plan.version;
        existing.needsRevalidation = false;
        existing.description = `${run.command} 已取得当前版本成功证据。`;
        existing.evidenceRefs.push(run.id);
      } else if (result !== "passed") {
        const issue = {
          id:
            existing?.id ?? (state.issues.some((issue) => issue.id === id) ? newId("verify") : id),
          verificationCommandIndex: candidate.commandIndex,
          planVersion: state.plan.version,
          needsRevalidation: false,
          status: "open" as const,
          blocking: true,
          description: `${run.command} 未取得当前版本成功证据。`,
          evidenceRefs: [run.id],
          raisedBy: "myrix",
          responses: [],
        };
        if (existing) Object.assign(existing, issue);
        else state.issues.push(issue);
      }
      this.save(state);
    } finally {
      clearInterval(timer);
    }
  }

  private async failed(task: Task, event: OrchestrationEvent, error: unknown): Promise<void> {
    const safe = safeError(error);
    event.error = safe;
    if (
      [
        "workflow_verify_unknown",
        "workflow_document_scope",
        "workflow_document_roles",
        "workflow_report",
        "workflow_consensus",
        "workflow_artifact",
        "workflow_plan_no_progress",
        "workflow_receipt_no_progress",
        // A typed context overflow is not a retryable model failure: retrying
        // the same unchanged activation cannot succeed and must stay visible.
        "context_budget",
        "orchestration_context_budget",
      ].includes(safe.code) ||
      safe.outcome === "unknown" ||
      event.dispatches.some((entry) => entry.state === "uncertain")
    )
      event.state = "attention";
    else if (
      ["orchestration_superseded", "workflow_artifact_changed"].includes(safe.code) ||
      !this.ports.current(task.id)
    )
      event.state = "superseded";
    else if (["orchestration_deferred", "stopping", "cancelled"].includes(safe.code)) {
      // These local guards prove the deferred step never crossed its effect boundary.
      event.state = event.workflow?.applied ? "done" : "pending";
      if (!event.workflow?.applied) event.attempts = Math.max(0, event.attempts - 1);
      event.nextAttemptAt = undefined;
    } else if (event.attempts >= 3) event.state = "attention";
    else {
      event.state = "pending";
      event.nextAttemptAt = new Date(Date.now() + (this.ports.retryDelayMs ?? 2000)).toISOString();
    }
    this.ports.save(event);
    if (event.state === "attention") await this.ports.attention(task, event);
  }
}
