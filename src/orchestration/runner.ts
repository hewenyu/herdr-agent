import type {
  Dispatch,
  OrchestrationEvent,
  SettledTaskOutput,
  TaskOrchestratorOptions,
} from "../app/task-orchestrator.js";
import { fail, safeError } from "../core/errors.js";
import { newId, now, stableId } from "../core/ids.js";
import { KeyedMutex } from "../core/mutex.js";
import type { ActorContext, Participant, StoredMessage, Task } from "../core/types.js";
import { verificationConfigRevision } from "../projects/verification-config.js";
import type { InputDelivery } from "../tasks/input-delivery.js";
import {
  implementationNode,
  independentReviewer,
  observeImplementationParticipants,
  rememberImplementer,
  restoreImplementationParticipants,
} from "./authorship.js";
import { inspectArtifact, publishBoard, publishOutput } from "./board.js";
import { type WorkflowCandidate, workflowCandidates } from "./candidates.js";
import { type DecisionLog, linkDecisionDispatches, saveDecisionLog } from "./decision-log.js";
import { planWorkflow } from "./planner.js";
import { selectWorkflowCandidate } from "./policy.js";
import { publishReport, reportContract } from "./report.js";
import {
  countSettledBatch,
  invalidateFrom,
  mergeStatus,
  readyNodes,
  workflowState,
} from "./state.js";
import { parseStatusBlock, statusInstructions, statusOperationId } from "./status-block.js";
import { VerificationRunner } from "./verify.js";
import { WORKFLOWS, type WorkflowState } from "./workflow.js";
import { workspaceAvailable, workspaceRevision } from "./workspace.js";

interface WorkflowPorts extends TaskOrchestratorOptions {
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
  private actor(task: Task, eventId: string): ActorContext {
    return {
      source: "system",
      ownerId: task.ownerId,
      chatId: task.chatId ?? task.entryChatId,
      sessionId: `orchestration:${task.id}`,
      taskId: task.id,
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
    if (
      this.ports.store.get<WorkflowState>(WORKFLOWS, task.id)?.plan.validation?.mode === "not_run"
    )
      return [];
    return task.kind !== "discussion" && task.project && this.ports.projects
      ? (this.ports.projects.get(task.project).verify ?? [])
      : [];
  }

  private configRevision(task: Task): string | undefined {
    return task.project && this.ports.projects
      ? verificationConfigRevision(this.ports.projects.get(task.project))
      : undefined;
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
    restoreImplementationParticipants(this.ports.store, state);
    const missing = reportContract(
      state,
      await workspaceRevision(task.directories),
      this.commands(task),
      this.configRevision(task),
    );
    if (missing.length) fail("workflow_report", missing.join("；"));
    for (const artifact of state.artifacts) {
      if (artifact.artifactRevision !== state.report?.artifactRevision) continue;
      const current = await inspectArtifact(task, artifact.path);
      if (current.hash !== artifact.hash) fail("workflow_artifact", "交付产物已变化或失效。");
    }
  }

  async process(task: Task): Promise<void> {
    const { ports } = this;
    if (!ports.config) fail("workflow_config", "工作流缺少本地配置。");
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
          await ports.notify(task, event);
        } catch (error) {
          const safe = safeError(error);
          if (!["workflow_report", "workflow_artifact"].includes(safe.code)) throw error;
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
      state.plan.version++;
      state.planning = "needed";
      state.planningReason = "用户要求或任务配置修订，旧计划输入已失效。";
      state.phase = "planning";
      state.report = undefined;
      state.stall = { open: [], unchanged: 0, awaitingUser: false };
      state.nodes = Object.fromEntries(
        state.plan.nodes.map((node) => [node.id, { status: "pending", attempt: 0 }]),
      );
      this.save(state);
    }
    if (state.phase === "awaiting_acceptance") return;
    const pending = events.find(
      (event) =>
        event.workflow &&
        !event.workflow.applied &&
        event.userRevision === ports.revision(task) &&
        event.state === "pending",
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
    await this.settle(task, state, participants);
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
      `decision:${stableId(JSON.stringify(state.nodes), JSON.stringify(state.evidence), artifactRevision, this.configRevision(task) ?? "")}`,
    );
    if (event.state === "done" || event.state === "superseded" || event.state === "attention")
      return;
    if (event.nextAttemptAt && Date.parse(event.nextAttemptAt) > Date.now()) return;
    event.attempts++;
    event.state = "processing";
    ports.save(event);
    try {
      const previous = event.selectionLogId
        ? ports.store.get<DecisionLog>("workflow_decisions", event.selectionLogId)
        : undefined;
      // Local deferrals refund retries, but each selection keeps immutable evidence.
      if (previous?.state !== "selected")
        event.selectionLogId = `${event.id}:selection:${newId("attempt")}`;
      ports.save(event);
      const selection =
        previous?.state === "selected" && previous.revision === event.userRevision && previous.final
          ? { ...previous.final, reason: previous.final.reason }
          : await selectWorkflowCandidate({
              eventId: event.selectionLogId as string,
              revision: event.userRevision,
              planVersion: state.plan.version,
              templateVersion: state.plan.templateVersion,
              snapshot: {
                goal: state.plan.goal,
                artifactRevision,
                userConstraints: ports.userMessages(task).map((entry) => entry.text),
                phase: state.phase,
                issues: state.issues,
                nodes: state.nodes,
                evidence: state.evidence,
                reportMissing: reportContract(
                  state,
                  artifactRevision,
                  this.commands(task),
                  this.configRevision(task),
                ),
              },
              candidates,
              jev: ports.config.jev,
              piModel: ports.config.ai.model,
              engine: ports.engine,
              actor: this.actor(task, event.id),
              signal: ports.signal,
              fetch: ports.fetch,
              assertCurrent: () => {
                ports.assertCurrent(event);
              },
              onLog: (log) => saveDecisionLog(ports.store, log),
            });
      ports.assertCurrent(event);
      const candidate = candidates.find((entry) => entry.id === selection.candidateId);
      if (!candidate) fail("workflow_selection", "本步没有得到合法选择，保留原候选等待恢复。");
      event.workflow = { candidate, planVersion: state.plan.version, artifactRevision };
      event.decision = {
        action:
          candidate.kind === "deliver"
            ? "deliver"
            : candidate.kind === "user"
              ? "wait"
              : "continue",
        reason: candidate.kind === "user" ? candidate.description : selection.reason,
        candidateId: candidate.id,
        source: selection.source,
        ...(candidate.kind === "deliver"
          ? { reportId: state.report?.id, outputId: state.report?.outputId }
          : {}),
      };
      ports.save(event);
      await this.executeSafely(task, state, event);
    } catch (error) {
      await this.failed(task, event, error);
    }
  }

