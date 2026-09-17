import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

const reply = "本机打包调度检查完成。";
type Provider = "openai-responses" | "anthropic-messages";

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
allowed_open_ids = ["ou_packaging_test"]
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
      await run(stateDir, async (origin) => {
        const page = await fetch(origin, { signal: AbortSignal.timeout(5_000) });
        const token = (await page.text()).match(/name="csrf-token" content="([a-f0-9]+)"/)?.[1];
        assert.ok(token);
        const action = async (name: string, input: Record<string, unknown>) => {
          const response = await fetch(`${origin}/api/actions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: origin, "X-CSRF-Token": token },
            body: JSON.stringify({ action: name, input }),
            signal: AbortSignal.timeout(15_000),
          });
          const body = (await response.json()) as {
            ok: boolean;
            result: { id: string; sessionId: string; text: string };
            error?: unknown;
          };
          assert.equal(
            response.status,
            200,
            `${provider}: ${JSON.stringify(body)}; fixture: ${errors.map(String).join("; ")}`,
          );
          assert.ok(body.ok);
          return body.result;
        };
        const session = await action("session.create", { name: `SEA ${provider}` });
        const message = await action("chat.send", {
          sessionId: session.id,
          text: "报告本机调度状态。",
        });
        assert.equal(message.text, reply);
        await action("chat.ack", { sessionId: session.id, messageId: message.id });
        const state = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(5_000) });
        const snapshot = (await state.json()) as { messages: { id: string; delivery: string }[] };
        assert.equal(
          snapshot.messages.find((entry) => entry.id === message.id)?.delivery,
          "delivered",
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
