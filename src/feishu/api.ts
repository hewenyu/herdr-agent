import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { OperationError } from "../core/errors.js";
import type { Logger } from "../core/ports.js";
import { FetchHttpClient } from "./http.js";

export interface APIRequest {
  method: string;
  url: string;
  data?: Record<string, unknown>;
  params?: Record<string, string>;
}
export type Requester = (input: APIRequest) => Promise<unknown>;
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** SDK arguments may contain secrets and message bodies: never forward them. */
export function sdkLogger(logger?: Logger) {
  return {
    error: (..._args: unknown[]) => logger?.error("飞书 SDK 请求或连接异常。"),
    warn: (..._args: unknown[]) => logger?.warn("飞书 SDK 状态需要检查。"),
    info: (..._args: unknown[]) => {},
    debug: (..._args: unknown[]) => {},
    trace: (..._args: unknown[]) => {},
  };
}

const definiteRejections = new Set([
  10003, 10005, 10014, 10015, 20002, 230001, 230002, 230006, 230013, 230017, 230020, 230027, 232009,
  99991400, 99991401, 99991661, 99991663, 99991664, 99991668, 99991669, 99991671, 99991672,
]);

export class FeishuAPI {
  readonly request: Requester;
  constructor(options: { appId: string; appSecret: string; logger?: Logger }, request?: Requester) {
    if (request) {
      this.request = request;
      return;
    }
    const client = new Client({
      ...options,
      logger: sdkLogger(options.logger),
      loggerLevel: LoggerLevel.warn,
      httpInstance: new FetchHttpClient(),
      source: "herdr-agent",
    });
    this.request = (input) => client.request<unknown>({ ...input, timeout: 15_000 });
  }

  async call(input: APIRequest): Promise<Record<string, unknown>> {
    try {
      const body = object(await this.request(input));
      if (body.code !== 0) {
        const code = typeof body.code === "number" ? body.code : "invalid_response";
        throw new OperationError(
          `feishu_${code}`,
          `飞书请求未成功（${code}）。`,
          input.method !== "GET" && (typeof code !== "number" || !definiteRejections.has(code))
            ? "unknown"
            : "not_executed",
        );
      }
      return body;
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError(
        "feishu_transport",
        "飞书请求结果未确认，请核对状态后处理。",
        input.method === "GET" ? "not_executed" : "unknown",
      );
    }
  }
}
