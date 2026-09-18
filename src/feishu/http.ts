import type { HttpInstance, HttpRequestOptions } from "@larksuiteoapi/node-sdk";
import { OperationError } from "../core/errors.js";

export type Fetch = typeof globalThis.fetch;
export const apiHosts = new Set(["open.feishu.cn", "open.larksuite.com"]);

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

  async request<T = unknown, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> {
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
      const response = await this.fetcher(url, {
        method,
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(options.timeout ?? this.timeoutMs),
      });
      if (!response.ok) {
        const rejected = [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status);
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
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError(
        "feishu_transport",
        "飞书请求结果未确认，请核对状态后处理。",
        mutation ? "unknown" : "not_executed",
      );
    }
  }

  get<T = unknown, R = T, D = unknown>(url: string, options?: HttpRequestOptions<D>): Promise<R> {
    return this.request<T, R, D>({ ...options, url, method: "GET" });
  }
  delete<T = unknown, R = T, D = unknown>(
    url: string,
    options?: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.request<T, R, D>({ ...options, url, method: "DELETE" });
  }
  head<T = unknown, R = T, D = unknown>(url: string, options?: HttpRequestOptions<D>): Promise<R> {
    return this.request<T, R, D>({ ...options, url, method: "HEAD" });
  }
  options<T = unknown, R = T, D = unknown>(
    url: string,
    options?: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.request<T, R, D>({ ...options, url, method: "OPTIONS" });
  }
  post<T = unknown, R = T, D = unknown>(
    url: string,
    data?: D,
    options?: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.request<T, R, D>({ ...options, url, data, method: "POST" });
  }
  put<T = unknown, R = T, D = unknown>(
    url: string,
    data?: D,
    options?: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.request<T, R, D>({ ...options, url, data, method: "PUT" });
  }
  patch<T = unknown, R = T, D = unknown>(
    url: string,
    data?: D,
    options?: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.request<T, R, D>({ ...options, url, data, method: "PATCH" });
  }
}
