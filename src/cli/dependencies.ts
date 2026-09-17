import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Application } from "../app/application.js";
import { createLogger } from "../app/logger.js";
import { loadConfig } from "../config/load.js";
import type { AppConfig } from "../config/types.js";
import { OperationError } from "../core/errors.js";
import type { HerdrPort, PlatformPort } from "../core/ports.js";
import { FeishuPlatform } from "../feishu/index.js";
import { HerdrRuntime } from "../herdr/index.js";
import { migrateLegacy } from "../migration/index.js";
import {
  checkAuthorization,
  registerApp,
  saveCredentials,
  verifyPlatform,
} from "../onboarding/index.js";
import { acquireLock } from "../storage/lock.js";
import { Store } from "../storage/store.js";
import { startWeb } from "../web/index.js";
import { inspectHost } from "./host-checks.js";

export type ServiceApplication = Pick<
  Application,
  | "authorization"
  | "runtime"
  | "attachPlatform"
  | "handlers"
  | "snapshot"
  | "dispatch"
  | "subscribe"
  | "changed"
  | "tick"
  | "shutdown"
>;
export interface Dependencies {
  signal: AbortSignal;
  stdout(line: string): void;
  stderr(line: string): void;
  loadConfig: typeof loadConfig;
  acquireLock: typeof acquireLock;
  openStore(path: string): Store;
  migrate: typeof migrateLegacy;
  createHerdr(config: AppConfig): HerdrPort;
  createPlatform(config: AppConfig): PlatformPort;
  createApp(
    config: AppConfig,
    store: Store,
    herdr: HerdrPort,
    recoveryError?: string,
  ): ServiceApplication;
  startWeb: typeof startWeb;
  checkAuthorization: typeof checkAuthorization;
  registerApp: typeof registerApp;
  saveCredentials: typeof saveCredentials;
  verifyPlatform: typeof verifyPlatform;
  openURL(url: string): Promise<void>;
  executable(name: string): Promise<boolean>;
  inspectHost: typeof inspectHost;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  retryMs: number;
}
export function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  const stderr = overrides.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const logger = createLogger(stderr);
  return {
    signal: new AbortController().signal,
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr,
    loadConfig,
    acquireLock,
    openStore: (path) => new Store(path),
    migrate: migrateLegacy,
    createHerdr: (config) =>
      new HerdrRuntime({
        socket: config.herdr.socket || undefined,
        timeoutMs: config.herdr.timeoutMs,
      }),
    createPlatform: (config) =>
      new FeishuPlatform({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
        logger,
      }),
    createApp: (config, store, herdr, recoveryError) =>
      new Application({
        config,
        store,
        herdr,
        logger,
        ...(recoveryError
          ? {
              engine: {
                contextTokens: config.ai.contextTokens,
                run: async () => {
                  throw new OperationError("config_recovery", recoveryError);
                },
                summarize: async () => {
                  throw new OperationError("config_recovery", recoveryError);
                },
              },
            }
          : {}),
      }),
    startWeb,
    checkAuthorization,
    registerApp,
    saveCredentials,
    verifyPlatform,
    inspectHost,
    openURL: async (url) => {
      const command = process.platform === "darwin" ? "open" : "xdg-open";
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, [url], { stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error("browser unavailable")),
        );
      });
    },
    executable: async (name) => {
      for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        try {
          await access(join(directory, name), constants.X_OK);
          return true;
        } catch {
          /* try next */
        }
      }
      return false;
    },
    sleep: async (ms, signal) => {
      await delay(ms, undefined, { signal });
    },
    retryMs: 30_000,
    ...overrides,
  };
}
export async function openBrowser(deps: Dependencies, url: string): Promise<void> {
  try {
    await deps.openURL(url);
  } catch {
    deps.stderr("浏览器未自动打开，请复制上方地址。");
  }
}
