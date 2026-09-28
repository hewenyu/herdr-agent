import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { fail, OperationError } from "../core/errors.js";
import type { Task } from "../core/types.js";
import type { ProjectCatalog } from "../projects/catalog.js";
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  verificationConfigRevision,
} from "../projects/verification-config.js";
import type { Store } from "../storage/store.js";
import { directoriesConflict } from "./workspace.js";

export interface VerificationCandidate {
  commandIndex: number;
  configRevision: string;
  artifactRevision: string;
  description: string;
  /** New selection after a confirmed lifecycle cancellation; replay keeps the old identity. */
  retryOf?: string;
}

export interface VerificationRun extends VerificationCandidate {
  id: string;
  taskId: string;
  project: string;
  command: string;
  cwd: string;
  directories: string[];
  timeoutMs: number;
  status:
    | "prepared"
    | "running"
    | "passed"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "unknown"
    | "not_started";
  stdoutPath: string;
  stderrPath: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  exitConfirmed: boolean;
  error?: string;
}

const namespace = "verification_runs";
type ActiveRun = { taskId: string; controller: AbortController; result: Promise<VerificationRun> };
const liveRuns = new WeakMap<Store, Map<string, ActiveRun>>();
const blocks = (run: VerificationRun): boolean =>
  ["prepared", "running", "unknown"].includes(run.status);
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = (): string => new Date().toISOString();
const runId = (taskId: string, candidate: VerificationCandidate): string =>
  digest([
    taskId,
    candidate.commandIndex,
    candidate.configRevision,
    candidate.artifactRevision,
    ...(candidate.retryOf ? [candidate.retryOf] : []),
  ]);
const safelyCancelled = (run: VerificationRun): boolean =>
  run.status === "cancelled" && run.exitConfirmed;

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

/** One instance per application process, under the application's existing state lock. */
export class VerificationRunner {
  private readonly active: Map<string, ActiveRun>;

  constructor(
    private readonly options: { store: Store; stateDir: string; projects: ProjectCatalog },
  ) {
    this.active = liveRuns.get(options.store) ?? new Map();
    liveRuns.set(options.store, this.active);
    // A persisted PID is not a safe identity after restart. Never signal it or rerun it.
    for (const run of this.list()) {
      if (run.status !== "prepared" && run.status !== "running") continue;
      if (this.active.has(run.id)) continue;
      this.save({ ...run, status: "unknown", error: "restart_exit_unconfirmed" });
    }
  }

  list(taskId?: string): VerificationRun[] {
    return this.options.store
      .list<VerificationRun>(namespace)
      .filter((run) => taskId === undefined || run.taskId === taskId);
  }

  /** Canonical task directories; unknown execution keeps them blocked. */
  blockingDirectories(): string[] {
    return [
      ...new Set(
        this.list()
          .filter(blocks)
          .flatMap((run) => run.directories ?? [run.cwd]),
      ),
    ];
  }

  candidates(task: Task, artifactRevision: string): VerificationCandidate[] {
    if (!task.project) return [];
    const project = this.options.projects.get(task.project);
    const configRevision = verificationConfigRevision(project);
    return (project.verify ?? []).flatMap((command, commandIndex) => {
      const candidate: VerificationCandidate = {
        commandIndex,
        configRevision,
        artifactRevision,
        description: `运行项目已配置的验证命令 ${commandIndex + 1}：${command}`,
      };
      let previous = this.options.store.get<VerificationRun>(namespace, runId(task.id, candidate));
      while (previous && safelyCancelled(previous)) {
        candidate.retryOf = previous.id;
        previous = this.options.store.get<VerificationRun>(namespace, runId(task.id, candidate));
      }
      return previous &&
        ["failed", "timed_out", "cancelled", "unknown", "not_started"].includes(previous.status)
        ? []
        : [candidate];
    });
  }

