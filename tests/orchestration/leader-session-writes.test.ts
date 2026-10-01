import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import { createLeaderRuntime, runTaskLeader } from "../../src/orchestration/leader-session.js";
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

function _boundEcho(value: unknown): unknown {
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

test("D: cross-task and cross-owner isolation is enforced", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "task-1" })),
      actor: actor("t1"),
      eventId: "evt",
      revision: "rev",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "task-2" })),
      actor: actor("t2"),
      eventId: "evt",
      revision: "rev",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    const t1 = runtime.messages("t1");
    const t2 = runtime.messages("t2");
    assert.ok(t1.length > 0 && t2.length > 0);
    assert.ok(t1.every((message) => message.taskId === "t1"));
    assert.ok(t2.every((message) => message.taskId === "t2"));
    assert.ok(t1.some((message) => message.text.includes("task-1")));
    assert.ok(!t1.some((message) => message.text.includes("task-2")));
    assert.equal(runtime.summary("t1").messages, t1.length);
    // A second owner cannot adopt another owner's task session.
    await expectRejection(
      () =>
        runtime.runTaskLeader({
          store: h.store,
          engine: engine(async () => ({ text: "stolen" })),
          actor: actor("t1", "intruder"),
          eventId: "evt-2",
          revision: "rev",
          systemPrompt: "",
          prompt: "推进",
          tools: [],
        }),
      "invalid_scope",
    );
    // A missing task binding is rejected before any state is written.
    await expectRejection(
      () =>
        runTaskLeader({
          store: h.store,
          engine: engine(async () => ({ text: "x" })),
          actor: { ...actor("t1"), taskId: undefined },
          eventId: "evt-3",
          revision: "rev",
          systemPrompt: "",
          prompt: "推进",
          tools: [],
        }),
      "task_required",
    );
  } finally {
    h.close();
  }
});

test("D: a confirmed write is never replayed by a retry of the same event/revision", async () => {
  const h = fixture();
  try {
    let writes = 0;
    const runtime = createLeaderRuntime({ store: h.store });
    const tools = [
      writeTool("dispatch", async () => {
        writes += 1;
        return { outcome: "ok", accepted: true, dispatchId: "d-1" };
      }),
    ];
    await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async (input) => {
        await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
        return { text: "已派发", writeCalls: 1 };
      }),
      actor: actor("t1"),
      eventId: "evt-write-1",
      revision: "rev",
      systemPrompt: "",
      prompt: "派发",
      tools,
    });
    assert.equal(writes, 1);
    // An identical call in a retry of the SAME event and revision reuses the
    // recorded canonical result instead of writing again.
    const replay = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async (input) => {
        const value = await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
        return { text: JSON.stringify(value), writeCalls: 1 };
      }),
      actor: actor("t1"),
      eventId: "evt-write-1",
      revision: "rev",
      systemPrompt: "",
      prompt: "再次派发",
      tools,
    });
    assert.equal(writes, 1, "an identical confirmed write must not run twice");
    // The canonical journal keeps the unbounded real value.
    const operations = runtime.operations("t1");
    assert.equal(operations.length, 1);
    assert.deepEqual(operations[0]?.result, { outcome: "ok", accepted: true, dispatchId: "d-1" });
    // The duplicate delivery replays its recorded receipt without a rerun.
    assert.equal(replay.text, "已派发");
  } finally {
    h.close();
  }
});

test("D: a new event with identical arguments executes its own authorized write", async () => {
  const h = fixture();
  try {
    let writes = 0;
    const runtime = createLeaderRuntime({ store: h.store });
    const tools = [
      writeTool("dispatch", async () => {
        writes += 1;
        return { outcome: "ok", accepted: true, dispatchId: `d-${writes}` };
      }),
    ];
    const run = (eventId: string, revision: string) =>
      runtime.runTaskLeader({
        store: h.store,
        engine: engine(async (input) => {
          const value = await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
          return { text: JSON.stringify(value), writeCalls: 1 };
        }),
        actor: actor("t1"),
        eventId,
        revision,
        systemPrompt: "",
        prompt: "派发",
        tools,
      });
    const first = await run("evt-new-1", "rev-1");
    // Identical arguments, but a separately authorized event and revision:
    // operation identity is per event/revision, so this is a new write.
    const second = await run("evt-new-2", "rev-2");
    assert.equal(writes, 2, "a new event must execute its own authorized operation");
    assert.match(first.text, /d-1/);
    assert.match(second.text, /d-2/);
    assert.equal(runtime.operations("t1").length, 2);
  } finally {
    h.close();
  }
});

