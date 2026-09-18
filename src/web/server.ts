import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { OperationError, safeError } from "../core/errors.js";
import type { WebAssets, WebBackend } from "./contracts.js";
import { parseListen, verifyRequest } from "./security.js";

export interface WebOptions {
  listen: string;
  backend: WebBackend;
  assets?: WebAssets;
}
const contentTypes = {
  "index.html": "text/html; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
};

async function developmentAssets(): Promise<WebAssets> {
  const root = new URL("./assets/", import.meta.url);
  const [html, css] = await Promise.all([
    readFile(new URL("index.html", root)),
    readFile(new URL("styles.css", root)),
  ]);
  // Development bundles only trusted local source. Production injects all assets in memory.
  const { build } = await import("esbuild");
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./client/app.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "browser",
    target: "es2022",
    format: "esm",
  });
  const js = bundle.outputFiles?.[0]?.contents;
  if (!js) throw new Error("Web bundle missing");
  return { "index.html": html, "styles.css": css, "app.js": js };
}

function headers(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

export async function startWeb(
  options: WebOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  const address = parseListen(options.listen);
  const assets = options.assets ?? (await developmentAssets());
  const subscribers = new Set<ServerResponse>();
  let origin = "";
  let closed = false;
  const server = createServer(async (request, response) => {
    headers(response);
    try {
      verifyRequest(request, origin);
      const target = new URL(request.url ?? "/", origin);
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        json(response, 405, {
          ok: false,
          error: { code: "read_only", message: "Web 仅供查看会话记录。", outcome: "not_executed" },
        });
        return;
      }
      if (request.method === "GET" && target.pathname === "/api/state") {
        json(
          response,
          200,
          options.backend.history(target.searchParams.get("ownerId") ?? undefined),
        );
        return;
      }
      if (request.method === "GET" && target.pathname === "/api/events") {
        if (subscribers.size >= 32) {
          json(response, 503, { error: "too_many_clients" });
          return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        response.write("event: ready\ndata: {}\n\n");
        subscribers.add(response);
        response.on("close", () => subscribers.delete(response));
        return;
      }
      const name = target.pathname === "/" ? "index.html" : target.pathname.slice(1);
      if (request.method === "GET" && Object.hasOwn(contentTypes, name)) {
        const key = name as keyof WebAssets;
        response.writeHead(200, { "Content-Type": contentTypes[key] });
        response.end(assets[key]);
        return;
      }
      json(response, 404, {
        error: { code: "not_found", message: "页面不存在。", outcome: "not_executed" },
      });
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const failure = safeError(error);
      const status =
        failure.code === "body_too_large"
          ? 413
          : /forbidden|csrf/.test(failure.code)
            ? 403
            : error instanceof OperationError
              ? 400
              : 500;
      json(response, status, { ok: false, error: failure });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address.port, address.host, resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Web listener has no port");
  origin = `http://${address.host.includes(":") ? `[${address.host}]` : address.host}:${bound.port}`;
  const notify = () => {
    for (const response of subscribers) {
      if (response.writableLength > 64 * 1_024 || !response.write("event: change\ndata: {}\n\n")) {
        response.end();
        subscribers.delete(response);
      }
    }
  };
  const unsubscribe = options.backend.subscribe(notify);
  const heartbeat = setInterval(() => {
    for (const response of subscribers) response.write(": heartbeat\n\n");
  }, 20_000);
  heartbeat.unref();
  return {
    url: origin,
    close: async () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      for (const response of subscribers) response.end();
      subscribers.clear();
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
