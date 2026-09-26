import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { OperationError } from "../core/errors.js";
import { object, string } from "../feishu/api.js";
import { officialURL } from "../feishu/http.js";
import { type HTTPOptions, jsonRequest } from "./http.js";
import { callbacks, requiredEvents, requiredScopes } from "./scopes.js";

const authHosts = new Set(["accounts.feishu.cn", "accounts.larksuite.com"]);
const linkHosts = new Set([
  ...authHosts,
  "open.feishu.cn",
  "open.larksuite.com",
  "passport.feishu.cn",
  "passport.larksuite.com",
]);
export interface RegisteredApp {
  appId: string;
  appSecret: string;
  openId?: string;
  brand: "feishu" | "lark";
}
export interface RegistrationOptions extends HTTPOptions {
  appId?: string;
  createOnly?: boolean;
  tasks?: boolean;
  timeoutMs?: number;
  onURL(info: { url: string; expiresAt: string }): void;
  onStatus?(info: { status: "polling" | "slow_down" | "domain_switched"; interval?: number }): void;
}
export function validAuthorizationURL(raw: string): boolean {
  try {
    officialURL(raw, linkHosts);
    return true;
  } catch {
    return false;
  }
}
function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Fixed official device flow. Cancellation also cancels each in-flight HTTP request. */
export async function registerApp(options: RegistrationOptions): Promise<RegisteredApp> {
  if (options.appId && options.createOnly)
    throw new OperationError("registration_target", "补授权不能同时创建另一个应用。");
  if (options.appId !== undefined && !/^cli_[A-Za-z0-9]+$/.test(options.appId)) {
    throw new OperationError("registration_target", "现有应用 ID 格式无效。");
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 720_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const http = { fetch: options.fetch, requestTimeoutMs: options.requestTimeoutMs, signal };
  let host = "accounts.feishu.cn";
  let expiresAt = Number.POSITIVE_INFINITY;
  const post = (form: Record<string, string>, override = http) =>
    jsonRequest(
      `https://${host}/oauth/v1/app/registration`,
      authHosts,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      },
      override,
    );
  try {
    const begin = await post({
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    });
    signal.throwIfAborted();
    if (
      !string(begin.device_code) ||
      !validAuthorizationURL(string(begin.verification_uri_complete))
    ) {
      throw new OperationError("registration_response", "飞书未返回有效的授权链接。", "unknown");
    }
    const expiryMs = positive(begin.expires_in, 600) * 1000;
    expiresAt = Date.now() + expiryMs;
    const url = new URL(string(begin.verification_uri_complete));
    const addons = {
      scopes: { tenant: requiredScopes(options.tasks ?? true) },
      events: { items: { tenant: requiredEvents(options.tasks ?? true) } },
      callbacks: { items: callbacks },
    };
    for (const [key, value] of Object.entries({
      from: "sdk",
      tp: "sdk",
      source: "node-sdk/myrix",
      name: "myrix",
      desc: "通过 herdr 管理 Claude 与 Codex 的任务、讨论和人工审批。",
      addons: gzipSync(JSON.stringify(addons)).toString("base64url"),
    }))
      url.searchParams.set(key, value);
    if (options.appId) url.searchParams.set("clientID", options.appId);
    if (options.createOnly) url.searchParams.set("createOnly", "true");
    options.onURL({
      url: url.toString(),
      expiresAt: new Date(Date.now() + expiryMs).toISOString(),
    });
    const pollSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(expiryMs))]);
    let interval = positive(begin.interval, 5) * 1000;
    let switched = false;
    while (true) {
      pollSignal.throwIfAborted();
      const result = await post(
        { action: "poll", device_code: string(begin.device_code) },
        { ...http, signal: pollSignal },
      );
      pollSignal.throwIfAborted();
      const user = object(result.user_info);
      if (user.tenant_brand === "lark" && !switched) {
        switched = true;
        host = "accounts.larksuite.com";
        options.onStatus?.({ status: "domain_switched" });
        continue;
      }
      if (string(result.client_id) && string(result.client_secret)) {
        if (options.appId && result.client_id !== options.appId) {
          throw new OperationError(
            "registration_wrong_app",
            "授权返回了不同的应用，未更改已有凭据。",
            "unknown",
          );
        }
        return {
          appId: string(result.client_id),
          appSecret: string(result.client_secret),
          ...(string(user.open_id) ? { openId: string(user.open_id) } : {}),
          brand: switched ? "lark" : "feishu",
        };
      }
      switch (result.error) {
        case "slow_down":
          interval += 5_000;
          options.onStatus?.({ status: "slow_down", interval: interval / 1000 });
          break;
        case "authorization_pending":
          options.onStatus?.({ status: "polling" });
          break;
        case undefined:
        case "":
          break;
        case "access_denied":
          throw new OperationError("authorization_denied", "用户未同意此次授权。");
        case "expired_token":
          throw new OperationError("authorization_expired", "授权链接已过期，请重新操作。");
        default:
          throw new OperationError(
            "registration_refused",
            "飞书拒绝了注册或补授权请求。",
            "unknown",
          );
      }
      await delay(interval, undefined, { signal: pollSignal });
    }
  } catch (error) {
    if (options.signal?.aborted)
      throw new OperationError("authorization_aborted", "授权已取消。", "unknown");
    if (signal.aborted || Date.now() >= expiresAt)
      throw new OperationError("authorization_expired", "授权等待已结束，请重新操作。", "unknown");
    if (error instanceof OperationError) throw error;
    throw new OperationError("authorization_expired", "授权等待已结束，请重新操作。", "unknown");
  }
}
