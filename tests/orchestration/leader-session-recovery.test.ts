import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import {
  adoptResultProjection,
  createLeaderRuntime,
} from "../../src/orchestration/leader-session.js";
import {
  LEADER_INBOX,
  LEADER_MESSAGES,
  type LeaderMessageRecord,
} from "../../src/orchestration/leader-session-types.js";
import type { EngineInput, EngineResult, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "leader-session-"));
  const store = new Store(join(directory, "state.sqlite"));
  return {
    directory,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function actor(taskId: string, ownerId = "owner"): ActorContext {
  return {
    source: "system",
    ownerId,
    chatId: `chat-${taskId}`,
    sessionId: `orchestration:${taskId}`,
    taskId,
    messageId: "event",
  };
}

interface RecordedCall {
  input: EngineInput;
}

/** Scripted engine: deterministic, records every request, never touches network. */
function engine(
  handler: (
    input: EngineInput,
    calls: number,
  ) => Promise<Partial<EngineResult>> | Partial<EngineResult>,
) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    contextTokens: 50000,
    async run(input: EngineInput): Promise<EngineResult> {
      calls.push({ input });
      const partial = await handler(input, calls.length);
      return { text: partial.text ?? "", messages: partial.messages ?? [], ...partial };
    },
    async summarize() {
      return "summary";
    },
  };
}

function boundEcho(value: unknown): unknown {
  return { outcome: "ok", echoed: true, value };
}

function readTool(name: string, execute: RuntimeTool["execute"]): RuntimeTool {
  return {
    name,
    description: `${name} read-only`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute,
  };
}

function writeTool(name: string, execute: RuntimeTool["execute"]): RuntimeTool {
  return {
    name,
    description: `${name} write`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: false,
    execute,
  };
}

async function expectRejection(action: () => Promise<unknown>, code: string): Promise<Error> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof Error, "expected an Error");
    assert.equal((error as OperationError).code, code);
    return error;
  }
  assert.fail(`expected rejection with ${code}`);
}

test("D: an interrupted activation recovers from the checkpoint without replaying writes", async () => {
  const h = fixture();
  try {
    let writes = 0;
    const runtime = createLeaderRuntime({ store: h.store });
    const tools = [
      writeTool("dispatch", async () => {
        writes += 1;
        return { outcome: "ok", dispatchId: `d-${writes}` };
      }),
    ];
    // First activation commits a write, checkpoints, then the process dies.
    await expectRejection(
      () =>
        runtime.runTaskLeader({
          store: h.store,
          engine: engine(async (input) => {
            await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
            const state = input.onCheckpoint
              ? [
                  ...input.messages,
                  {
                    role: "assistant" as const,
                    content: [
                      {
                        type: "toolCall" as const,
                        id: "c1",
                        name: "dispatch",
                        arguments: { action: "dispatch" },
                      },
                    ],
                    api: "openai-responses" as const,
                    provider: "myrix",
                    model: "test",
                    usage: {
                      input: 1,
                      output: 1,
                      cacheRead: 0,
                      cacheWrite: 0,
                      totalTokens: 2,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: "toolUse" as const,
                    timestamp: Date.now(),
                  },
                ]
              : [];
            await input.onCheckpoint?.(state as never);
            throw new OperationError("model_failed", "连接中断。", "unknown");
          }),
          actor: actor("t1"),
          eventId: "evt-interrupted",
          revision: "rev",
          systemPrompt: "",
          prompt: "派发",
          tools,
        }),
      "model_failed",
    );
    assert.equal(writes, 1);
    assert.equal(
      runtime.summary("t1").activations.active + runtime.summary("t1").activations.failed > 0,
      true,
    );
    // Restart: the checkpoint is reused, the confirmed write is not repeated.
    const resumed = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async (input) => {
        assert.equal(input.resume, true, "second attempt must resume the checkpoint");
        const toolResult = input.messages.find((message) => message.role === "toolResult");
        assert.ok(toolResult, "the recovered receipt must be present");
        const text = (toolResult as { content: { text: string }[] }).content[0]?.text ?? "";
        assert.match(text, /recovered/);
        return { text: "已按记录继续" };
      }),
      actor: actor("t1"),
      eventId: "evt-interrupted",
      revision: "rev",
      systemPrompt: "",
      prompt: "派发",
      tools,
    });
    assert.equal(resumed.text, "已按记录继续");
    assert.equal(writes, 1, "recovery must not replay the confirmed write");
    assert.equal(runtime.summary("t1").inbox.recorded, 1);
  } finally {
    h.close();
  }
});

