import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { fail, OperationError } from "../core/errors.js";
import type { AgentKind, Catalog, Project } from "../core/types.js";
import type { AppConfig, MemoryConfig } from "./types.js";

type Fields = Record<string, unknown>;
export const fields = (value: unknown): Fields =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : {};
const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const bool = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail("config_type", "布尔配置必须使用 true 或 false。");
  return value;
};
const number = (value: unknown, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    fail("config_type", "数字配置格式无效。");
  return value;
};

export function duration(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string")
    fail("config_duration", "时间配置必须为 1s、250ms 等带单位字符串。");
  if (value === "0") return 0;
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (parts.map((part) => part[0]).join("") !== value || !parts.length) {
    fail("config_duration", "时间配置无效，请使用带单位的正数。");
  }
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const result = parts.reduce(
    (sum, part) => sum + Number(part[1]) * (units[part[2] ?? ""] ?? 0),
    0,
  );
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER)
    fail("config_duration", "时间配置过大。");
  return result;
}

export function expandPath(value: string, home = homedir()): string {
  if (!value.trim() || (value.startsWith("~") && value !== "~" && !value.startsWith("~/")))
    fail("config_path", "目录不能为空，且不支持其他用户的波浪线路径。");
  return resolve(
    value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value,
  );
}

export function readToml(path: string): Fields {
  if (!existsSync(path)) return {};
  try {
    return fields(parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")));
  } catch {
    throw new OperationError("config_parse", "config.toml 语法错误，请检查字段类型与引号。");
  }
}

export function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    if (!key || /\s/.test(key)) continue;
    result[key] = trimmed.slice(index + 1).trim();
  }
  return result;
}

function repositoryEnv(cwd: string): Record<string, string> {
  for (let current = resolve(cwd); ; current = dirname(current)) {
    if ([".git", "go.mod", "package.json"].some((marker) => existsSync(join(current, marker))))
      return readEnv(join(current, ".env"));
    if (dirname(current) === current) return {};
  }
}

function memory(raw: Fields): MemoryConfig {
  const provider = text(raw.provider, "file");
  if (provider !== "file" && provider !== "http")
    fail("memory_provider", "记忆 provider 只能是 file 或 http。");
  return {
    provider,
    baseUrl: text(raw.base_url),
    apiKey: text(raw.api_key),
    timeoutMs: duration(raw.timeout, 10_000),
    users: Object.fromEntries(
      Object.entries(fields(raw.users)).map(([id, data]) => [id, memory(fields(data))]),
    ),
  };
}

function project(name: string, raw: Fields, home: string): Project {
  if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(name)) fail("project_name", "项目名称无效。");
  if (raw.directories !== undefined && !Array.isArray(raw.directories))
    fail("project_directory", "项目目录必须是数组。");
  const directories =
    Array.isArray(raw.directories) && raw.directories.length ? raw.directories : [raw.path];
  if (!directories.every((item) => typeof item === "string" && item.trim()))
    fail("project_directory", "项目目录不能为空或包含非文本值。");
  const agent = text(raw.agent, "codex");
  if (agent !== "codex" && agent !== "claude")
    fail("project_agent", "项目 agent 只能为 codex 或 claude。");
  return {
    name,
    directories: directories
      .filter((item): item is string => typeof item === "string")
      .map((item) => expandPath(item, home)),
    agent: agent as AgentKind,
  };
}

export function loadConfig(
  options: { stateDir?: string; home?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): AppConfig {
  const home = options.home ?? homedir();
  const stateDir = options.stateDir ?? join(home, ".herdr-agent");
  const raw = readToml(join(stateDir, "config.toml"));
  const fs = fields(raw.feishu),
    hd = fields(raw.herdr),
    ui = fields(raw.ui);
  const tasks = fields(raw.tasks),
    ai = fields(raw.ai),
    rt = fields(raw.runtime);
  const credentials = {
    ...repositoryEnv(options.cwd ?? process.cwd()),
    ...readEnv(join(stateDir, ".env")),
    ...(options.env ?? process.env),
  };
  const provider = text(ai.provider, "openai-responses");
  if (provider !== "openai-responses" && provider !== "anthropic-messages") {
    fail("ai_provider", "模型协议必须为 openai-responses 或 anthropic-messages。");
  }
  let catalog: Catalog = {
    projects: Object.entries(fields(tasks.projects)).map(([name, value]) =>
      project(name, fields(value), home),
    ),
    defaultProject: text(tasks.default_project),
    bypass: bool(tasks.bypass, true),
  };
  const projectPath = join(stateDir, "projects.json");
  if (existsSync(projectPath)) {
    try {
      const saved = fields(JSON.parse(readFileSync(projectPath, "utf8")));
      if (
        saved.version !== 1 ||
        !saved.projects ||
        typeof saved.projects !== "object" ||
        Array.isArray(saved.projects)
      )
        throw new Error();
      catalog = {
        projects: Object.entries(fields(saved.projects)).map(([name, value]) =>
          project(name, fields(value), home),
        ),
        defaultProject: text(saved.default_project),
        bypass: bool(saved.bypass, catalog.bypass),
      };
    } catch {
      fail("projects_corrupt", "projects.json 损坏或版本不兼容，请保留原文件并修复。");
    }
  }
  if (!catalog.defaultProject && catalog.projects[0])
    catalog.defaultProject =
      [...catalog.projects].sort((a, b) => a.name.localeCompare(b.name))[0]?.name ?? "";
  if (
    catalog.defaultProject &&
    !catalog.projects.some((item) => item.name === catalog.defaultProject)
  )
    fail("default_project", "默认项目不在项目目录中。");
  return {
    stateDir,
    feishu: {
      appId: credentials.FEISHU_APP_ID ?? credentials.LARK_APP_ID ?? "",
      appSecret: credentials.FEISHU_APP_SECRET ?? credentials.LARK_APP_SECRET ?? "",
      allowedOpenIds: Array.isArray(fs.allowed_open_ids)
        ? fs.allowed_open_ids.filter((item): item is string => typeof item === "string")
        : [],
      notifyChatId: text(fs.notify_chat_id),
    },
    herdr: {
      socket: text(hd.socket_path) ? expandPath(text(hd.socket_path), home) : "",
      timeoutMs: duration(hd.call_timeout, 10_000) || 10_000,
      pollIntervalMs: duration(hd.poll_interval, 1000) || 1000,
    },
    ui: {
      listen: text(ui.config_listen, "127.0.0.1:18790"),
      maxCols: number(ui.max_cols, 56) || 56,
      tailLines: number(ui.tail_lines, 18) || 18,
      notifyCooldownMs: duration(ui.notify_cooldown, 30_000) || 30_000,
    },
    tasks: {
      enabled: bool(tasks.enabled, false),
      pollIntervalMs: duration(tasks.poll_interval, 30_000),
    },
    ai: {
      enabled: bool(ai.enabled, false),
      provider,
      model: text(ai.model),
      baseUrl: text(ai.base_url),
      apiKey: text(ai.api_key),
      timeoutMs: duration(ai.timeout, 120_000),
      contextTokens: number(ai.context_tokens, 50_000),
    },
    memory: memory(fields(raw.memory)),
    catalog,
    mirrorDefaultOn: bool(fields(raw.mirror).default_on, false),
    runtime: {
      maxConcurrentTasks: number(rt.max_concurrent_tasks, 4),
      groupRetention: text(rt.group_retention, "retain") === "delete" ? "delete" : "retain",
    },
  };
}
