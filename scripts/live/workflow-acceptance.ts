/** Manual real Jev + pi + Claude/Codex local acceptance. Never connects to Feishu. */
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DirectoryTrust } from "../../src/app/directory-trust.js";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { loadConfig } from "../../src/config/load.js";
import type { AppConfig } from "../../src/config/types.js";
import { OperationError, safeError } from "../../src/core/errors.js";
import type { Logger } from "../../src/core/ports.js";
import type { ActorContext, Participant, Task } from "../../src/core/types.js";
import type { DecisionLog } from "../../src/orchestration/decision-log.js";
import { reportCard, reportContract, reportText } from "../../src/orchestration/report.js";
import type { VerificationRun } from "../../src/orchestration/verify.js";
import {
  WORKFLOWS,
  type WorkflowState,
  type WorkflowTemplate,
} from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { ProjectCatalog } from "../../src/projects/catalog.js";
import { verificationConfigRevision } from "../../src/projects/verification-config.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type { ConversationEngine } from "../../src/runtime/types.js";
import { acquireLock } from "../../src/storage/lock.js";
import { Store } from "../../src/storage/store.js";
import { TaskService } from "../../src/tasks/service.js";
import { participantEvidence } from "./workflow-acceptance-evidence.js";
import {
  createFixture,
  fixtureHashes,
  verificationCommand,
} from "./workflow-acceptance-fixtures.js";
import { forbiddenPlatform, ownedRuntime, redactor } from "./workflow-acceptance-runtime.js";

interface Options {
  template: WorkflowTemplate | "all";
  credentialStateDir?: string;
  timeoutMs: number;
  bypass: boolean;
}

const usage = `Usage: node --import tsx scripts/live/workflow-acceptance.ts
  --template discussion|development|bugfix|all  (default: all; sequential)
  --state-dir PATH     Read model credentials/socket configuration from PATH only.
  --timeout-ms NUMBER  Harness observation deadline per template (default: 900000).
  --bypass            Explicitly disable native approvals for this isolated run only.
  --help              Print help without reading credentials or calling models.

Creates persistent evidence under a private OS temporary directory; does not write
production configuration/state, send platform messages, or start/stop herdr services.
Starts at most two owned native agents. Run only after other delegated agents finish:
two native participants plus one supervising agent is the maximum of three.
The existing guarded startup-directory trust flow applies only to the generated project.
Without --bypass, other native approvals remain enabled. Any blocked approval stops
the run without answering keys.
Harness deadlines stop observation and clean up, never synthesize a workflow result.
The local report callback is explicitly not evidence of Feishu delivery.
`;

function options(): Options | undefined {
  if (process.argv.includes("--help")) {
    process.stdout.write(usage);
    return;
  }
  const result: Options = { template: "all", timeoutMs: 900_000, bypass: false };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--bypass") result.bypass = true;
    else if (flag === "--template") {
      const value = args[++index];
      if (!["discussion", "development", "bugfix", "all"].includes(value ?? ""))
        throw new OperationError("acceptance_arguments", "无效模板。");
      result.template = value as Options["template"];
    } else if (flag === "--state-dir") {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new OperationError("acceptance_arguments", "缺少凭据来源目录。");
      result.credentialStateDir = resolve(value);
    } else if (flag === "--timeout-ms") {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1000 || value > 3_600_000)
        throw new OperationError("acceptance_arguments", "观察期限应为 1000～3600000 毫秒。");
      result.timeoutMs = value;
    } else throw new OperationError("acceptance_arguments", "未知参数，请使用 --help。");
  }
  return result;
}

function isolatedConfig(source: AppConfig, stateDir: string, bypass: boolean): AppConfig {
  const config = loadConfig({ stateDir, home: stateDir, cwd: stateDir, env: {} });
  config.ai = { ...source.ai };
  config.jev = source.jev ? { ...source.jev, ingressEnabled: false } : undefined;
  config.herdr = { ...source.herdr };
  config.tasks.enabled = true;
  config.tasks.pollIntervalMs = 1000;
  config.runtime.maxConcurrentTasks = 1;
  config.feishu.allowedOpenIds = ["local-workflow-acceptance"];
  config.catalog = { projects: [], defaultProject: "", bypass };
  return config;
}