  run(
    task: Task,
    candidate: VerificationCandidate,
    signal?: AbortSignal,
    beforeStart?: () => void,
  ): Promise<VerificationRun> {
    if (!candidate.artifactRevision || !candidate.configRevision)
      fail("verify_revision", "验证运行必须绑定配置与产物版本。");
    const id = runId(task.id, candidate);
    const active = this.active.get(id);
    if (active) return active.result;
    const previous = this.options.store.get<VerificationRun>(namespace, id);
    if (previous)
      return Promise.resolve(
        previous.status === "prepared" || previous.status === "running"
          ? this.save({ ...previous, status: "unknown", error: "runtime_exit_unconfirmed" })
          : previous,
      );
    let record: VerificationRun;
    try {
      record = this.reserve(task, candidate, id);
    } catch (error) {
      return Promise.reject(error);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const result = this.start(task, record, controller.signal, beforeStart).finally(() => {
      signal?.removeEventListener("abort", abort);
      this.active.delete(id);
    });
    this.active.set(id, { taskId: task.id, controller, result });
    return result;
  }

  /** Cancellation resolves only after process exit has been checked and saved. */
  async cancel(taskId: string): Promise<VerificationRun[]> {
    const active = [...this.active.values()].filter((run) => run.taskId === taskId);
    for (const run of active) run.controller.abort();
    return Promise.all(active.map((run) => run.result));
  }

  private save(run: VerificationRun): VerificationRun {
    this.options.store.set(namespace, run.id, run);
    return this.options.store.get<VerificationRun>(namespace, run.id) as VerificationRun;
  }

  private configuration(task: Task, candidate: VerificationCandidate) {
    if (!task.project) fail("verify_project", "没有项目配置，不能运行本机验证命令。");
    const project = this.options.projects.get(task.project);
    if (verificationConfigRevision(project) !== candidate.configRevision)
      fail("verify_config_changed", "验证命令配置已改变，请重新生成候选。");
    if (!Number.isSafeInteger(candidate.commandIndex) || candidate.commandIndex < 0)
      fail("verify_command", "验证命令必须引用项目已配置的命令编号。");
    const command = project.verify?.[candidate.commandIndex];
    if (command === undefined) fail("verify_command", "验证命令必须引用项目已配置的命令编号。");
    return { project, command };
  }

  /** The existing verification record blocks dispatch before run() releases admission. */
  private reserve(task: Task, candidate: VerificationCandidate, id: string): VerificationRun {
    if (process.platform === "win32")
      fail("verify_platform", "当前验证执行器需要 POSIX 进程组支持。");
    const { project, command } = this.configuration(task, candidate);
    if (candidate.retryOf) {
      const previous = this.options.store.get<VerificationRun>(namespace, candidate.retryOf);
      if (
        !previous ||
        !safelyCancelled(previous) ||
        previous.taskId !== task.id ||
        previous.commandIndex !== candidate.commandIndex ||
        previous.configRevision !== candidate.configRevision ||
        previous.artifactRevision !== candidate.artifactRevision
      )
        fail("verify_retry", "只能重新选择同任务、同配置和产物版本且已安全取消的验证。");
    }
    const primary = task.directories[0];
    if (!primary) fail("verify_directory", "验证任务缺少主工作目录。");
    const directories = task.directories.map((directory) => realpathSync(directory));
    const cwd = directories[0] as string;
    const directory = join(this.options.stateDir, "tasks", task.id, "verification", id);
    // Task ids come from runtime records; still reject path traversal before creating files.
    if (!/^[A-Za-z0-9_-]+$/.test(task.id)) fail("verify_task", "验证任务标识无效。");
    const stdoutPath = join(directory, "stdout.log");
    const stderrPath = join(directory, "stderr.log");
    const record: VerificationRun = {
      ...candidate,
      id,
      taskId: task.id,
      project: project.name,
      command,
      cwd,
      directories,
      timeoutMs: project.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      status: "prepared",
      stdoutPath,
      stderrPath,
      createdAt: now(),
      exitConfirmed: false,
    };
    this.options.store.transaction(() => {
      if (
        this.list().some(
          (run) => blocks(run) && directoriesConflict(run.directories ?? [run.cwd], directories),
        )
      )
        fail("verify_directory_busy", "该任务目录仍有执行中或退出未确认的验证。");
      this.save(record);
    });
    return record;
  }

  private async start(
    task: Task,
    record: VerificationRun,
    signal: AbortSignal,
    beforeStart?: () => void,
  ): Promise<VerificationRun> {
    let stdout: Awaited<ReturnType<typeof open>> | undefined;
    let stderr: Awaited<ReturnType<typeof open>> | undefined;
    let attempted = false;
    try {
      await mkdir(join(this.options.stateDir, "tasks", task.id, "verification", record.id), {
        recursive: true,
        mode: 0o700,
      });
      stdout = await open(record.stdoutPath, "w", 0o600);
      stderr = await open(record.stderrPath, "w", 0o600);
      beforeStart?.();
      if (signal.aborted)
        return this.save({
          ...record,
          status: "cancelled",
          exitConfirmed: true,
          finishedAt: now(),
          error: "cancelled_before_start",
        });
      this.configuration(task, record);
      attempted = true;
      const result = await this.execute(record, stdout.fd, stderr.fd, signal);
      await stdout.sync();
      await stderr.sync();
      return this.save(result);
    } catch (error) {
      this.save({
        ...record,
        status: attempted ? "unknown" : "not_started",
        finishedAt: now(),
        error: attempted ? "runtime_exit_unconfirmed" : "preflight_failed",
      });
      throw error;
    } finally {
      await stdout?.close();
      await stderr?.close();
    }
  }

  private async execute(
    record: VerificationRun,
    stdout: number,
    stderr: number,
    signal: AbortSignal,
  ): Promise<VerificationRun> {
    let child: ChildProcess;
    try {
      child = spawn(record.command, {
        cwd: record.cwd,
        shell: "/bin/sh",
        detached: true,
        stdio: ["ignore", stdout, stderr],
      });
    } catch {
      return { ...record, status: "not_started", finishedAt: now(), error: "spawn_failed" };
    }
    let timedOut = false;
    let cancelled = false;
    let spawnError = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      killGroup(child, "SIGTERM");
      hardKill ??= setTimeout(() => killGroup(child, "SIGKILL"), 250);
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, record.timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("error", () => {
      spawnError = true;
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
      },
    );
    try {
      if (child.pid) this.save({ ...record, status: "running", pid: child.pid, startedAt: now() });
      const result = await closed;
      clearTimeout(timer);
      // A shell may exit before its children; they remain part of the verification run.
      const lingeringChildren = !!child.pid && groupExists(child.pid);
      if (lingeringChildren && child.pid) {
        stop();
        for (let attempt = 0; attempt < 20 && groupExists(child.pid); attempt++)
          await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const exitConfirmed = !spawnError && !!child.pid && !groupExists(child.pid);
      const status: VerificationRun["status"] = spawnError
        ? "not_started"
        : !exitConfirmed
          ? "unknown"
          : timedOut
            ? "timed_out"
            : cancelled
              ? "cancelled"
              : result.code === 0 && !lingeringChildren
                ? "passed"
                : "failed";
      return {
        ...this.options.store.get<VerificationRun>(namespace, record.id),
        ...record,
        pid: child.pid,
        startedAt: child.pid
          ? this.options.store.get<VerificationRun>(namespace, record.id)?.startedAt
          : undefined,
        status,
        finishedAt: now(),
        exitCode: result.code,
        signal: result.signal,
        exitConfirmed,
        error: spawnError
          ? "spawn_failed"
          : !exitConfirmed
            ? "process_group_exit_unconfirmed"
            : lingeringChildren && !timedOut && !cancelled
              ? "background_processes_terminated"
              : undefined,
      };
    } catch (cause) {
      stop();
      await closed;
      if (child.pid) {
        for (let attempt = 0; attempt < 20 && groupExists(child.pid); attempt++)
          await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new OperationError(
        "verify_uncertain",
        "验证退出或持久化未确认，不能自动重跑。",
        "unknown",
        { cause },
      );
    } finally {
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      signal.removeEventListener("abort", abort);
    }
  }
}