  private async plan(task: Task, state: WorkflowState): Promise<void> {
    const event = this.event(task, [], `plan:${state.plan.version}`);
    if (event.state === "attention") {
      await this.ports.attention(task, event);
      return;
    }
    if (event.nextAttemptAt && Date.parse(event.nextAttemptAt) > Date.now()) return;
    event.attempts++;
    this.ports.save(event);
    try {
      const plan = await planWorkflow({
        task: {
          ...task,
          participantIds: this.ports
            .tasks()
            .records.participants(task)
            .filter((entry) => entry.status !== "removed")
            .map((entry) => entry.id),
        },
        state,
        engine: this.ports.engine,
        actor: this.actor(task, event.id),
        userMessages: this.ports.userMessages(task).map((entry) => entry.text),
        signal: this.ports.signal,
        assertCurrent: () => {
          this.ports.assertCurrent(event);
        },
      });
      state.plan = plan;
      state.phase = plan.nodes[0]?.phase ?? "planning";
      state.nodes = Object.fromEntries(
        plan.nodes.map((node) => [node.id, { status: "pending", attempt: 0 }]),
      );
      state.planning = "ready";
      state.error = undefined;
      event.state = "done";
      event.notified = true;
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
        this.save(state);
        this.ports.save(event);
      });
      await publishBoard(this.ports.config?.stateDir ?? "", task, state);
    } catch (error) {
      await this.failed(task, event, error);
    }
  }

  private async settle(
    task: Task,
    state: WorkflowState,
    participants: Participant[],
  ): Promise<void> {
    let changed = false;
    for (const node of state.plan.nodes) {
      const progress = state.nodes[node.id];
      if (progress?.status !== "dispatched" || !progress.operationId || !progress.inputRevision)
        continue;
      const participant = participants.find((entry) => entry.id === progress.participantId);
      if (
        !participant ||
        !["idle", "done"].includes(participant.status) ||
        participant.error ||
        this.ports.store.get("participant_awaiting_output", participant.id)
      )
        continue;
      const delivery = this.ports.store.get<InputDelivery>(
        "input_deliveries",
        progress.operationId,
      );
      const eligibleOutputs = this.ports
        .outputs(task.id)
        .filter(
          (entry) =>
            entry.participantId === participant.id &&
            !state.consumedOutputs.includes(entry.entry.id) &&
            (entry.sequence ?? 0) > (delivery?.outputSequence ?? 0),
        );
      const output =
        eligibleOutputs.findLast(
          (entry) => statusOperationId(entry.entry.text) === progress.operationId,
        ) ??
        eligibleOutputs.filter((entry) => statusOperationId(entry.entry.text) === undefined).at(-1);
      if (!output || !delivery) continue;
      await publishOutput(
        this.ports.config?.stateDir ?? "",
        task.id,
        output.entry.id,
        output.entry.text,
      );
      try {
        const artifactRevision = await workspaceRevision(task.directories);
        if (progress.artifactRevision !== artifactRevision) {
          // Attribute observed writes conservatively, even if the status block is invalid.
          rememberImplementer(state, participant.id);
          this.save(state);
        }
        const block = parseStatusBlock(output.entry.text, {
          nodeId: node.id,
          operationId: progress.operationId,
          inputRevision: progress.inputRevision,
        });
        if (
          (node.access === "read" || node.role === "reviewer") &&
          progress.artifactRevision !== artifactRevision
        )
          fail(
            "workflow_artifact_changed",
            "执行期间代码版本变化，原评审/读取结果不能证明新版本，需重新核对。",
          );
        const validReferences = new Set([
          ...state.consumedOutputs,
          output.entry.id,
          ...state.evidence.map((entry) => entry.id),
          ...state.artifacts.map((entry) => entry.path),
          ...block.artifactRefs,
        ]);
        if (
          block.issues.some((issue) => issue.evidenceRefs.some((ref) => !validReferences.has(ref)))
        )
          fail("workflow_evidence", "问题引用了不存在或不属于本任务的证据。");
        for (const path of block.artifactRefs) {
          const artifact = await inspectArtifact(task, path);
          state.artifacts.push({
            ...artifact,
            reference: path,
            outputId: output.entry.id,
            artifactRevision,
          });
        }
        mergeStatus(state, node, block, output.entry.id, artifactRevision);
        if (
          node.phase === "validating" &&
          state.plan.validation?.mode !== "not_run" &&
          !this.commands(task).length &&
          !state.evidence.some(
            (entry) =>
              entry.outputId === output.entry.id &&
              entry.source === "agent_review" &&
              entry.result === "passed",
          )
        ) {
          progress.status = "blocked";
          progress.error =
            "未取得独立 agent 实际重跑的证据，请补充检查结果或说明需用户处理的环境阻塞。";
        }
        if (node.phase === "reporting" && state.nodes[node.id]?.status === "completed")
          await publishReport(
            this.ports.config?.stateDir ?? "",
            task,
            state,
            block,
            output.entry.id,
            artifactRevision,
          );
        this.ports.store.set("workflow_status_blocks", output.entry.id, { taskId: task.id, block });
      } catch (error) {
        progress.status = "blocked";
        progress.outputId = output.entry.id;
        progress.error = safeError(error).message;
        if (!state.consumedOutputs.includes(output.entry.id))
          state.consumedOutputs.push(output.entry.id);
      }
      changed = true;
    }
    if (changed) {
      for (const batch of this.ports.events(task.id)) {
        if (
          !batch.workflow?.applied ||
          !batch.dispatches.length ||
          state.batches.includes(batch.id)
        )
          continue;
        if (
          batch.dispatches.every((dispatch) => {
            const progress = dispatch.nodeId ? state.nodes[dispatch.nodeId] : undefined;
            return (
              progress?.operationId === dispatch.operationId &&
              progress.outputId &&
              this.ports.store.get("workflow_status_blocks", progress.outputId)
            );
          })
        )
          countSettledBatch(state, batch.id, this.ports.config?.jev?.stallRounds ?? 3);
      }
      this.save(state);
      await publishBoard(this.ports.config?.stateDir ?? "", task, state);
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
    ports.assertCurrent(event);
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
        ports.assertCurrent(event);
        if (!event.dispatches.length) {
          const artifactRevision = await workspaceRevision(task.directories);
          for (const assignment of candidate.assignments ?? []) {
            const node = state.plan.nodes.find((entry) => entry.id === assignment.nodeId);
            if (!node) fail("workflow_node", "派发节点不存在。");
            if (candidate.kind === "rework") invalidateFrom(state, node.id);
            const operationId = `${task.id}:workflow:${stableId(event.id, node.id, assignment.participantId)}`;
            const text = [
              "本次工作流任务书（原始要求和后续修订优先）：",
              task.requirements,
              ...ports.userMessages(task).map((entry) => entry.text),
              `节点：${node.id}；阶段：${node.phase}`,
              node.instruction,
              `必需交付文件：${JSON.stringify(state.plan.requiredArtifacts ?? [])}。相关节点须在 artifactRefs 中引用准确路径；报告不能以文字替代缺失文件。`,
              ...(state.plan.validation?.mode === "not_run"
                ? [
                    `用户已明确限制验证：${state.plan.validation.userConstraint}。不得执行验证命令；实现节点仍按授权实现，评审节点只作只读复核并将验证证据标记 not_run、说明原因。`,
                  ]
                : []),
              `共享看板：${task.boardDirectory}。完整参与者原文位于 outputs/，请阅读与本节点相关的输入，不能仅依据摘要。`,
              `当前问题与已完成节点：${JSON.stringify({ issues: state.issues, nodes: state.nodes })}`,
              ...(node.phase === "reporting"
                ? [`报告必需章节：${JSON.stringify(state.plan.deliveryRequirements)}`]
                : []),
              statusInstructions({
                nodeId: node.id,
                operationId,
                inputRevision: event.userRevision,
              }),
            ].join("\n\n");
            event.dispatches.push({
              operationId,
              participantId: assignment.participantId,
              nodeId: node.id,
              text,
              inputRevision: event.userRevision,
              artifactRevision,
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
        ports.assertCurrent(event);
        if (
          !(await workspaceAvailable(
            ports.store,
            task,
            "write",
            this.verification?.blockingDirectories() ?? [],
          ))
        )
          return;
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
    } else event.workflow.applied = true;
    event.state = "done";
    event.error = undefined;
    ports.save(event);
    linkDecisionDispatches(ports.store, event.selectionLogId ?? event.id, event.dispatches);
    await ports.notify(task, event);
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
    this.ports.assertCurrent(event);
    const node = state.plan.nodes.find((entry) => entry.id === dispatch.nodeId);
    if (node?.role === "reviewer" && !independentReviewer(state, dispatch.participantId))
      fail("workflow_review_author", "该评审委派属于历史实现者，请重新安排独立评审。");
    if (node && implementationNode(node)) rememberImplementer(state, dispatch.participantId);
    const old = state.nodes[dispatch.nodeId];
    state.nodes[dispatch.nodeId] = {
      status: "dispatched",
      attempt: (old?.attempt ?? 0) + 1,
      operationId: dispatch.operationId,
      participantId: dispatch.participantId,
      inputRevision: dispatch.inputRevision,
      artifactRevision: dispatch.artifactRevision,
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
          this.ports.assertCurrent(event);
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
    const timer = setInterval(() => {
      if (!this.ports.current(task.id) || this.ports.baseRevision(task) !== state.userRevision)
        cancellation.abort();
    }, 100);
    timer.unref();
    try {
      const run = await this.verification.run(
        task,
        candidate,
        AbortSignal.any([this.ports.signal, cancellation.signal]),
      );
      const after = await workspaceRevision(task.directories);
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
        existing.description = `${run.command} 已取得当前版本成功证据。`;
        existing.evidenceRefs.push(run.id);
      } else if (result !== "passed") {
        const issue = {
          id:
            existing?.id ?? (state.issues.some((issue) => issue.id === id) ? newId("verify") : id),
          verificationCommandIndex: candidate.commandIndex,
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
      if (run.status === "unknown")
        fail("workflow_verify_unknown", "验证执行状态尚未确认；保留目录阻塞，不能自动重跑。");
    } finally {
      clearInterval(timer);
    }
  }

  private async failed(task: Task, event: OrchestrationEvent, error: unknown): Promise<void> {
    const safe = safeError(error);
    event.error = safe;
    if (
      safe.code === "workflow_verify_unknown" ||
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