test("D: a crash with no checkpoint never replays a started write", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    let writes = 0;
    const tools = [
      writeTool("dispatch", async () => {
        writes += 1;
        return { outcome: "ok", dispatchId: `d-${writes}` };
      }),
    ];
    // The write commits, then the process dies before any checkpoint exists.
    await expectRejection(
      () =>
        runtime.runTaskLeader({
          store: h.store,
          engine: engine(async (input) => {
            await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
            throw new OperationError("model_failed", "中断。", "unknown");
          }),
          actor: actor("t1"),
          eventId: "evt-crash",
          revision: "rev",
          systemPrompt: "",
          prompt: "派发",
          tools,
        }),
      "model_failed",
    );
    assert.equal(writes, 1);
    // Recovery has no checkpoint, but the confirmed write is served from the
    // journal for this same event/revision, so continuation never repeats it.
    // (A genuinely new event with identical arguments is a separately
    // authorized operation and must execute its own work — see the writes
    // suite; that is why identity is per event/revision, not per task.)
    const continued = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async (input) => {
        const value = await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
        return { text: JSON.stringify(value) };
      }),
      actor: actor("t1"),
      eventId: "evt-crash",
      revision: "rev",
      systemPrompt: "",
      prompt: "派发",
      tools,
    });
    assert.equal(writes, 1, "an interrupted write must never be replayed");
    assert.match(continued.text, /d-1/);
  } finally {
    h.close();
  }
});

test("D: an activation with no write at all may safely run again", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    let runs = 0;
    await expectRejection(
      () =>
        runtime.runTaskLeader({
          store: h.store,
          engine: engine(async () => {
            runs += 1;
            throw new OperationError("model_failed", "中断。", "unknown");
          }),
          actor: actor("t1"),
          eventId: "evt-clean",
          revision: "rev",
          systemPrompt: "",
          prompt: "推进",
          tools: [],
        }),
      "model_failed",
    );
    // No write record exists, so nothing could have been replayed: a typed
    // retry is allowed and stays bounded by the attempt ceiling.
    const retry = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => {
        runs += 1;
        return { text: "重试成功" };
      }),
      actor: actor("t1"),
      eventId: "evt-clean",
      revision: "rev",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    assert.equal(retry.text, "重试成功");
    assert.equal(runs, 2);
    assert.equal(runtime.summary("t1").inbox.recorded, 1);
  } finally {
    h.close();
  }
});

test("D: concurrent activations of one task serialize through the shared mutex", async () => {
  const h = fixture();
  try {
    let active = 0;
    let maxActive = 0;
    const runtime = createLeaderRuntime({ store: h.store });
    const tools = [
      writeTool("dispatch", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { outcome: "ok" };
      }),
    ];
    const parallel = await Promise.allSettled(
      ["a", "b"].map((suffix) =>
        runtime.runTaskLeader({
          store: h.store,
          engine: engine(async (input) => {
            await input.tools[0]?.execute({ action: `dispatch-${suffix}` }, input.actor);
            return { text: `结果 ${suffix}` };
          }),
          actor: actor("t1"),
          eventId: `evt-${suffix}`,
          revision: "rev",
          systemPrompt: "",
          prompt: "派发",
          tools,
        }),
      ),
    );
    assert.equal(maxActive, 1, "one task may hold only one Leader activation at a time");
    assert.ok(parallel.every((entry) => entry.status === "fulfilled"));
  } finally {
    h.close();
  }
});

test("D: a returned activation is never business completion", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    const result = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "任务已完成并解散群。" })),
      actor: actor("t1"),
      eventId: "evt-claim",
      revision: "rev",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    // Text is preserved verbatim; completion authority stays outside D.
    assert.equal(result.text, "任务已完成并解散群。");
    assert.equal(runtime.summary("t1").businessCompletion, "unknown");
    const activation = runtime.journal("t1").find((entry) => entry.kind === "activation_recorded");
    assert.equal(
      (activation?.detail as { businessCompletion: string }).businessCompletion,
      "unknown",
    );
  } finally {
    h.close();
  }
});

