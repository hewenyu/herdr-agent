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

export function verifyRequest(request: IncomingMessage, origin: string): void {
  const expected = new URL(origin);
  if (request.headers.host !== expected.host)
    throw new OperationError("forbidden_host", "请求 Host 与本机服务不符。");
  const suppliedOrigin = request.headers.origin;
  if (suppliedOrigin && suppliedOrigin !== expected.origin)
    throw new OperationError("forbidden_origin", "不接受其他站点的请求。");
  if (request.headers["sec-fetch-site"] === "cross-site")
    throw new OperationError("forbidden_origin", "不接受跨站请求。");
}
