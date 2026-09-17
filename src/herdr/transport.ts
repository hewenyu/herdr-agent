import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { OperationError } from "../core/errors.js";
import { object, parseExactJson, string } from "./protocol.js";

const methods = new Set([
  "ping",
  "agent.list",
  "agent.get",
  "agent.read",
  "pane.get",
  "agent.prompt",
  "agent.send_keys",
  "notification.show",
  "workspace.create",
  "workspace.list",
  "agent.start",
  "pane.close",
]);
const writes = new Set([
  "agent.prompt",
  "agent.send_keys",
  "notification.show",
  "workspace.create",
  "agent.start",
  "pane.close",
]);
const definiteRefusals = new Set([
  "invalid_request",
  "invalid_params",
  "agent_not_found",
  "pane_not_found",
  "not_found",
  "agent_not_ready",
  "agent_not_idle",
  "agent_pane_busy",
  "empty_agent_prompt",
  "feature_disabled",
]);

export class HerdrTransport {
  constructor(
    readonly socketPath: string,
    readonly timeoutMs = 10_000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new OperationError("invalid_timeout", "herdr 超时必须为正数。");
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    readTimeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    if (!methods.has(method)) throw new OperationError("forbidden_method", "不支持此 herdr 操作。");
    if (method === "agent.read" && !["visible", "detection"].includes(String(params.source))) {
      throw new OperationError("forbidden_source", "仅允许读取 visible 或 detection。");
    }
    if (signal?.aborted) throw new OperationError("cancelled", "操作已取消。");
    const id = randomUUID();
    const request = Buffer.from(`${JSON.stringify({ id, method, params })}\n`);
    if (request.length > 1_048_576)
      throw new OperationError("request_too_large", "herdr 请求超过 1 MiB。");
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let attempted = false;
      let finished = false;
      let chunks: Buffer[] = [];
      let bytes = 0;
      let timer: NodeJS.Timeout;
      const outcome = () =>
        attempted && writes.has(method) ? ("unknown" as const) : ("not_executed" as const);
      const finish = (error?: unknown, result?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        chunks = [];
        if (error) reject(error);
        else resolve(result);
      };
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(
          () => finish(new OperationError("timeout", "herdr 请求超时。", outcome())),
          ms,
        );
      };
      const abort = () => finish(new OperationError("cancelled", "herdr 请求已取消。", outcome()));
      const decode = () => {
        try {
          const response = object(parseExactJson(Buffer.concat(chunks, bytes).toString("utf8")));
          if (response.error) {
            const error = object(response.error);
            const code = string(error.code) || "herdr_error";
            finish(
              new OperationError(
                code,
                string(error.message) || "herdr 拒绝请求。",
                definiteRefusals.has(code) ? "not_executed" : outcome(),
              ),
            );
          } else if (response.id !== id || !("result" in response)) {
            finish(
              new OperationError("invalid_response", "herdr 响应 ID 或结果不匹配。", outcome()),
            );
          } else finish(undefined, response.result);
        } catch (cause) {
          finish(
            new OperationError("invalid_response", "无法解析 herdr 响应。", outcome(), { cause }),
          );
        }
      };
      arm(this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => {
        arm(5_000);
        attempted = true;
        socket.write(request, (error) => {
          if (finished) return;
          if (error)
            finish(
              new OperationError("write_failed", "herdr 请求写入失败。", outcome(), {
                cause: error,
              }),
            );
          else arm(readTimeoutMs);
        });
      });
      socket.on("data", (chunk: Buffer) => {
        if (finished) return;
        const newline = chunk.indexOf(10);
        const part = newline < 0 ? chunk : chunk.subarray(0, newline);
        bytes += part.length;
        if (bytes > 8 * 1_048_576)
          return finish(
            new OperationError("response_too_large", "herdr 响应超过限制。", outcome()),
          );
        chunks.push(part);
        if (newline >= 0) decode();
      });
      socket.once("end", () => {
        if (finished) return;
        if (bytes) decode();
        else finish(new OperationError("empty_response", "herdr 未返回响应。", outcome()));
      });
      socket.once("error", (cause) =>
        finish(
          new OperationError(
            attempted ? "connection_failed" : "server_unavailable",
            "无法完成 herdr 连接。",
            outcome(),
            { cause },
          ),
        ),
      );
    });
  }
}