interface LocalReply {
  eventId: string;
  type: "local_report_callback" | "local_notice_callback";
  textHash: string;
  path: string;
  reportId?: string;
  platformDelivery: false;
}

async function runTemplate(
  source: AppConfig,
  selected: WorkflowTemplate,
  root: string,
  settings: Options,
  externalSignal: AbortSignal,
  redact: (value: string) => string,
) {
  const directory = join(root, selected);
  const stateDir = join(directory, "state");
  const projectDir = join(directory, "project");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const writeJson = async (path: string, value: unknown) =>
    writeFile(path, `${redact(JSON.stringify(value, null, 2))}\n`, { mode: 0o600 });
  const fixture = await createFixture(projectDir, selected);
  const initialRevision = await workspaceRevision([projectDir]);
  const config = isolatedConfig(source, stateDir, settings.bypass);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, externalSignal]);
  const timer = setTimeout(
    () => controller.abort("acceptance_observation_deadline"),
    settings.timeoutMs,
  );
  const store = new Store(join(stateDir, "state.sqlite"));
  const runtime = ownedRuntime(config, directory, signal);
  const platformAttempts: string[] = [];
  const replies: LocalReply[] = [];
  const modelCalls: Array<Record<string, unknown>> = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const logger: Logger = Object.fromEntries(
    ["info", "warn", "error"].map((level) => [
      level,
      (message: string, fields?: Record<string, unknown>) =>
        diagnostics.push({ at: new Date().toISOString(), level, message, fields }),
    ]),
  ) as unknown as Logger;
  const catalog = new ProjectCatalog(store, config.catalog, directory);
  const project = await catalog.save(
    {
      name: "acceptance",
      directories: [projectDir],
      agent: "codex",
      ...(selected === "discussion"
        ? {}
        : { verify: [verificationCommand], verifyTimeoutMs: 30_000 }),
    },
    true,
    { localConfiguration: true },
  );
  const transport = new PiEngine(config.ai);
  const engine: ConversationEngine = {
    contextTokens: transport.contextTokens,
    summarize: (input) => transport.summarize(input),
    run: async (input) => {
      const call: Record<string, unknown> = {
        at: new Date().toISOString(),
        model: config.ai.model,
        protocol: config.ai.provider,
        tools: input.tools.map((tool) => tool.name),
        state: "started",
      };
      modelCalls.push(call);
      try {
        const result = await transport.run(input);
        call.state = "finished";
        call.toolCalls = result.toolCalls;
        call.finishedAt = new Date().toISOString();
        return result;
      } catch (error) {
        call.state = "failed";
        call.errorCode = safeError(error).code;
        // Private, redacted diagnostics distinguish provider failures from product guards.
        const causes = [];
        let cause: unknown = error;
        for (let depth = 0; depth < 3 && cause instanceof Error; depth++) {
          causes.push({ name: cause.name, message: redact(cause.message).slice(0, 1000) });
          cause = cause.cause;
        }
        call.causes = causes;
        throw error;
      }
    },
  };
  const directoryTrust = new DirectoryTrust(store, runtime.port, engine, logger, signal);
  const service = new TaskService({
    store,
    config,
    herdr: runtime.port,
    platform: forbiddenPlatform(platformAttempts),
    catalog,
    hooks: {
      blocked: async (task, participant) => {
        if (!participant.execution) return;
        let screen = await runtime.port.screen(participant.execution);
        // Match Application's guarded startup flow, including changing native metadata.
        for (let attempt = 0; attempt < 2; attempt++) {
          const sequence = screen.agent.stateSeq;
          if (
            await directoryTrust.handle(task, participant, screen, {
              source: "system",
              ownerId: task.ownerId,
              chatId: task.entryChatId,
              sessionId: `local-startup:${task.id}`,
              taskId: task.id,
              messageId: `startup:${participant.id}:${sequence}`,
            })
          )
            return;
          screen = await runtime.port.screen(participant.execution);
          if (screen.agent.status !== "blocked" || screen.agent.stateSeq === sequence) return;
        }
      },
    },
  });
  const actor: ActorContext = {
    source: "system",
    ownerId: "local-workflow-acceptance",
    chatId: "local-only-no-platform",
    sessionId: `local-${selected}`,
    messageId: "synthetic-acceptance-input",
  };
  const workerOptions = {
    config,
    projects: catalog,
    store,
    engine,
    tasks: () => service,
    tools: () => [],
    signal,
    logger,
    onReply: async (task: Task, text: string, eventId: string) => {
      const event = store.get<OrchestrationEvent>("task_orchestration_events", eventId);
      const state = store.get<WorkflowState>(WORKFLOWS, task.id);
      const report = event?.decision?.action === "deliver" && event.decision.reportId;
      const path = join(directory, `local-callback-${replies.length + 1}.md`);
      await writeFile(path, redact(text), { mode: 0o600 });
      if (report && state?.report?.id === report)
        await writeJson(join(directory, "local-summary-card.json"), {
          kind: "local_card_snapshot_not_platform_delivery",
          card: reportCard(task, state),
        });
      replies.push({
        eventId,
        type: report ? "local_report_callback" : "local_notice_callback",
        textHash: createHash("sha256").update(text).digest("hex"),
        path,
        ...(report ? { reportId: report } : {}),
        platformDelivery: false,
      });
    },
  };
  const worker = new TaskOrchestrator(workerOptions);
  let task: Task | undefined;
  let failure: string | undefined;
  let checks: Record<string, boolean> = {};
  let cleanup: Awaited<ReturnType<typeof runtime.cleanup>> = [];
  const startedAt = new Date().toISOString();
  const progress = async () => {
    if (!task) return;
    const current = service.get(actor, task.id);
    const state = store.get<WorkflowState>(WORKFLOWS, task.id);
    const snapshot = {
      at: new Date().toISOString(),
      template: selected,
      taskId: task.id,
      status: current.status,
      phase: state?.phase,
      nodes: state?.nodes,
      participants: current.participants.map(({ id, kind, status, error }) => ({
        id,
        kind,
        status,
        errorCode: error ? "participant_error" : undefined,
      })),
    };
    await appendFile(join(directory, "progress.ndjson"), `${redact(JSON.stringify(snapshot))}\n`, {
      mode: 0o600,
    });
    process.stdout.write(
      `${JSON.stringify({ template: selected, status: current.status, phase: state?.phase })}\n`,
    );
  };
  try {
    await runtime.port.ping(signal);
    task = await service.create(actor, fixture.input);
    await writeJson(join(directory, "input.json"), fixture.input);
    let heartbeat = 0;
    while (!signal.aborted) {
      await service.reconcile(task.id);
      const current = service.get(actor, task.id);
      if (current.status === "attention" || current.participants.some((entry) => entry.error))
        throw new OperationError("acceptance_task_attention", "真实任务需要处理，保留诊断。");
      const blocked = current.participants.filter((entry) => entry.status === "blocked");
      if (blocked.length) {
        let stillBlocked = false;
        for (const participant of blocked) {
          if (!participant.execution) continue;
          const screen = await runtime.port.screen(participant.execution).catch(() => undefined);
          if (screen && screen.agent.status !== "blocked") continue;
          stillBlocked = true;
          await writeJson(join(directory, `blocked-${participant.kind}.json`), {
            participant,
            screen,
            approvalAnswered: false,
          });
        }
        if (stillBlocked)
          throw new OperationError("native_approval_blocked", "原生审批等待人工处理，未自动回答。");
        continue;
      }
      await worker.tick();
      // Reconcile may project participant status over task attention. Respect the
      // durable scheduler failure; only unproved input has an automatic readback path.
      if (
        store
          .list<OrchestrationEvent>("task_orchestration_events")
          .some(
            (event) =>
              event.taskId === task?.id &&
              event.state === "attention" &&
              event.error?.code !== "orchestration_delivery_unknown" &&
              !event.dispatches.some((dispatch) =>
                ["pending", "uncertain"].includes(dispatch.state),
              ),
          )
      )
        throw new OperationError("acceptance_task_attention", "调度已停止，保留真实失败记录。");
      const state = store.get<WorkflowState>(WORKFLOWS, task.id);
      if (Date.now() - heartbeat >= 15_000) {
        heartbeat = Date.now();
        await progress();
      }
      if (replies.some((reply) => reply.type === "local_report_callback")) break;
      if (
        state?.stall.awaitingUser ||
        store
          .list<OrchestrationEvent>("task_orchestration_events")
          .some((entry) => entry.decision?.action === "wait")
      )
        throw new OperationError(
          "acceptance_user_arbitration",
          "真实流程要求用户裁决，未伪造完成。",
        );
      await delay(1000, undefined, { signal }).catch(() => undefined);
    }
    if (signal.aborted)
      throw new OperationError(
        "acceptance_observation_stopped",
        "验收观察停止，未改变工作流完成规则。",
      );
    let state = store.get<WorkflowState>(WORKFLOWS, task.id);
    if (!state) throw new OperationError("acceptance_no_state", "没有工作流状态。");
    const artifactRevision = await workspaceRevision([projectDir]);
    const logs = store.list<DecisionLog>("workflow_decisions");
    const events = store.list<OrchestrationEvent>("task_orchestration_events");
    const verification = store.list<VerificationRun>("verification_runs");
    const beforeReplay = {
      callbacks: replies.length,
      dispatches: events.reduce((sum, event) => sum + event.dispatches.length, 0),
      starts: runtime.stats().started,
      promptAttempts: runtime.stats().promptAttempts,
    };
    await new TaskOrchestrator(workerOptions).tick();
    await service.reconcile(task.id);
    state = store.get<WorkflowState>(WORKFLOWS, task.id);
    if (!state) throw new OperationError("acceptance_no_state", "回放后没有工作流状态。");
    const latest = service.get(actor, task.id);
    const text = await reportText(state);
    const reportReplies = replies.filter((reply) => reply.type === "local_report_callback");
    const participants = participantEvidence(store, task, runtime.owned);
    checks = {
      requestedTemplate: state.plan.template === selected,
      realPlanner: modelCalls.some(
        (call) =>
          (call.tools as string[]).includes("orchestration_plan") && call.state === "finished",
      ),
      realJevDistribution: logs.some(
        (log) => ["success", "low-confidence"].includes(log.jev.status) && !!log.jev.probabilities,
      ),
      twoRealAgentKinds:
        participants.length === 2 &&
        ["claude", "codex"].every((kind) =>
          participants.some(
            (participant) => participant.kind === kind && participant.provenParticipation,
          ),
        ),
      nodesComplete: state.plan.nodes.every((node) => state.nodes[node.id]?.status === "completed"),
      reportContract:
        reportContract(
          state,
          artifactRevision,
          project.verify ?? [],
          verificationConfigRevision(project),
        ).length === 0,
      reportCallback:
        reportReplies.length === 1 &&
        reportReplies[0]?.reportId === state.report?.id &&
        reportReplies[0]?.textHash === createHash("sha256").update(text).digest("hex"),
      awaitingUserAcceptance: latest.status === "review" && state.phase === "awaiting_acceptance",
      immutableFixtures:
        JSON.stringify(await fixtureHashes(projectDir, fixture.immutableFiles)) ===
        JSON.stringify(fixture.hashes),
      configuredVerification:
        selected === "discussion"
          ? verification.length === 0
          : verification.some(
              (run) =>
                run.status === "passed" &&
                run.exitCode === 0 &&
                run.exitConfirmed &&
                run.command === verificationCommand &&
                run.cwd === projectDir &&
                run.artifactRevision === artifactRevision,
            ),
      discussionReadOnly: selected !== "discussion" || initialRevision === artifactRevision,
      noPlatformOperations: platformAttempts.length === 0,
      noDuplicateOnReplay:
        beforeReplay.callbacks === replies.length &&
        beforeReplay.starts === runtime.stats().started &&
        beforeReplay.promptAttempts === runtime.stats().promptAttempts &&
        beforeReplay.dispatches ===
          store
            .list<OrchestrationEvent>("task_orchestration_events")
            .reduce((sum, event) => sum + event.dispatches.length, 0),
      concurrency: runtime.stats().started === 2 && runtime.stats().peakNativeAgents <= 2,
    };
    if (Object.values(checks).some((passed) => !passed)) failure = "acceptance_checks_failed";
  } catch (error) {
    failure = safeError(error).code;
  } finally {
    clearTimeout(timer);
    controller.abort();
    service.stop();
    const nativeSnapshots = await runtime
      .snapshots()
      .catch((error) => [{ errorCode: safeError(error).code }]);
    cleanup = await runtime.cleanup();
    await writeJson(join(directory, "native-snapshots.json"), nativeSnapshots);
    await writeJson(
      join(directory, "participant-evidence.json"),
      task ? participantEvidence(store, task, runtime.owned) : [],
    );
    if (cleanup.some((entry) => !entry.closed)) failure ??= "acceptance_cleanup_incomplete";
    await writeJson(join(directory, "diagnostics.json"), {
      diagnostics,
      modelCalls,
      platformAttempts,
      localReplies: replies,
      cleanup,
      native: runtime.stats(),
      participants: store.list<Participant>("participants"),
      tasks: store.list("tasks"),
      operations: store.entries("operations"),
    });
    await writeJson(join(directory, "decision-log.json"), store.list("workflow_decisions"));
    await writeJson(
      join(directory, "directory-trust.json"),
      store.list("directory_trust_decisions"),
    );
    await writeJson(join(directory, "events.json"), store.list("task_orchestration_events"));
    await writeJson(join(directory, "verification.json"), store.list("verification_runs"));
    await writeJson(join(directory, "workflow.json"), store.list(WORKFLOWS));
    store.close();
  }
  const result = {
    template: selected,
    passed: !failure,
    failure,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    native: runtime.stats(),
    cleanup,
    evidenceDirectory: directory,
    kind: "real_jev_pi_claude_codex_local_workflow",
    delivery: "local_callback_only_not_feishu",
    bypass: settings.bypass,
    acceptedByUser: false,
  };
  await writeJson(join(directory, "result.json"), result);
  return result;
}

