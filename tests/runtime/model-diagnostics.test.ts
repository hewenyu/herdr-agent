import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createLogger } from "../../src/app/logger.js";
import { OperationError } from "../../src/core/errors.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { SessionService } from "../../src/runtime/sessions.js";
import type { EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "./helpers.js";

function input(tools: RuntimeTool[] = []): EngineInput {
  return {
    actor: { ownerId: "owner", chatId: "chat", sessionId: "session", messageId: "message" },
    sessionId: "session",
    prompt: "查询项目",
    messages: [],
    systemPrompt: "Only orchestrate",
    tools,
  };
}

for (const readOnly of [true, false]) {
  test(`provider failure after ${readOnly ? "read" : "write"} keeps precise side-effect outcome`, async () => {
    const checkpoints: unknown[] = [];
    const logs: string[] = [];
    let calls = 0;
    const engine = new PiEngine(config, {
      logger: createLogger((line) => logs.push(line)),
      streamFn: scripted([
        response("", [{ type: "toolCall", id: "query", name: "query", arguments: {} }]),
        {
          ...response(""),
          stopReason: "error",
          errorMessage: "Authorization: Bearer test-secret https://user:pass@host/?token=hidden",
          rawStopReason: "secret-stop-string",
        },
      ]),
    });
    const request = input([
      {
        name: "query",
        description: "query",
        parameters: { type: "object", properties: {} },
        readOnly,
        execute: async () => {
          calls++;
          return { ok: true };
        },
      },
    ]);
    request.onCheckpoint = (messages, diagnostic) => {
      checkpoints.push({ messages, diagnostic });
    };
    await assert.rejects(engine.run(request), (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "model_failed");
      assert.equal(error.outcome, readOnly ? "not_executed" : "unknown");
      return true;
    });
    assert.equal(calls, 1);
    const persisted = JSON.stringify(checkpoints);
    assert.match(persisted, /"category":"provider_error"/);
    for (const secret of ["test-secret", "user:pass", "token=hidden", "secret-stop-string"])
      assert.equal(`${persisted}${logs.join("")}`.includes(secret), false);
    const failure = logs
      .map((line) => JSON.parse(line))
      .find((line) => line.event === "pi.turn_failed");
    assert.equal(failure.category, "provider_error");
    assert.equal(failure.stopReason, "error");
    assert.equal(failure.httpStatus, undefined);
  });
}

for (const cause of ["timeout", "cancelled"] as const) {
  test(`${cause} is classified from the local abort source without guessing upstream cause`, async () => {
    const control = new AbortController();
    const checkpoints: unknown[] = [];
    const logs: string[] = [];
    const streamFn: StreamFn = (_model, _context, options) => {
      const stream = new AssistantMessageEventStream();
      options?.signal?.addEventListener(
        "abort",
        () => {
          stream.push({
            type: "error",
            reason: "aborted",
            error: { ...response(""), stopReason: "aborted", errorMessage: "test-secret" },
          });
        },
        { once: true },
      );
      if (cause === "cancelled") queueMicrotask(() => control.abort());
      return stream;
    };
    const engine = new PiEngine(
      { ...config, timeoutMs: cause === "timeout" ? 10 : 1000 },
      { streamFn, logger: createLogger((line) => logs.push(line)) },
    );
    await assert.rejects(
      engine.run({
        ...input(),
        signal: control.signal,
        onCheckpoint: (messages, diagnostic) => {
          checkpoints.push({ messages, diagnostic });
        },
      }),
      (error: unknown) => error instanceof OperationError && error.outcome === "not_executed",
    );
    assert.match(JSON.stringify(checkpoints), new RegExp(`"category":"${cause}"`));
    const failure = logs
      .map((line) => JSON.parse(line))
      .find((line) => line.event === "pi.turn_failed");
    assert.equal(failure.category, cause);
    assert.equal(failure.stopReason, "aborted");
    assert.equal(JSON.stringify(checkpoints).includes("test-secret"), false);
  });
}

