import { isIP } from "node:net";
import { fail } from "../core/errors.js";
import type { AppConfig, MemoryConfig } from "./types.js";

export function loopback(host: string): boolean {
  return host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

export function listenAddress(value: string): { host: string; port: number } {
  const match = value.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
  const host = match?.[1] ?? match?.[2] ?? "";
  const port = Number(match?.[3]);
  if (!loopback(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
    fail("listen_address", "Web 地址必须是本机回环 IP 和端口，例如 127.0.0.1:18790。");
  }
  return { host, port };
}

export function safeEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("endpoint", "服务地址无效。");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#") ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && (loopback(host) || host === "localhost"))
    )
  ) {
    fail("endpoint", "服务地址必须使用 HTTPS（本机允许 HTTP），且不能包含凭据、查询或片段。");
  }
  return url;
}

function validateMemory(memory: Omit<MemoryConfig, "users">): void {
  if (!Number.isFinite(memory.timeoutMs) || memory.timeoutMs <= 0 || memory.timeoutMs > 120_000)
    fail("memory_timeout", "记忆超时需为 0 到 2 分钟之间的正数。");
  if (memory.provider === "http") {
    const url = safeEndpoint(memory.baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!loopback(host) && host !== "localhost" && !memory.apiKey.trim())
      fail("memory_key", "远端记忆服务需配置 API key。");
  }
}

export function validateConfig(config: AppConfig, options: { requireFeishu?: boolean } = {}): void {
  listenAddress(config.ui.listen);
  for (const value of [config.ui.maxCols, config.ui.tailLines]) {
    if (!Number.isInteger(value) || value < 1) fail("ui_size", "终端显示尺寸必须为正整数。");
  }
  for (const value of [
    config.herdr.timeoutMs,
    config.herdr.pollIntervalMs,
    config.ui.notifyCooldownMs,
  ]) {
    if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647)
      fail("config_duration", "轮询与超时必须为有效的正数毫秒。");
  }
  if (
    !Number.isInteger(config.runtime.maxConcurrentTasks) ||
    config.runtime.maxConcurrentTasks < 1 ||
    config.runtime.maxConcurrentTasks > 64
  )
    fail("task_limit", "并行任务上限必须为 1 到 64。");
  if (
    !Number.isFinite(config.tasks.pollIntervalMs) ||
    config.tasks.pollIntervalMs <= 0 ||
    config.tasks.pollIntervalMs > 2_147_483_647
  )
    fail("task_poll", "任务同步间隔必须为有效的正数毫秒。");
  if (options.requireFeishu) {
    if (!/^cli_[A-Za-z0-9]+$/.test(config.feishu.appId))
      fail("feishu_app", "请先完成 setup 配置飞书应用。");
    if (!config.feishu.appSecret.trim()) fail("feishu_secret", "飞书应用 secret 不能为空。");
    if (!config.feishu.allowedOpenIds.length)
      fail("allowlist", "飞书允许名单不能为空，请先完成 setup。");
  }
  if (config.feishu.allowedOpenIds.some((id) => !id.trim() || id !== id.trim()))
    fail("allowlist", "飞书允许名单不能包含空白标识。");
  if (config.ai.enabled) {
    if (!config.tasks.enabled) fail("ai_tasks", "启用 pi 调度时需要 tasks.enabled = true。");
    if (!config.ai.apiKey || !config.ai.model)
      fail("ai_config", "启用 pi 时需配置模型及 API key。");
    safeEndpoint(config.ai.baseUrl);
    if (config.ai.timeoutMs <= 0 || config.ai.timeoutMs > 600_000)
      fail("ai_timeout", "模型超时必须在 0 到 10 分钟之间。");
    if (
      !Number.isInteger(config.ai.contextTokens) ||
      config.ai.contextTokens < 16_384 ||
      config.ai.contextTokens > 1_048_576
    ) {
      fail("ai_context", "模型上下文阈值必须在 16384 到 1048576 之间。");
    }
  }
  validateMemory(config.memory);
  for (const [owner, memory] of Object.entries(config.memory.users)) {
    if (!owner.trim() || owner !== owner.trim())
      fail("memory_user", "记忆用户标识不能为空或包含两侧空白。");
    validateMemory(memory);
  }
}
