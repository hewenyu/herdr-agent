import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Application } from "../src/app/application.js";
import type { InboxRecord } from "../src/app/inbox.js";
import { loadConfig } from "../src/config/load.js";
import type { StoredMessage } from "../src/core/types.js";
import { HerdrRuntime } from "../src/herdr/runtime.js";
import { Store } from "../src/storage/store.js";

const reply = "本机打包调度检查完成。";
const prompt = "报告本机调度状态。SEA_INBOX_FIXTURE";
const ownerId = "ou_packaging_test";
type Provider = "openai-responses" | "anthropic-messages";

/** Persist an offline adapter fixture; only the copied SEA may execute its queued pi turn. */
async function enqueueFixture(stateDir: string, directory: string): Promise<string> {
  const config = loadConfig({ stateDir, home: directory, cwd: directory, env: {} });
  const store = new Store(join(stateDir, "state.sqlite"));
  const app = new Application({
    config,
    store,
    herdr: new HerdrRuntime(config.herdr),
    engine: {
      contextTokens: config.ai.contextTokens,
      async run() {
        throw new Error("Fixture setup must not execute a model");
      },
      async summarize() {
        throw new Error("Fixture setup must not execute a model");
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    await app.handlers().message({
      source: "feishu",
      ownerId,
      chatId: "oc_packaging_fixture",
      chatType: "private",
      mentionedBot: false,
      eventId: "evt_packaging_fixture",
      messageId: "om_packaging_fixture",
      text: prompt,
    });
    const queued = store.get<InboxRecord>("inbox", "message:om_packaging_fixture");
    assert.equal(queued?.state, "queued");
    assert.ok(queued?.actor?.sessionId);
    assert.deepEqual(store.list("messages"), []);
    return queued.actor.sessionId;
  } finally {
    await app.shutdown();
    store.close();
  }
}

function events(provider: Provider): unknown[] {
  if (provider === "openai-responses")
    return [
      { type: "response.created", response: { id: "resp_smoke" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_smoke", role: "assistant", content: [] },
      },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: reply },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_smoke",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: reply, annotations: [] }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_smoke",
          status: "completed",
          model: "packaging-test",
          output: [
            {
              type: "message",
              id: "msg_smoke",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: reply, annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ];
  return [
    {
      type: "message_start",
      message: {
        id: "msg_smoke",
        type: "message",
        role: "assistant",
        model: "packaging-test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
}

/** A loopback-only protocol fixture exercises the real bundled pi and SDK transports. */
export async function smokeModels(
  executableDirectory: string,
  run: (stateDir: string, inspect: (origin: string) => Promise<void>) => Promise<void>,
): Promise<void> {
  const calls: Provider[] = [];
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const provider = pathname === "/v1/responses" ? "openai-responses" : "anthropic-messages";
      assert.ok(
        ["/v1/responses", "/v1/messages"].includes(pathname),
        `Unexpected model endpoint: ${request.url}`,
      );
      assert.equal(request.method, "POST");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        model: string;
        tools: unknown[];
        stream: boolean;
      };
      assert.equal(body.model, "packaging-test");
      assert.equal(body.stream, true);
      assert.ok(body.tools.length > 0, "pi must supply the actual scheduling tools");
      assert.ok(JSON.stringify(body).includes(prompt), "SDK request must contain the queued input");
      calls.push(provider);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of events(provider)) {
        response.write(
          `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      }
      response.end();
    } catch (error) {
      errors.push(error);
      response.writeHead(500);
      response.end("fixture failure");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    for (const provider of ["openai-responses", "anthropic-messages"] as const) {
      const stateDir = join(executableDirectory, provider);
      await mkdir(stateDir, { mode: 0o700 });
      await writeFile(
        join(stateDir, "config.toml"),
        `
[feishu]
allowed_open_ids = ["${ownerId}"]
[tasks]
enabled = true
[herdr]
socket_path = ${JSON.stringify(join(executableDirectory, "no-herdr.sock"))}
[ai]
enabled = true
provider = "${provider}"
model = "packaging-test"
api_key = "local-fixture-only"
base_url = "http://127.0.0.1:${address.port}/v1"
timeout = "10s"
`,
        { mode: 0o600 },
      );
      const sessionId = await enqueueFixture(stateDir, executableDirectory);
      await run(stateDir, async (origin) => {
        const history = async () => {
          const response = await fetch(`${origin}/api/state?ownerId=${ownerId}`, {
            signal: AbortSignal.timeout(5_000),
          });
          assert.equal(response.status, 200, `${provider}: history unavailable`);
          return (await response.json()) as { messages: StoredMessage[] };
        };
        let message: StoredMessage | undefined;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const snapshot = await history();
          message = snapshot.messages.find(
            (entry) =>
              entry.sessionId === sessionId && entry.source === "pi" && entry.text === reply,
          );
          if (message?.delivery === "retryable") break;
          await delay(25);
        }
        assert.ok(
          message,
          `${provider}: queued SEA pi reply missing; ${errors.map(String).join("; ")}`,
        );
        assert.equal(message.delivery, "retryable", "No Feishu platform means no delivery ACK");
        assert.deepEqual(message.deliveryIds, []);
        assert.deepEqual(
          (await history()).messages.find((entry) => entry.id === message.id),
          message,
          "Browsing history must not acknowledge the unsent reply",
        );
      });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, ["openai-responses", "anthropic-messages"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
