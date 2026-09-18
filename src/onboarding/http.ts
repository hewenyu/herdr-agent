import { OperationError } from "../core/errors.js";
import { object } from "../feishu/api.js";
import { type Fetch, officialURL } from "../feishu/http.js";

export interface HTTPOptions {
  fetch?: Fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}
export async function jsonRequest(
  url: string,
  hosts: ReadonlySet<string>,
  init: RequestInit,
  options: HTTPOptions = {},
): Promise<Record<string, unknown>> {
  const target = officialURL(url, hosts);
  options.signal?.throwIfAborted();
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.requestTimeoutMs ?? 15_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
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
    signal.throwIfAborted();
    return body;
  } catch (error) {
    if (error instanceof OperationError) throw error;
    if (options.signal?.aborted)
      throw new OperationError("authorization_aborted", "授权已取消。", "unknown");
    throw new OperationError(
      "authorization_transport",
      "飞书授权请求未完成，请检查网络后重新操作。",
      "unknown",
    );
  }
}
