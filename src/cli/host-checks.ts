import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import { fields } from "../config/load.js";
import type { HerdrPort } from "../core/ports.js";
import { cleanScreen } from "../herdr/screen.js";

export interface Check {
  name: string;
  status: "pass" | "warn" | "fail" | "unknown";
  message: string;
}
export interface HostProbe {
  home: string;
  configDir: string;
  read(path: string): Promise<string>;
  file(path: string): Promise<boolean>;
  command(command: string, args: string[], signal: AbortSignal): Promise<string>;
}
export const hostProbe: HostProbe = {
  home: homedir(),
  configDir: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr"),
  read: (path) => readFile(path, "utf8"),
  file: async (path) => (await stat(path)).isFile(),
  command: async (command, args, signal) =>
    (
      await promisify(execFile)(command, args, {
        signal,
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout,
};

export async function inspectHost(
  signal: AbortSignal,
  probe: HostProbe = hostProbe,
): Promise<Check[]> {
  const results = await Promise.allSettled([
    hook(probe, "claude", [".claude", "hooks", "herdr-agent-state.sh"]),
    hook(probe, "codex", [".codex", "hooks.json"]),
    environment(probe, signal),
    manifest(probe),
  ]);
  return results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : {
          name:
            ["claude-hook", "codex-hook", "server-environment", "detection-manifest"][index] ??
            "host",
          status: "unknown",
          message: "本机检查未完成，未推断为正常。",
        },
  );
}
async function hook(probe: HostProbe, kind: string, parts: string[]): Promise<Check> {
  const name = `${kind}-hook`;
  if (!probe.home) return { name, status: "unknown", message: "无法定位用户主目录。" };
  const path = join(probe.home, ...parts);
  const advice = `运行 herdr integration install ${kind}。${kind === "codex" ? "安装后需在 Codex 内确认信任 hook；磁盘存在不能证明已信任。" : ""}`;
  try {
    const installed = await probe.file(path);
    return {
      name,
      status: installed ? "pass" : "fail",
      message: installed
        ? `${path} 已存在。${kind === "codex" ? advice : ""}`
        : `hook 不存在。${advice}`,
    };
  } catch (error) {
    return {
      name,
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "fail" : "unknown",
      message: `无法读取 ${path}。${advice}`,
    };
  }
}
export function environmentNames(output: string): string[] {
  return [
    ...new Set(
      output
        .split(/\s+/)
        .filter((token) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
        .map((token) => token.slice(0, token.indexOf("="))),
    ),
  ];
}
async function environment(probe: HostProbe, signal: AbortSignal): Promise<Check> {
  const name = "server-environment";
  let output: string;
  try {
    output = await probe.command("pgrep", ["-f", "herdr server"], signal);
  } catch {
    return {
      name,
      status: "unknown",
      message: "未找到 herdr server 进程，或系统不允许读取进程列表。",
    };
  }
  const pids = [
    ...new Set(
      output
        .trim()
        .split(/\s+/)
        .filter((pid) => /^[1-9]\d*$/.test(pid)),
    ),
  ];
  if (!pids.length) return { name, status: "unknown", message: "没有找到 herdr server 进程。" };
  const details: string[] = [];
  let dirty = false,
    unknown = false;
  for (const pid of pids.slice(0, 32)) {
    try {
      const names = environmentNames(await probe.command("ps", ["eww", pid], signal));
      if (!names.includes("PATH") && !names.includes("HOME")) {
        unknown = true;
        details.push(`pid ${pid} 环境不可读`);
        continue;
      }
      const bad = names.filter((key) => key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE"));
      if (bad.length) {
        dirty = true;
        details.push(`pid ${pid}: ${bad.join(", ")}`);
      } else details.push(`pid ${pid} 未发现影响 Claude transcript 的环境标记`);
    } catch {
      unknown = true;
      details.push(`pid ${pid} 环境读取失败`);
    }
  }
  if (pids.length > 32) {
    unknown = true;
    details.push("进程数量超过检查上限");
  }
  return {
    name,
    status: dirty ? "fail" : unknown ? "unknown" : "pass",
    message: `${details.join("；")}。${dirty ? "请从不含这些变量的终端重启 herdr server。" : ""}`,
  };
}
async function manifest(probe: HostProbe): Promise<Check> {
  const name = "detection-manifest";
  if (!probe.configDir) return { name, status: "unknown", message: "无法定位 herdr 配置目录。" };
  const path = join(probe.configDir, "config.toml");
  try {
    const config = fields(parse(await probe.read(path)));
    const pinned = fields(config.update).manifest_check === false;
    return {
      name,
      status: pinned ? "pass" : "warn",
      message: pinned
        ? "herdr 检测规则自动更新已禁用。"
        : `请在 ${path} 已有的 [update] 中设置 manifest_check = false，避免检测规则随远端更新变化。`,
    };
  } catch {
    return {
      name,
      status: "warn",
      message: `无法读取或解析 ${path}；检查文件后在 [update] 设置 manifest_check = false。`,
    };
  }
}

export async function paneWidths(herdr: HerdrPort, signal: AbortSignal): Promise<Check> {
  const name = "pane-width";
  try {
    const agents = await herdr.list(signal);
    if (!agents.length) return { name, status: "pass", message: "没有运行中的 agent，无需测量。" };
    let unknown = false;
    const details: string[] = [];
    for (const agent of agents) {
      if (!agent.kind) {
        unknown = true;
        continue;
      }
      try {
        const screen = await herdr.screen({ ...agent, kind: agent.kind }, signal);
        const text = cleanScreen(screen.text);
        if (!text.trim()) {
          unknown = true;
          details.push(`${agent.paneId} 屏幕为空`);
          continue;
        }
        const cols = Math.max(
          ...text
            .split("\n")
            .map((line) => [...line].reduce((width, char) => width + characterWidth(char), 0)),
        );
        // Short visible text cannot establish the terminal's actual column count.
        if (cols <= 60) unknown = true;
        details.push(`${agent.paneId} 最长内容行约 ${cols} 列`);
      } catch {
        unknown = true;
        details.push(`${agent.paneId} 屏幕不可读`);
      }
    }
    return {
      name,
      status: unknown ? "unknown" : "pass",
      message: `${details.join("；")}。未读取终端实际列数。${unknown ? "短内容、空屏幕或不可读内容不足以判断终端是否超过 60 列。" : "各 pane 的可见内容宽度估算下界均超过 60 列。"}`,
    };
  } catch {
    return { name, status: "unknown", message: "无法读取 herdr agent 列表，未测量终端宽度。" };
  }
}
function characterWidth(character: string): number {
  if (/\p{Mark}|\p{Cf}/u.test(character)) return 0;
  if (character === "\t") return 8;
  const code = character.codePointAt(0) ?? 0;
  return /\p{Extended_Pictographic}/u.test(character) ||
    (code >= 0x1100 &&
      (code <= 0x115f ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe6f) ||
        (code >= 0xff01 && code <= 0xff60) ||
        code >= 0x20000))
    ? 2
    : 1;
}