test("D: an unknown write blocks continuation until an evidence decision", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    const tools = [
      writeTool("dispatch", async () => {
        throw new OperationError("transport_lost", "投递结果未知。", "unknown");
      }),
    ];
    await expectRejection(
      () =>
        runtime.runTaskLeader({
          store: h.store,
          engine: engine(async (input) => {
            await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
            return { text: "不会到达" };
          }),
          actor: actor("t1"),
          eventId: "evt-unknown",
          revision: "rev",
          systemPrompt: "",
          prompt: "派发",
          tools,
        }),
      "transport_lost",
    );
    const blocked = runtime.blockedWrites("t1");
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]?.state, "unknown");
    // Any later activation is blocked, including a fresh event.
    await expectRejection(
      () =>
        runtime.runTaskLeader({
          store: h.store,
          engine: engine(async () => ({ text: "继续" })),
          actor: actor("t1"),
          eventId: "evt-after-unknown",
          revision: "rev",
          systemPrompt: "",
          prompt: "继续",
          tools,
        }),
      "operation_unconfirmed",
    );
    // Only an evidence/user decision can release the task.
    runtime.resolveWrite({
      taskId: "t1",
      operationId: blocked[0]?.id as string,
      choice: "treat_done",
      decidedBy: "evidence",
      reason: "已核对远端回执",
      result: { outcome: "ok", dispatchId: "d-9" },
    });
    assert.equal(runtime.blockedWrites("t1").length, 0);
    const resumed = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "已恢复" })),
      actor: actor("t1"),
      eventId: "evt-after-unknown",
      revision: "rev",
      systemPrompt: "",
      prompt: "继续",
      tools,
    });
    assert.equal(resumed.text, "已恢复");
  } finally {
    h.close();
  }
});

test("D: projection failure after a completed write never replays the write", async () => {
  const h = fixture();
  try {
    let writes = 0;
    const runtime = createLeaderRuntime({
      store: h.store,
      projection: {
        scope: "leader:t1",
        source: "durable-store",
        projectToolResult: () => {
          throw new Error("projection storage failed");
        },
      },
    });
    const tools = [
      writeTool("deliver", async () => {
        writes += 1;
        return { outcome: "ok", delivered: true, receiptId: "r-1" };
      }),
    ];
    const result = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async (input) => {
        await input.tools[0]?.execute({ action: "deliver" }, input.actor);
        return { text: "已交付", writeCalls: 1 };
      }),
      actor: actor("t1"),
      eventId: "evt-projection",
      revision: "rev",
      systemPrompt: "",
      prompt: "交付",
      tools,
    });
    assert.equal(result.text, "已交付");
    assert.equal(writes, 1);
    // The projection failure is not a business failure: the canonical receipt
    // is complete and the operation is not retried.
    const operations = runtime.operations("t1");
    assert.equal(operations[0]?.state, "complete");
    assert.deepEqual(operations[0]?.result, { outcome: "ok", delivered: true, receiptId: "r-1" });
    assert.equal(writes, 1);
  } finally {
    h.close();
  }
});

test("D: a huge tool result stays canonical in storage and bounded for the model", async () => {
  const h = fixture();
  try {
    const huge = {
      outcome: "ok",
      payload: "x".repeat(400_000),
      items: Array.from({ length: 500 }, (_, i) => i),
    };
    const runtime = createLeaderRuntime({ store: h.store });
    let seen: unknown;
    const result = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async (input) => {
        seen = await input.tools[0]?.execute({ action: "audit" }, input.actor);
        return { text: "已读取审计", toolCalls: 1 };
      }),
      actor: actor("t1"),
      eventId: "evt-huge",
      revision: "rev",
      systemPrompt: "",
      prompt: "读取审计",
      tools: [readTool("task_audit", async () => huge)],
    });
    assert.equal(result.text, "已读取审计");
    // The engine receives the CANONICAL value, so tool evidence is evaluated on
    // the real receipt rather than on a lossy projection of it.
    assert.equal((seen as { payload: string }).payload.length, 400_000);
    // Every durable model-surface record stays bounded.
    const messages = runtime.messages("t1");
    for (const message of messages) {
      assert.ok(
        Buffer.byteLength(message.text, "utf8") <= 16_384,
        `message ${message.id} exceeded the model bound`,
      );
    }
    const toolMessage = messages.find((message) => message.role === "tool");
    assert.ok(toolMessage, "the tool receipt must be on the durable surface");
    // Read-only calls stay out of the write journal, exactly like before.
    assert.equal(runtime.operations("t1").length, 0);
  } finally {
    h.close();
  }
});

test("D: the activation prompt stays bounded across repeated activations", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    const prompts: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      await runtime.runTaskLeader({
        store: h.store,
        engine: engine(async (input) => {
          prompts.push(input.prompt);
          return { text: `第 ${index} 轮结果 ${"y".repeat(2000)}` };
        }),
        actor: actor("t1"),
        eventId: `evt-${index}`,
        revision: "rev",
        systemPrompt: "",
        prompt: `第 ${index} 轮事件 ${"z".repeat(4000)}`,
        tools: [],
      });
    }
    for (const prompt of prompts)
      assert.ok(Buffer.byteLength(prompt, "utf8") <= 12_288 + 512, "prompt must stay bounded");
    // History is bounded too, so repeated activations cannot grow context.
    const messages = runtime.messages("t1");
    const total = messages.reduce((sum, message) => sum + message.bytes, 0);
    assert.ok(total < 400_000, "bounded durable surface, not an append-only audit");
  } finally {
    h.close();
  }
});
