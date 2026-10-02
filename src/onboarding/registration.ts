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
/**
 * Node timers silently collapse delays above 2^31-1 ms to 1 ms, and Date/AbortSignal.timeout
 * reject non-integer or out-of-range delays. Timer inputs are therefore always finite, integral
 * and within the native limit before they reach Node.
 */
const maxTimerMs = 2_147_483_647;
/** One slow_down step; accumulation is capped by the native timer limit, not a fixed wait. */
const slowDownStepMs = 5_000;
const defaultBudgetMs = 720_000;
const defaultExpiryMs = 600_000;
const defaultIntervalMs = 5_000;

type RemoteTiming = { kind: "absent" } | { kind: "invalid" } | { kind: "value"; ms: number };

/**
 * Classifies a remote seconds value. Absent or non-numeric fields keep the previous lenient
 * defaults; a numeric value that cannot be a finite positive duration (0, negative, NaN,
 * Infinity, or one whose millisecond conversion overflows) is malformed and is rejected rather
 * than silently replaced or used raw.
 */
function remoteTiming(value: unknown): RemoteTiming {
  if (typeof value !== "number") return { kind: "absent" };
  if (!Number.isFinite(value) || value <= 0) return { kind: "invalid" };
  const ms = value * 1000;
  return Number.isFinite(ms) ? { kind: "value", ms } : { kind: "invalid" };
}
/** A timer delay must be a positive integer no greater than the native limit. */
function timerMs(value: number): number {
  return Math.min(Math.max(1, Math.ceil(value)), maxTimerMs);
}
function registrationResponse(message: string): OperationError {
  return new OperationError("registration_response", message, "unknown");
}

/** Fixed official device flow. Cancellation also cancels each in-flight HTTP request. */
export async function registerApp(options: RegistrationOptions): Promise<RegisteredApp> {
  if (options.appId && options.createOnly)
    throw new OperationError("registration_target", "补授权不能同时创建另一个应用。");
  if (options.appId !== undefined && !/^cli_[A-Za-z0-9]+$/.test(options.appId)) {
    throw new OperationError("registration_target", "现有应用 ID 格式无效。");
  }
  // The configured budget is caller-provided; normalize it only so it always forms a valid
  // timer (fractional values would otherwise throw a RangeError inside AbortSignal.timeout).
  const requestedBudget = options.timeoutMs ?? defaultBudgetMs;
  const budgetMs = timerMs(
    Number.isFinite(requestedBudget) && requestedBudget >= 0 ? requestedBudget : defaultBudgetMs,
  );
  const startedAt = Date.now();
  const signal = AbortSignal.any([
    AbortSignal.timeout(budgetMs),
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
    // A pre-aborted caller must not receive a QR code for a request that was never useful.
    if (options.signal?.aborted)
      throw new OperationError("authorization_aborted", "授权已取消。", "unknown");
    signal.throwIfAborted();
    if (
      !string(begin.device_code) ||
      !validAuthorizationURL(string(begin.verification_uri_complete))
    ) {
      throw new OperationError("registration_response", "飞书未返回有效的授权链接。", "unknown");
    }
    // Remote timing is validated before any callback, timer or wall-clock deadline. Absent
    // fields fall back to the documented defaults; a numeric field that cannot be a positive
    // duration is rejected as a malformed response instead of silently replaced.
    const remoteExpiry = remoteTiming(begin.expires_in);
    if (remoteExpiry.kind === "invalid") throw registrationResponse("飞书返回的授权有效期无效。");
    const expiryMs = Math.min(
      remoteExpiry.kind === "value" ? remoteExpiry.ms : defaultExpiryMs,
      maxTimerMs,
    );
    // Poll pacing never reaches a timer unbounded: an oversized or fractional remote value is
    // normalized to a valid timer delay, and slow_down accumulation is capped the same way.
    const remoteInterval = remoteTiming(begin.interval);
    if (remoteInterval.kind === "invalid") throw registrationResponse("飞书返回的轮询间隔无效。");
    let interval = timerMs(remoteInterval.kind === "value" ? remoteInterval.ms : defaultIntervalMs);
    // The advertised deadline is the remote expiry bounded by the caller's own budget: it can
    // never be an unrepresentable date and never promises more than the caller will wait.
    expiresAt = Math.min(Date.now() + expiryMs, startedAt + budgetMs);
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
      // Both terms are finite and bounded, so this can never throw or advertise a deadline
      // the local budget will not honor.
      expiresAt: new Date(expiresAt).toISOString(),
    });
    const pollSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(expiryMs))]);
    let switched = false;
    while (true) {
      // Abort reasons never escape this loop: the outer catch maps caller cancellation to
      // authorization_aborted and the local budget to authorization_expired.
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
          // Accumulated backoff is capped by the native timer limit, so repeated slow_down can
          // never overflow the next delay.
          interval = Math.min(interval + slowDownStepMs, maxTimerMs);
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
