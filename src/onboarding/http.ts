import { OperationError } from "../core/errors.js";
import { object } from "../feishu/api.js";
import { type Fetch, officialURL } from "../feishu/http.js";

export interface HTTPOptions {
  fetch?: Fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}
/** Cancellation is a domain outcome: never surface the caller's raw abort reason. */
function authorizationAborted(): OperationError {
  return new OperationError("authorization_aborted", "授权已取消。", "unknown");
}
export async function jsonRequest(
  url: string,
  hosts: ReadonlySet<string>,
  init: RequestInit,
  options: HTTPOptions = {},
): Promise<Record<string, unknown>> {
  const target = officialURL(url, hosts);
  try {
    // A pre-aborted caller signal must not dispatch a request at all.
    if (options.signal?.aborted) throw authorizationAborted();
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.requestTimeoutMs ?? 15_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    const response = await (options.fetch ?? globalThis.fetch)(target, {
      ...init,
      signal,
      redirect: "error",
    });
    // Device authorization returns pending/slow_down in an HTTP 400 JSON body.
    if (!response.ok && response.status !== 400) {
      throw new OperationError(
        `onboarding_http_${response.status}`,
        `飞书授权请求失败（HTTP ${response.status}）。`,
        "unknown",
      );
    }
    const body = object(await response.json());
    // Cancellation and the internal deadline are distinct outcomes; neither may surface a
    // result the caller already abandoned.
    if (options.signal?.aborted) throw authorizationAborted();
    if (signal.aborted)
      throw new OperationError(
        "authorization_transport",
        "飞书授权请求未完成，请检查网络后重新操作。",
        "unknown",
      );
    return body;
  } catch (error) {
    // The raw reason can itself be an OperationError. Normalize that exact value before
    // preserving independently classified HTTP failures, including concurrent cancellation.
    if (options.signal?.aborted && error === options.signal.reason) throw authorizationAborted();
    if (error instanceof OperationError) throw error;
    if (options.signal?.aborted) throw authorizationAborted();
    throw new OperationError(
      "authorization_transport",
      "飞书授权请求未完成，请检查网络后重新操作。",
      "unknown",
    );
  }
}