for (const provider of ["openai-responses", "anthropic-messages"] as const) {
  test(`${provider} persists observed HTTP status without response secrets or extra requests`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "myrix-model-diagnostics-"));
    const store = new Store(join(directory, "state.sqlite"));
    const logs: string[] = [];
    let requests = 0;
    const engine = new PiEngine(
      { ...config, provider },
      {
        logger: createLogger((line) => logs.push(line)),
        fetch: async () => {
          requests++;
          return new Response(
            JSON.stringify({
              error: {
                message: "test-secret Authorization: Bearer private-value",
                type: "api_error",
              },
            }),
            {
              status: 503,
              headers: { "content-type": "application/json", "x-secret": "private-header" },
            },
          );
        },
      },
    );
    const sessions = new SessionService(store, engine);
    const session = sessions.current("owner", "chat");
    try {
      await assert.rejects(sessions.reply({ ...input().actor, sessionId: session.id }, "你好"));
      assert.equal(requests, 1);
      const checkpoint = store.list<{ diagnostic: unknown }>("pi_checkpoints")[0];
      assert.deepEqual(checkpoint?.diagnostic, {
        category: "provider_error",
        stopReason: "error",
        httpStatus: 503,
      });
      const failure = logs
        .map((line) => JSON.parse(line))
        .find((line) => line.event === "pi.turn_failed");
      assert.equal(failure.httpStatus, 503);
      const persisted =
        JSON.stringify(store.list("pi_checkpoints")) +
        logs.join("") +
        readdirSync(directory)
          .map((file) => readFileSync(join(directory, file)).toString("utf8"))
          .join("");
      for (const secret of ["test-secret", "private-value", "private-header"])
        assert.equal(persisted.includes(secret), false);
      assert.equal(store.list<{ status: string }>("turn_receipts")[0]?.status, "failed");
      assert.equal(
        store.list<{ role: string }>("messages").some((entry) => entry.role === "assistant"),
        false,
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("length termination is recorded as length without persisting arbitrary upstream stop text", async () => {
  const checkpoints: unknown[] = [];
  const engine = new PiEngine(config, {
    streamFn: scripted([
      { ...response("partial"), stopReason: "length", rawStopReason: "test-secret" },
    ]),
  });
  await assert.rejects(
    engine.run({
      ...input(),
      onCheckpoint: (messages, diagnostic) => {
        checkpoints.push({ messages, diagnostic });
      },
    }),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === "model_failed" &&
      error.outcome === "not_executed",
  );
  assert.match(JSON.stringify(checkpoints), /"category":"length"/);
  assert.equal(JSON.stringify(checkpoints).includes("test-secret"), false);
});

test("a later failed request cannot inherit an earlier successful HTTP status", async () => {
  const checkpoints: unknown[] = [];
  let requests = 0;
  const queue = scripted([
    response("", [{ type: "toolCall", id: "one", name: "query", arguments: {} }]),
    { ...response(""), stopReason: "error", errorMessage: "unknown upstream failure" },
  ]);
  const engine = new PiEngine(config, {
    streamFn: (model, context, options) => {
      if (++requests === 1) void options?.onResponse?.({ status: 200, headers: {} }, model);
      return queue(model, context, options);
    },
  });
  await assert.rejects(
    engine.run({
      ...input([
        {
          name: "query",
          description: "query",
          readOnly: true,
          parameters: { type: "object", properties: {} },
          execute: async () => ({ ok: true }),
        },
      ]),
      onCheckpoint: (messages, diagnostic) => {
        checkpoints.push({ messages, diagnostic });
      },
    }),
  );
  assert.equal(requests, 2);
  assert.deepEqual((checkpoints.at(-1) as { diagnostic: unknown }).diagnostic, {
    category: "provider_error",
    stopReason: "error",
  });
});
