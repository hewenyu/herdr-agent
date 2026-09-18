import { join } from "node:path";
import { webAssets } from "../build-assets.js";
import type { AppConfig } from "../config/types.js";
import { validateConfig } from "../config/validate.js";
import { OperationError, safeError } from "../core/errors.js";
import type { PlatformPort } from "../core/ports.js";
import type { Store } from "../storage/store.js";
import type { Arguments } from "./args.js";
import { type Dependencies, openBrowser, type ServiceApplication } from "./dependencies.js";

export async function service(
  args: Arguments,
  config: AppConfig,
  deps: Dependencies,
): Promise<number> {
  if (args.listen) config.ui.listen = args.listen;
  let recoveryError: string | undefined;
  try {
    validateConfig(config);
  } catch (error) {
    const failure = safeError(error);
    if (
      args.command !== "configure" ||
      !["ai_tasks", "ai_config", "ai_timeout", "ai_context", "endpoint"].includes(failure.code)
    )
      throw error;
    // Verify all non-AI configuration independently; never bypass a bad listener or memory endpoint.
    validateConfig({ ...config, ai: { ...config.ai, enabled: false } });
    recoveryError = failure.message;
  }
  const lock = deps.acquireLock(config.stateDir);
  const control = new AbortController();
  const signal = AbortSignal.any([control.signal, deps.signal]);
  let store: Store | undefined;
  let app: ServiceApplication | undefined;
  let web: Awaited<ReturnType<Dependencies["startWeb"]>> | undefined;
  let platform: PlatformPort | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let authorization: Promise<void> | undefined;
  const ticks = new Set<Promise<void>>();
  const tick = () => {
    if (signal.aborted || !app) return;
    const operation = app.tick().catch((error: unknown) => {
      deps.stderr(safeError(error).message);
    });
    ticks.add(operation);
    void operation.finally(() => ticks.delete(operation));
  };
  const startTicks = () => {
    if (timer) return;
    tick();
    timer = setInterval(tick, Math.min(config.herdr.pollIntervalMs, config.tasks.pollIntervalMs));
  };
  const cleanupErrors: unknown[] = [];
  const clean = async (action: () => unknown) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  try {
    signal.throwIfAborted();
    store = deps.openStore(join(config.stateDir, "state.sqlite"));
    const migration = await deps.migrate(config.stateDir, store);
    for (const warning of migration.warnings) deps.stderr(warning);
    const herdr = deps.createHerdr(config);
    app = deps.createApp(config, store, herdr, recoveryError);
    if (args.configUI) {
      web = await deps.startWeb({ listen: config.ui.listen, backend: app, assets: webAssets });
      deps.stdout(args.json ? JSON.stringify({ event: "web_ready", url: web.url }) : web.url);
      if (args.open) await openBrowser(deps, web.url);
    }
    if (args.command === "configure") {
      app.authorization = { status: "offline", message: "本机记录查看模式；飞书连接未启动。" };
      app.runtime = recoveryError
        ? { status: "configuration_required", message: `${recoveryError} 请修改本地配置后重启。` }
        : { status: "ready", message: "本机会话记录页已启动。" };
      app.changed();
      if (!recoveryError) startTicks();
    } else {
      const runningApp = app;
      authorization = authorize(
        config,
        runningApp,
        deps,
        signal,
        async () => {
          await herdr.ping(signal);
          platform = deps.createPlatform(config);
          runningApp.attachPlatform(platform);
          await platform.start(runningApp.handlers(), signal);
          signal.throwIfAborted();
          if (config.tasks.enabled) await platform.subscribeTasks();
          signal.throwIfAborted();
          runningApp.runtime = { status: "ready", message: "飞书连接与任务调度已启动。" };
          runningApp.changed();
          startTicks();
        },
        async () => {
          if (platform) {
            await platform.stop();
            platform = undefined;
          }
        },
      );
    }
    await aborted(signal);
  } finally {
    control.abort();
    if (timer) clearInterval(timer);
    // Stop admitting effects immediately, before waiting on connection teardown.
    const draining = app ? clean(() => app?.shutdown()) : Promise.resolve();
    if (authorization) await clean(() => authorization);
    await draining;
    if (platform) await clean(() => platform?.stop());
    if (web) await clean(() => web?.close());
    await Promise.allSettled([...ticks]);
    if (store) await clean(() => store?.close());
    await clean(() => lock.release());
    for (const error of cleanupErrors) deps.stderr(safeError(error).message);
  }
  return cleanupErrors.length ? 1 : 0;
}

async function authorize(
  config: AppConfig,
  app: ServiceApplication,
  deps: Dependencies,
  signal: AbortSignal,
  start: () => Promise<void>,
  stop: () => Promise<void>,
): Promise<void> {
  while (!signal.aborted) {
    try {
      if (!/^cli_[A-Za-z0-9]+$/.test(config.feishu.appId) || !config.feishu.allowedOpenIds.length) {
        app.authorization = {
          status: "setup_required",
          message: "请停止服务后运行 setup，配置飞书应用和允许名单。",
        };
        app.runtime = { status: "waiting", message: "Web 可用，等待飞书配置。" };
        app.changed();
        await aborted(signal);
        return;
      }
      app.authorization = { status: "checking", message: "正在检查当前应用的授权。" };
      app.changed();
      const result = await deps.checkAuthorization(config.feishu, {
        tasks: config.tasks.enabled,
        signal,
      });
      if (result.state === "required") {
        app.authorization = {
          status: "required",
          message: "当前应用需要补授权。",
          missingScopes: result.missingScopes,
        };
        app.changed();
        const registered = await deps.registerApp({
          appId: config.feishu.appId,
          tasks: config.tasks.enabled,
          signal,
          onURL: ({ url, expiresAt }) => {
            app.authorization = {
              status: "required",
              message: "请为当前应用完成补授权。",
              url,
              expiresAt,
              missingScopes: result.missingScopes,
            };
            app.changed();
            deps.stdout(url);
          },
        });
        if (registered.brand !== "feishu")
          throw new OperationError(
            "unsupported_brand",
            "当前版本仅支持飞书国内应用；Lark 凭据未保存。",
          );
        await deps.saveCredentials(config.stateDir, registered, {
          expectedAppId: config.feishu.appId,
        });
        config.feishu.appSecret = registered.appSecret;
        continue;
      }
      app.authorization = { status: "ready", message: "当前应用权限已就绪。" };
      app.changed();
      await start();
      await aborted(signal);
      return;
    } catch (error) {
      if (signal.aborted) return;
      await stop().catch(() => {});
      const failure = safeError(error);
      app.authorization = { status: "unknown", message: failure.message };
      app.runtime = { status: "waiting", message: "连接检查未成功，稍后重试；Web 仍可用。" };
      app.changed();
      deps.stderr(failure.message);
      try {
        await deps.sleep(deps.retryMs, signal);
      } catch {
        return;
      }
    }
  }
}
export function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
