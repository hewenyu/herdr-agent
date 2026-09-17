import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { OperationError } from "../core/errors.js";

export function parseListen(listen: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(listen);
  const host = match?.[1] ?? match?.[2] ?? "";
  const port = Number(match?.[3]);
  const loopback =
    host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (!loopback || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new OperationError(
      "invalid_listen",
      "Web 仅支持本机 loopback 地址，例如 127.0.0.1:18790。",
    );
  }
  return { host: host === "localhost" ? "127.0.0.1" : host, port };
}

export function sameToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyRequest(request: IncomingMessage, origin: string, csrf: string): void {
  const expected = new URL(origin);
  if (request.headers.host !== expected.host)
    throw new OperationError("forbidden_host", "请求 Host 与本机服务不符。");
  const suppliedOrigin = request.headers.origin;
  if (suppliedOrigin && suppliedOrigin !== expected.origin)
    throw new OperationError("forbidden_origin", "不接受其他站点的请求。");
  if (request.headers["sec-fetch-site"] === "cross-site")
    throw new OperationError("forbidden_origin", "不接受跨站请求。");
  if (request.method === "POST") {
    if (suppliedOrigin !== expected.origin || !sameToken(request.headers["x-csrf-token"], csrf)) {
      throw new OperationError("csrf_rejected", "页面授权已失效，请刷新后重试。");
    }
    if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) {
      throw new OperationError("invalid_content_type", "请求必须使用 JSON。");
    }
  }
}

export async function readBody(
  request: IncomingMessage,
  limit = 1_048_576,
): Promise<Record<string, unknown>> {
  if (Number(request.headers["content-length"] ?? 0) > limit)
    throw new OperationError("body_too_large", "请求正文超过 1 MiB。");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += part.length;
    if (bytes > limit) throw new OperationError("body_too_large", "请求正文超过 1 MiB。");
    chunks.push(part);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid object");
    return body as Record<string, unknown>;
  } catch (cause) {
    throw new OperationError("invalid_body", "请求正文不是有效 JSON 对象。", "not_executed", {
      cause,
    });
  }
}
