import type { Catalog } from "../core/types.js";

export interface ModelConfig {
  enabled: boolean;
  provider: "openai-responses" | "anthropic-messages";
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  contextTokens: number;
}

export interface MemoryConfig {
  provider: "file" | "http";
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  users: Record<string, Omit<MemoryConfig, "users">>;
}

export interface AppConfig {
  stateDir: string;
  feishu: { appId: string; appSecret: string; allowedOpenIds: string[]; notifyChatId: string };
  herdr: { socket: string; timeoutMs: number; pollIntervalMs: number };
  ui: { listen: string; maxCols: number; tailLines: number; notifyCooldownMs: number };
  tasks: { enabled: boolean; pollIntervalMs: number };
  ai: ModelConfig;
  memory: MemoryConfig;
  catalog: Catalog;
  mirrorDefaultOn: boolean;
  runtime: { maxConcurrentTasks: number; groupRetention: "retain" | "delete" };
}