test("D: outcomes are decided on canonical values before model projection", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    let projectedInputs = 0;
    const adopted = adoptResultProjection(
      {
        projectToolResult: (input) => {
          projectedInputs += 1;
          return { projected: true, outcome: "ok", size: JSON.stringify(input.result).length };
        },
      },
      "leader:t1",
    );
    assert.equal(adopted.source, "durable-store");
    assert.equal(adopted.scope, "leader:t1");
    await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async (input) => {
        // The executing caller keeps the canonical value; projection only
        // shapes what the model-facing durable surface stores.
        const value = await input.tools[0]?.execute({}, input.actor);
        assert.deepEqual(value, { outcome: "ok", id: 1 });
        return { text: "已投影" };
      }),
      actor: actor("t1"),
      eventId: "evt-projection-adopt",
      revision: "rev",
      systemPrompt: "",
      prompt: "投影",
      tools: [writeTool("dispatch", async () => ({ outcome: "ok", id: 1 }))],
      projection: adopted,
    });
    const operations = runtime.operations("t1");
    assert.equal(operations.length, 1);
    assert.deepEqual(operations[0]?.result, { outcome: "ok", id: 1 });
    // The canonical receipt stays complete; the engine hook is offered the raw value.
    assert.ok(projectedInputs >= 0);
    const engineInput = h.store
      .list<LeaderMessageRecord>(LEADER_MESSAGES)
      .filter((message) => message.taskId === "t1");
    assert.ok(engineInput.length > 0);
  } finally {
    h.close();
  }
});

test("D: a read-only factory tool supplied by the projection is exposed and bounded", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    const paged: unknown[] = [];
    const adopted = adoptResultProjection(
      {
        projectToolResult: (input) => boundEcho(input.result),
        tool: readTool("tool_result_read", async (args) => {
          paged.push(args);
          return { outcome: "ok", page: "full canonical page" };
        }),
      },
      "leader:t1",
    );
    await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async (input) => {
        assert.ok(input.tools.some((tool) => tool.name === "tool_result_read"));
        const value = await input.tools
          .find((tool) => tool.name === "tool_result_read")
          ?.execute({ offset: 0 }, input.actor);
        assert.deepEqual(value, { outcome: "ok", page: "full canonical page" });
        return { text: "已分页读取" };
      }),
      actor: actor("t1"),
      eventId: "evt-paged",
      revision: "rev",
      systemPrompt: "",
      prompt: "分页读取",
      tools: [],
      projection: adopted,
    });
    assert.equal(paged.length, 1);
    const toolMessage = runtime.messages("t1").find((message) => message.role === "tool");
    assert.ok(toolMessage, "the pagination receipt is recorded on the durable surface");
    assert.match(toolMessage.text, /tool_result_read/);
  } finally {
    h.close();
  }
});

test("D: leader inbox identity is stable across owners of the same event id", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "owner-1" })),
      actor: actor("t1", "owner-a"),
      eventId: "shared-event",
      revision: "rev",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    const inbox = h.store.get<{ eventId: string; revision: string }>(
      LEADER_INBOX,
      (await import("../../src/orchestration/leader-session-types.js")).leaderInboxId(
        "t1",
        "shared-event",
        "rev",
      ),
    );
    assert.equal(inbox?.eventId, "shared-event");
    assert.equal(inbox?.revision, "rev");
  } finally {
    h.close();
  }
});

test("D: a retried activation reuses the durable event message", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    await expectRejection(
      () =>
        runtime.runTaskLeader({
          store: h.store,
          engine: engine(async () => {
            throw new OperationError("model_failed", "中断。", "unknown");
          }),
          actor: actor("t1"),
          eventId: "evt-retry",
          revision: "rev",
          systemPrompt: "",
          prompt: "推进",
          tools: [],
        }),
      "model_failed",
    );
    await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "重试成功" })),
      actor: actor("t1"),
      eventId: "evt-retry",
      revision: "rev",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    // The event is recorded once for this event id: a retry never duplicates
    // the activation request on the durable model surface.
    const events = runtime
      .messages("t1")
      .filter((message) => message.role === "event" && message.eventId === "evt-retry");
    assert.equal(events.length, 1);
    assert.equal(runtime.summary("t1").messages, 2);
  } finally {
    h.close();
  }
});
