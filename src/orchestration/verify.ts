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

const runStatuses: readonly VerificationRun["status"][] = [
  "prepared",
  "running",
  "passed",
  "failed",
  "timed_out",
  "cancelled",
  "unknown",
  "not_started",
];

/**
 * Narrow structural check for one persisted verification run. It only proves the
 * fields that decide directory blocking and record identity are interpretable;
 * `directories` keeps its documented legacy fallback to `cwd` only when absent.
 * The record identity must equal its own store key, and `exitConfirmed` must be
 * a real boolean when present so a string cannot stand in for a confirmed exit.
 * A legacy row may omit `exitConfirmed`; absence is read as unconfirmed and still
 * cannot authorize a retry. A corrupt row is never rewritten, repaired or dropped.
 */
function readableRun(record: unknown, key: string): record is VerificationRun {
  if (record === null || typeof record !== "object") return false;
  const value = record as Partial<VerificationRun>;
  const directories = value.directories;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id === key &&
    typeof value.taskId === "string" &&
    typeof value.status === "string" &&
    runStatuses.includes(value.status as VerificationRun["status"]) &&
    typeof value.cwd === "string" &&
    value.cwd.length > 0 &&
    (value.exitConfirmed === undefined || typeof value.exitConfirmed === "boolean") &&
    (directories === undefined ||
      (Array.isArray(directories) &&
        directories.length > 0 &&
        directories.every((directory) => typeof directory === "string" && directory.length > 0)))
  );
}

/**
 * Fail-closed read boundary: an uninterpretable run is refused with a typed
 * diagnostic instead of being skipped (which would release its directory block)
 * or coerced into `undefined` paths that later make `realpath` throw a raw
 * TypeError. The original row is preserved.
 */
function runRecord(record: unknown, ref: string): VerificationRun {
  if (readableRun(record, ref)) return record;
  throw new OperationError(
    "verify_record_invalid",
    `验证运行记录（${ref}）无法解读；本次验证与目录放行已拒绝，原始记录保留供诊断。`,
    "not_executed",
  );
}

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
      .entries<unknown>(namespace)
      .map(([id, stored]) => runRecord(stored, id))
      .filter((run) => taskId === undefined || run.taskId === taskId);
  }

  /** Canonical task directories; unknown execution keeps them blocked. */
  blockingDirectories(): string[] {
    return [
      ...new Set(
        this.list()
          .filter(blocks)
          // `directories` is validated as non-empty strings; only a genuinely
          // absent array falls back to the documented legacy `cwd`.
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
      let previous: VerificationRun | undefined;
      const stored = this.options.store.get<unknown>(namespace, runId(task.id, candidate));
      if (stored !== undefined) previous = runRecord(stored, runId(task.id, candidate));
      while (previous && safelyCancelled(previous)) {
        candidate.retryOf = previous.id;
        const retried = this.options.store.get<unknown>(namespace, runId(task.id, candidate));
        previous =
          retried === undefined ? undefined : runRecord(retried, runId(task.id, candidate));
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
    const stored = this.options.store.get<unknown>(namespace, id);
    const previous = stored === undefined ? undefined : runRecord(stored, id);
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
    const stored = this.options.store.get<unknown>(namespace, run.id);
    // `save` only ever writes a shape this process built, so a failure here is a
    // store defect rather than corruption; still refuse rather than cast.
    return runRecord(stored, run.id);
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
      const stored = this.options.store.get<unknown>(namespace, candidate.retryOf);
      const previous = stored === undefined ? undefined : runRecord(stored, candidate.retryOf);
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
    // Include synchronous launch work, but exclude preflight and authorization.
    // This clock advances even while JS cannot dispatch deadline callbacks.
    const deadlineAt = performance.now() + record.timeoutMs;
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
    // Launch work consumes the budget; round up to avoid firing before its end.
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.max(1, Math.ceil(deadlineAt - performance.now())),
    );
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
      // A queued close can beat an overdue timer. Conservatively reject a late
      // observation: exit 0 alone cannot prove completion within the deadline.
      if (performance.now() >= deadlineAt) timedOut = true;
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
