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

export interface JevConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  confidenceThreshold: number;
  ingressEnabled: boolean;
  /** Configured Jev selects native task menus; false keeps manual approval. */
  approvalsEnabled?: boolean;
  stallRounds: number;
}

export interface AppConfig {
  stateDir: string;
  feishu: { appId: string; appSecret: string; allowedOpenIds: string[]; notifyChatId: string };
  herdr: { socket: string; timeoutMs: number; pollIntervalMs: number };
  ui: { listen: string; maxCols: number; tailLines: number; notifyCooldownMs: number };
  tasks: { enabled: boolean; pollIntervalMs: number };
  ai: ModelConfig;
  /** Optional for historical embedded configurations; private ingress remains opt-in. */
  jev?: JevConfig;
  memory: MemoryConfig;
  catalog: Catalog;
  mirrorDefaultOn: boolean;
  runtime: { maxConcurrentTasks: number; groupRetention: "retain" | "delete" };
}