async function main() {
  const settings = options();
  if (!settings) return;
  const source = loadConfig({ stateDir: settings.credentialStateDir });
  if (!source.ai.enabled || !source.ai.apiKey || !source.ai.model || !source.jev?.apiKey)
    throw new OperationError("acceptance_credentials", "需配置真实 pi 模型和 Jev key。");
  const redact = redactor(source);
  const lock = acquireLock(join(tmpdir(), "myrix-workflow-acceptance-lock"));
  const root = await realpath(await mkdtemp(join(tmpdir(), "myrix-workflow-acceptance-")));
  await chmod(root, 0o700);
  const control = new AbortController();
  const stop = () => control.abort("user_interrupted");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const results = [];
  try {
    process.stdout.write(
      `${JSON.stringify({ evidenceDirectory: root, bypass: settings.bypass })}\n`,
    );
    const templates: WorkflowTemplate[] =
      settings.template === "all" ? ["discussion", "development", "bugfix"] : [settings.template];
    for (const template of templates) {
      const result = await runTemplate(source, template, root, settings, control.signal, redact);
      results.push(result);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.passed || control.signal.aborted) break;
    }
    const evidence = {
      requestedTemplates: templates,
      passed: results.length === templates.length && results.every((result) => result.passed),
      results,
      limits:
        "No real Feishu ingress, groups, remote tasks, delivery, production service restart or user acceptance. All native resources in cleanup belong to this run.",
    };
    await writeFile(join(root, "summary.json"), `${redact(JSON.stringify(evidence, null, 2))}\n`, {
      mode: 0o600,
    });
    if (!evidence.passed) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    lock.release();
  }
}

main().catch((error) => {
  // Never print provider errors or configuration objects, which can contain credentials.
  process.stderr.write(`${JSON.stringify({ passed: false, errorCode: safeError(error).code })}\n`);
  process.exitCode = 1;
});
