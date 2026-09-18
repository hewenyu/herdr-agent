import { duration, expandPath } from "../config/load.js";
import { OperationError } from "../core/errors.js";

export type Command =
  | "serve"
  | "setup"
  | "configure"
  | "doctor"
  | "version"
  | "help"
  | "migrate"
  | "debug";
export interface Arguments {
  command: Command;
  stateDir?: string;
  json: boolean;
  listen?: string;
  configUI: boolean;
  open: boolean;
  dryRun: boolean;
  appId?: string;
  updatePermissions: boolean;
  reregister: boolean;
  yes: boolean;
  noOpen: boolean;
  timeoutMs: number;
  positionals: string[];
}
const commands = new Set<Command>([
  "serve",
  "setup",
  "configure",
  "doctor",
  "version",
  "help",
  "migrate",
  "debug",
]);
export function parseArguments(argv: string[]): Arguments {
  const out: Arguments = {
    command: "serve",
    json: false,
    configUI: true,
    open: false,
    dryRun: false,
    updatePermissions: false,
    reregister: false,
    yes: false,
    noOpen: false,
    timeoutMs: 720_000,
    positionals: [],
  };
  let commandSet = false;
  const used = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!token.startsWith("-")) {
      if (!commandSet) {
        if (!commands.has(token as Command)) throw usage(`未知命令：${token}。请运行 help。`);
        out.command = token as Command;
        commandSet = true;
      } else out.positionals.push(token);
      continue;
    }
    const [flag, inline] = token.split(/=(.*)/s);
    if (flag === "--help" || flag === "-h") {
      out.command = "help";
      return out;
    }
    if (flag === "--version" || flag === "-v") {
      out.command = "version";
      return out;
    }
    const value = () => {
      const result = inline ?? argv[++i];
      if (!result || result.startsWith("--")) throw usage(`${flag} 缺少参数。`);
      return result;
    };
    if (!flag) throw usage("参数无效。");
    used.add(flag);
    switch (flag) {
      case "--state-dir":
        out.stateDir = expandPath(value());
        break;
      case "--json":
        out.json = true;
        break;
      case "--config-listen":
      case "--listen":
        out.listen = value();
        break;
      case "--no-config-ui":
        out.configUI = false;
        break;
      case "--open":
        out.open = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--app":
        out.appId = value();
        break;
      case "--update-permissions":
        out.updatePermissions = true;
        break;
      case "--reregister":
        out.reregister = true;
        break;
      case "--yes":
        out.yes = true;
        break;
      case "--no-open":
        out.noOpen = true;
        break;
      case "--timeout":
        out.timeoutMs = duration(value(), 720_000);
        break;
      default:
        throw usage(`未知参数：${flag}。`);
    }
    if (
      inline !== undefined &&
      !["--state-dir", "--config-listen", "--listen", "--app", "--timeout"].includes(flag)
    )
      throw usage(`${flag} 不接受值。`);
  }
  const permitted: Partial<Record<Command, string[]>> = {
    serve: ["--config-listen", "--no-config-ui", "--open"],
    configure: ["--listen", "--open"],
    migrate: ["--dry-run"],
    setup: ["--app", "--update-permissions", "--reregister", "--yes", "--no-open", "--timeout"],
  };
  for (const flag of used)
    if (!["--state-dir", "--json", ...(permitted[out.command] ?? [])].includes(flag))
      throw usage(`${out.command} 不接受 ${flag}。`);
  if (out.command !== "debug" && out.positionals.length) throw usage("存在多余的位置参数。");
  if (out.reregister && (out.appId || out.updatePermissions))
    throw usage("--reregister 不能与现有应用选择或补授权同时使用。");
  if (out.reregister && !out.yes) throw usage("创建替代应用需明确指定 --reregister --yes。");
  if (out.appId && !/^cli_[A-Za-z0-9]+$/.test(out.appId)) throw usage("应用 ID 格式无效。");
  if (out.timeoutMs <= 0 || out.timeoutMs > 3_600_000)
    throw usage("授权超时须为 0 到 1 小时之间的正数。");
  return out;
}
function usage(message: string) {
  return new OperationError("usage", message);
}

export const HELP = `herdr-agent — pi 调度与 herdr 托管的 Claude / Codex

用法：herdr-agent [命令] [--state-dir PATH]

  serve       启动飞书服务与本机 Web（默认命令）
  setup       复用或注册飞书应用，验证消息与卡片回调
  configure   启动本机会话记录页（不连接飞书）
  doctor      只读检查配置、herdr、执行器与飞书权限
  migrate     导入旧版状态；--dry-run 仅预览
  version     显示构建版本
  help        显示帮助

serve: --config-listen IP:PORT --no-config-ui --open
configure: --listen IP:PORT --open
setup: --app cli_ID --update-permissions --reregister --yes --no-open --timeout 12m
全局：--state-dir PATH --json --help --version

诊断接口：debug ls | debug screen PANE | debug transcript PANE
终端写入通过任务参与者与审批操作完成。`;
