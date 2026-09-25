import type { HttpInstance, HttpRequestOptions } from "@larksuiteoapi/node-sdk";
import { OperationError } from "../core/errors.js";

export type Fetch = typeof globalThis.fetch;
type RequestOptions<D> = HttpRequestOptions<D> & { signal?: AbortSignal };
export const apiHosts = new Set(["open.feishu.cn", "open.larksuite.com"]);

/** Bound the entire response, even if a transport or body reader ignores abort. */
export async function withRequestDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  mutation: boolean,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new OperationError("feishu_aborted", "飞书请求已取消，尚未执行。");
  const controller = new AbortController();
  let cancel: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const interrupt = (code: string, message: string) => {
      const error = new OperationError(code, message, mutation ? "unknown" : "not_executed");
      reject(error);
      controller.abort(error);
    };
    cancel = () => interrupt("feishu_aborted", "飞书请求已取消，请核对状态后处理。");
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(
      () => interrupt("feishu_timeout", "等待飞书响应超时，请核对状态后处理。"),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([run(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export function officialURL(raw: string, hosts: ReadonlySet<string>): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hosts.has(url.hostname)
  ) {
    throw new OperationError("invalid_feishu_url", "拒绝非官方飞书地址。");
  }
  return url;
}

/** HTTP errors expose only status/outcome, never tokens or response bodies. */
export class FetchHttpClient implements HttpInstance {
  constructor(
    private readonly fetcher: Fetch = globalThis.fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async request<T = unknown, R = T, D = unknown>(options: RequestOptions<D>): Promise<R> {
    const url = officialURL(options.url ?? "", apiHosts);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const method = (options.method ?? "GET").toUpperCase();
    const mutation = method !== "GET" && method !== "HEAD";
    const headers = new Headers();
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (value !== undefined) headers.set(key, String(value));
    }
    let body: string | undefined;
    if (options.data !== undefined && method !== "GET" && method !== "HEAD") {
      body = typeof options.data === "string" ? options.data : JSON.stringify(options.data);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
    try {
      return await withRequestDeadline(
        async (signal) => {
          const response = await this.fetcher(url, {
            method,
            headers,
            body,
            redirect: "error",
            signal,
          });
          if (!response.ok) {
            const rejected = [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(
              response.status,
            );
            throw new OperationError(
              `feishu_http_${response.status}`,
              `飞书请求失败（HTTP ${response.status}）。`,
              mutation && !rejected ? "unknown" : "not_executed",
            );
          }
          const result: unknown = await response.json();
          return (
            options.$return_headers
              ? { data: result, headers: Object.fromEntries(response.headers) }
              : result
          ) as R;
        },
        options.timeout && options.timeout > 0 ? options.timeout : this.timeoutMs,
        mutation,
        options.signal,
      );
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError(
        "feishu_transport",
        "飞书请求结果未确认，请核对状态后处理。",
        mutation ? "unknown" : "not_executed",
      );
    }
  }

  get<T = unknown, R = T, D = unknown>(url: string, options?: RequestOptions<D>): Promise<R> {
    return this.request<T, R, D>({ ...options, url, method: "GET" });
  }
  delete<T = unknown, R = T, D = unknown>(url: string, options?: RequestOptions<D>): Promise<R> {
    return this.request<T, R, D>({ ...options, url, method: "DELETE" });
  }
  head<T = unknown, R = T, D = unknown>(url: string, options?: RequestOptions<D>): Promise<R> {
    return this.request<T, R, D>({ ...options, url, method: "HEAD" });
  }
  options<T = unknown, R = T, D = unknown>(url: string, options?: RequestOptions<D>): Promise<R> {
    return this.request<T, R, D>({ ...options, url, method: "OPTIONS" });
  }
  post<T = unknown, R = T, D = unknown>(
    url: string,
    data?: D,
    options?: RequestOptions<D>,
  ): Promise<R> {
    return this.request<T, R, D>({ ...options, url, data, method: "POST" });
  }
  put<T = unknown, R = T, D = unknown>(
    url: string,
    data?: D,
    options?: RequestOptions<D>,
  ): Promise<R> {
    return this.request<T, R, D>({ ...options, url, data, method: "PUT" });
  }
  patch<T = unknown, R = T, D = unknown>(
    url: string,
    data?: D,
    options?: RequestOptions<D>,
  ): Promise<R> {
    return this.request<T, R, D>({ ...options, url, data, method: "PATCH" });
  }
}
