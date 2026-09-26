import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { COMMIT, VERSION } from "../build-info.js";
import { inspectStateLock, type StateLockStatus } from "../storage/lock.js";

const LABEL = "com.hewenyu.herdr-agent";
const execute = promisify(execFile);
type Runner = (file: string, args: string[]) => Promise<string>;

export interface StatusOptions {
  stdout?(line: string): void;
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  run?: Runner;
}

interface ProcessInfo {
  pid: number;
  parentPid: number;
  executable: string;
}

interface StatusReport extends StateLockStatus {
  installedVersion: string;
  installedCommit: string;
  process?: ProcessInfo;
  launchd?: { target: string; pid: number; executable: string; matched: boolean };
  guidance: string[];
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function directory(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function processInfo(pid: number, run: Runner): Promise<ProcessInfo | undefined> {
  try {
    // comm prints only the executable, never argv or environment credentials.
    const output = await run("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,comm="]);
    const match = /^(\d+)\s+(\d+)\s+([^\r\n]+)$/.exec(output.trim());
    if (!match || Number(match[1]) !== pid) return;
    return { pid, parentPid: Number(match[2]), executable: match[3] ?? "" };
  } catch {
    return;
  }
}

function launchdDetails(output: string): { pid: number; args: string[] } | undefined {
  const pid = /^\s*pid = ([1-9]\d*)\s*$/m.exec(output)?.[1];
  const block = /^\s*arguments = \{\s*\n([\s\S]*?)^\s*\}/m.exec(output)?.[1];
  if (!pid || !block) return;
  const args = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!args.length || args.length > 64 || args.some((arg) => arg.length > 4096)) return;
  return { pid: Number(pid), args };
}

async function launchdStatus(
  lock: StateLockStatus,
  process: ProcessInfo | undefined,
  home: string,
  uid: number,
  run: Runner,
): Promise<StatusReport["launchd"]> {
  const target = `gui/${uid}/${LABEL}`;
  let job: ReturnType<typeof launchdDetails>;
  try {
    job = launchdDetails(await run("/bin/launchctl", ["print", target]));
  } catch {
    return;
  }
  if (!job) return;
  const locations = job.args.flatMap((arg, index) =>
    arg === "--state-dir"
      ? [job.args[index + 1]]
      : arg.startsWith("--state-dir=")
        ? [arg.slice(12)]
        : [],
  );
  const stateDir =
    locations.length === 0
      ? join(home, ".herdr-agent")
      : locations.length === 1
        ? locations[0]
        : undefined;
  const matchingState =
    !!stateDir && isAbsolute(stateDir) && directory(stateDir) === directory(lock.stateDir);
  let parent = process;
  let matched = matchingState && !!process && job.args[1] === "serve" && lock.pid === job.pid;
  // npm's command is a Node launcher with a native child. Verify ancestry,
  // rather than confusing its launchd PID with the lock's recorded child PID.
  const seen = new Set<number>();
  for (let depth = 0; matchingState && job.args[1] === "serve" && parent && depth < 4; depth++) {
    if (parent.parentPid === job.pid) {
      matched = true;
      break;
    }
    if (parent.parentPid <= 1 || seen.has(parent.parentPid)) break;
    seen.add(parent.parentPid);
    parent = await processInfo(parent.parentPid, run);
  }
  // Confirm the selected lock still records the same holder after process reads.
  const current = inspectStateLock(lock.stateDir);
  matched &&= current.state === "locked" && current.pid === lock.pid;
  return { target, pid: job.pid, executable: job.args[0] ?? "", matched };
}

/** Read-only status; it does not load configuration, SQLite, or any service runtime. */
export async function status(
  args: { stateDir?: string; json?: boolean },
  options: StatusOptions = {},
): Promise<number> {
  const home = options.home ?? homedir();
  const input = args.stateDir ?? join(home, ".herdr-agent");
  const stateDir = resolve(
    input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input,
  );
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const run: Runner =
    options.run ??
    (async (file, argv) => {
      const result = await execute(file, argv, {
        timeout: 2000,
        maxBuffer: 128 * 1024,
        encoding: "utf8",
      });
      return result.stdout;
    });
  const report: StatusReport = {
    ...inspectStateLock(stateDir),
    installedVersion: VERSION,
    installedCommit: COMMIT,
    guidance: [],
  };
  if (report.state === "locked") {
    if (report.pid) {
      report.process = await processInfo(report.pid, run);
      report.guidance.push(`查看记录 PID：ps -p ${report.pid} -o pid=,ppid=,comm=`);
    }
    if ((options.platform ?? process.platform) === "darwin") {
      const uid = options.uid ?? process.getuid?.();
      if (uid !== undefined)
        report.launchd = await launchdStatus(report, report.process, home, uid, run);
    }
    if (report.launchd?.matched) {
      report.guidance.push(
        `已匹配本状态目录的 launchd 服务：${report.launchd.target}`,
        `重启桥接服务（仍注册在 launchd 中时）：launchctl kickstart -k ${quote(report.launchd.target)}`,
        `或停用桥接服务（从 launchd 卸载）：launchctl bootout ${quote(report.launchd.target)}`,
        "停用后需重新安装或 bootstrap 注册服务，不能直接 kickstart。",
        `重启使用 launchd 已配置的程序 ${report.launchd.executable}；npm 升级不会自动更换正在运行的进程或服务路径。`,
      );
    } else {
      report.guidance.push(
        "尚未确认服务管理器归属；若在终端前台运行，请回原终端按 Ctrl+C。不要仅凭记录 PID 终止进程。",
      );
      if ((options.platform ?? process.platform) === "darwin")
        report.guidance.push(
          `可只读检查：launchctl print gui/${options.uid ?? process.getuid?.() ?? "$(id -u)"}/${LABEL}`,
        );
    }
    report.guidance.push("状态锁不证明飞书连接或调度健康；此命令不停止进程、不删除锁。");
  } else if (report.state === "unlocked") {
    report.guidance.push(
      `当前未发现持有本状态锁的实例。启动：myrix serve --state-dir ${quote(stateDir)}`,
    );
  }
  if (args.json) stdout(JSON.stringify(report, null, 2));
  else
    stdout(
      [
        `状态：${report.state === "locked" ? "状态锁被持有" : report.state === "unlocked" ? "状态锁未被持有" : "无法确认"}`,
        `状态目录：${report.stateDir}`,
        `当前命令版本：${report.installedVersion}（不代表运行中实例的版本）`,
        ...(report.pid ? [`记录 PID：${report.pid}（仅供核对）`] : []),
        ...(report.process ? [`进程可执行文件：${report.process.executable}`] : []),
        ...(report.reason ? [report.reason] : []),
        ...report.guidance,
      ].join("\n"),
    );
  return report.state === "unknown" ? 1 : 0;
}
