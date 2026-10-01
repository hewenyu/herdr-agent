import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type {
  ConversationEngine,
  EngineInput,
  EngineResult,
  RuntimeTool,
} from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "../runtime/helpers.js";

/**
 * Independent adversarial acceptance for the durable per-task Leader.
 *
 * These tests drive the frozen `runTaskLeader` entry point and the durable
 * `Store` directly, with a real cold resume (close the database file, reopen it)
 * rather than an in-memory stand-in. The scripted model is a transport double
 * only: identity, journaling, dedup, supersession, recovery and isolation are
 * all exercised against real durable records, so passing cannot mean that a
 * mock bypassed the runtime boundary.
 */

interface LeaderModule {
  runTaskLeader: (input: Record<string, unknown>) => Promise<EngineResult>;
  leaderRuntime?: (store: Store) => LeaderRuntimeLike;
  createLeaderRuntime?: (options: Record<string, unknown>) => LeaderRuntimeLike;
}

interface LeaderRuntimeLike {
  runTaskLeader: (input: Record<string, unknown>) => Promise<EngineResult>;
  summary(taskId: string): Record<string, unknown>;
  session(taskId: string): Record<string, unknown> | undefined;
  operations(taskId: string): Array<Record<string, unknown>>;
  blockedWrites(taskId: string): Array<Record<string, unknown>>;
  messages(taskId: string): Array<Record<string, unknown>>;
  resolveWrite(input: Record<string, unknown>): Record<string, unknown>;
}

/** Loaded through a widened specifier so the test file type-checks before D lands. */
async function leader(): Promise<LeaderModule> {
  const specifier = ["..", "..", "src", "orchestration", "leader-session.js"].join("/");
  return (await import(specifier)) as LeaderModule;
}

/** A payload comfortable above the Leader's bounded prompt budget. */
function giantText(bytes: number): string {
  return "审".repeat(bytes);
}

/** Serialized size of the value actually handed to the model. */
function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
}

function actor(taskId: string, ownerId = "owner"): ActorContext {
  return {
    source: "system",
    ownerId,
    chatId: `chat:${taskId}`,
    sessionId: `outer:${taskId}`,
    taskId,
    messageId: "activation",
  };
}

function tool(name: string, readOnly: boolean, execute: RuntimeTool["execute"]): RuntimeTool {
  return {
    name,
    description: name,
    readOnly,
    parameters: { type: "object", properties: { action: { type: "string" } } },
    execute,
  };
}

/**
 * Normalizes the scripted transport: `messages` is optional at the call sites
 * below so each test states only the facts it is actually asserting.
 */
function engine(
  run: (input: EngineInput) => Promise<{ text: string } & Partial<EngineResult>>,
): ConversationEngine {
  return {
    contextTokens: 50_000,
    summarize: async () => "",
    run: async (input) => ({ messages: [], ...(await run(input)) }),
  };
}

function activation(
  store: Store,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    store,
    actor: actor("t1"),
    eventId: "evt-1",
    revision: "rev-1",
    systemPrompt: "Only the authorized task-scoped scheduling action.",
    prompt: JSON.stringify({ taskId: "t1", phase: "discussing" }),
    tools: [],
    ...overrides,
  };
}

function database(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "herdr-leader-acceptance-"));
  return {
    path: join(directory, "state.sqlite"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("distinct tasks get independent durable Leader sessions and transcripts", async () => {
  const { runTaskLeader, leaderRuntime } = await leader();
  const store = new Store(":memory:");
  try {
    for (const taskId of ["t1", "t2"]) {
      await runTaskLeader(
        activation(store, {
          actor: actor(taskId),
          eventId: "evt-shared",
          revision: "rev-1",
          prompt: `state for ${taskId}`,
          engine: engine(async () => ({ text: `leader answer for ${taskId}` })),
        }),
      );
    }
    const runtime = leaderRuntime?.(store);
    assert.ok(runtime, "the runtime must expose an inspection surface for tests");
    const first = runtime.session("t1") as { id?: string; taskId?: string } | undefined;
    const second = runtime.session("t2") as { id?: string; taskId?: string } | undefined;
    assert.ok(first?.id && second?.id);
    assert.notEqual(first.id, second.id, "one Leader session per task");
    assert.equal(first.taskId, "t1");
    assert.equal(second.taskId, "t2");
    // The outer management session identity must never appear as a Leader session.
    assert.notEqual(first.id, "outer:t1");
    const messages = (taskId: string) =>
      JSON.stringify(runtime.messages(taskId).map((message) => message.text));
    assert.match(messages("t1"), /leader answer for t1/);
    assert.doesNotMatch(messages("t1"), /leader answer for t2/);
    assert.match(messages("t2"), /leader answer for t2/);
    assert.doesNotMatch(messages("t2"), /leader answer for t1/);
  } finally {
    store.close();
  }
});

test("a cold resume dedupes the same event with stable identities and no duplicate effect", async () => {
  const { runTaskLeader, leaderRuntime } = await leader();
  const { path, cleanup } = database();
  let calls = 0;
  let sends = 0;
  const run = async (store: Store, effect: () => void) =>
    runTaskLeader(
      activation(store, {
        engine: engine(async (input) => {
          calls++;
          await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
          return { text: "已派发给参与者", toolCalls: 1, writeCalls: 1 };
        }),
        tools: [
          tool("participant_send", false, async () => {
            effect();
            return { verified: true, dispatchId: "d-1" };
          }),
        ],
      }),
    );
  try {
    const first = new Store(path);
    const reply = await run(first, () => {
      sends++;
    });
    const firstRuntime = leaderRuntime?.(first);
    const inboxId = (firstRuntime?.summary("t1") as { sessionId?: string } | undefined)?.sessionId;
    const before = firstRuntime?.messages("t1").length;
    first.close();

    const reopened = new Store(path);
    try {
      const replay = await run(reopened, () => {
        sends++;
      });
      assert.equal(calls, 1, "a cold resume must not call the engine again");
      assert.equal(sends, 1, "a cold resume must not repeat a confirmed send");
      assert.equal(replay.text, reply.text, "the recorded receipt is returned verbatim");
      const runtime = leaderRuntime?.(reopened);
      assert.ok(runtime);
      assert.equal(runtime.summary("t1").sessionId, inboxId, "session identity stays stable");
      assert.equal(runtime.messages("t1").length, before, "no duplicate transcript rows");
      assert.equal(runtime.operations("t1").length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

test("an unknown write blocks continuation across a cold restart and is never replayed", async () => {
  const { runTaskLeader, leaderRuntime } = await leader();
  const { path, cleanup } = database();
  let attempts = 0;
  try {
    const first = new Store(path);
    await assert.rejects(
      runTaskLeader(
        activation(first, {
          engine: engine(async (input) => {
            await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
            return { text: "不会到达" };
          }),
          tools: [
            tool("participant_send", false, async () => {
              attempts++;
              throw new OperationError("delivery_unknown", "投递结果未知。", "unknown");
            }),
          ],
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.outcome, "unknown", "the typed outcome must survive");
        return true;
      },
    );
    assert.equal(attempts, 1);
    first.close();

    const reopened = new Store(path);
    try {
      const runtime = leaderRuntime?.(reopened);
      assert.ok(runtime);
      const blocked = runtime.blockedWrites("t1");
      assert.equal(blocked.length, 1, "unknown writes stay durable across a restart");
      assert.equal(blocked[0]?.state, "unknown");
      await assert.rejects(
        runTaskLeader(
          activation(reopened, {
            eventId: "evt-2",
            revision: "rev-2",
            engine: engine(async () => ({ text: "继续" })),
            tools: [
              tool("participant_send", false, async () => {
                attempts++;
                return { verified: true };
              }),
            ],
          }),
        ),
        (error: unknown) => {
          assert.ok(error instanceof OperationError);
          assert.equal(error.code, "operation_unconfirmed");
          assert.equal(error.outcome, "unknown");
          return true;
        },
      );
      assert.equal(attempts, 1, "a new event must not bypass an unresolved effect");
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

test("a projection failure after a durable write never replays the write", async () => {
  const { runTaskLeader, leaderRuntime, createLeaderRuntime } = await leader();
  const store = new Store(":memory:");
  let writes = 0;
  try {
    const projection = {
      scope: "leader:t1",
      source: "durable-store" as const,
      projectToolResult: () => {
        throw new OperationError("projection_failed", "结果投影失败。", "unknown");
      },
    };
    const runtime = createLeaderRuntime?.({ store, projection });
    const run = (runtime?.runTaskLeader ?? runTaskLeader) as LeaderModule["runTaskLeader"];
    await run(
      activation(store, {
        projection,
        engine: engine(async (input) => {
          await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
          return { text: "已派发", writeCalls: 1 };
        }),
        tools: [
          tool("participant_send", false, async () => {
            writes++;
            return { verified: true };
          }),
        ],
      }),
    );
    assert.equal(writes, 1);
    // The projection is repeatedly broken. Re-delivering the SAME event and
    // revision must not repeat the write: projection failure is not a business
    // failure, and the recorded receipt is reused.
    await run(
      activation(store, {
        projection,
        engine: engine(async (input) => {
          await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
          return { text: "已派发", writeCalls: 1 };
        }),
        tools: [
          tool("participant_send", false, async () => {
            writes++;
            return { verified: true };
          }),
        ],
      }),
    );
    assert.equal(writes, 1, "a completed write is never replayed because formatting failed");
    const runtimeLike = (runtime ?? leaderRuntime?.(store)) as LeaderRuntimeLike;
    assert.equal(runtimeLike.operations("t1")[0]?.state, "complete");
    // A genuinely new scheduling event may perform its own authorized write, and
    // the broken projection must not have poisoned the durable surface.
    await run(
      activation(store, {
        projection,
        eventId: "evt-2",
        revision: "rev-2",
        engine: engine(async (input) => {
          await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
          return { text: "已派发", writeCalls: 1 };
        }),
        tools: [
          tool("participant_send", false, async () => {
            writes++;
            return { verified: true };
          }),
        ],
      }),
    );
    assert.equal(writes, 2, "a new event performs its own authorized write");
    assert.equal(runtimeLike.operations("t1").length, 2);
    assert.ok(
      runtimeLike.operations("t1").every((operation) => operation.state === "complete"),
      "projection failure never downgrades a completed write",
    );
  } finally {
    store.close();
  }
});

test("an unrecorded or overtaken revision never executes a scheduling action", async () => {
  const { runTaskLeader, leaderRuntime } = await leader();
  const store = new Store(":memory:");
  let writes = 0;
  try {
    await runTaskLeader(
      activation(store, {
        eventId: "evt-rev",
        revision: "rev-2",
        engine: engine(async () => ({ text: "最新修订已处理" })),
      }),
    );
    // An old revision that was never recorded for this event is unknown, not a
    // silent success: it must fail typed and never reach the model or a tool.
    await assert.rejects(
      runTaskLeader(
        activation(store, {
          eventId: "evt-rev",
          revision: "rev-1",
          engine: engine(async () => {
            writes++;
            return { text: "不应执行" };
          }),
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.outcome, "not_executed", "a stale revision is a typed non-execution");
        assert.equal(error.code, "revision_stale");
        return true;
      },
    );
    assert.equal(writes, 0, "a stale revision must never reach the model or a tool");
    // A revision that was recorded and completed replays its receipt verbatim;
    // re-delivering it must never call the engine again.
    const duplicate = await runTaskLeader(
      activation(store, {
        eventId: "evt-rev",
        revision: "rev-2",
        engine: engine(async () => {
          writes++;
          return { text: "不应重跑" };
        }),
      }),
    );
    assert.equal(writes, 0, "a recorded revision replays its receipt");
    assert.equal(duplicate.text, "最新修订已处理");
    const runtime = leaderRuntime?.(store);
    assert.ok(runtime);
    assert.equal(runtime.operations("t1").length, 0);
    assert.ok(
      JSON.stringify(runtime.messages("t1")).includes("最新修订已处理"),
      "the current revision's answer stays in the durable transcript",
    );
  } finally {
    store.close();
  }
});

test("a revision change during inference fences the action before any write", async () => {
  const { runTaskLeader } = await leader();
  const store = new Store(":memory:");
  let current = true;
  let writes = 0;
  try {
    await assert.rejects(
      runTaskLeader(
        activation(store, {
          assertCurrent: () => {
            if (!current) throw new OperationError("orchestration_superseded", "用户修订已变化。");
          },
          engine: engine(async (input) => {
            current = false;
            await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
            return { text: "过期的调度" };
          }),
          tools: [
            tool("participant_send", false, async () => {
              writes++;
              return { verified: true };
            }),
          ],
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, "orchestration_superseded");
        return true;
      },
    );
    assert.equal(writes, 0, "a stale activation must not write to the outside world");
    // The failed activation is visible and does not claim business completion.
    const messages = JSON.stringify(store.list("leader_messages"));
    assert.doesNotMatch(messages, /过期的调度/);
  } finally {
    store.close();
  }
});

test("the Leader runtime exposes no task lifecycle authority and never claims completion", async () => {
  const { runTaskLeader, leaderRuntime } = await leader();
  const store = new Store(":memory:");
  const names: string[] = [];
  try {
    const result = await runTaskLeader(
      activation(store, {
        engine: engine(async (input) => {
          for (const entry of input.tools) names.push(entry.name);
          return { text: "本轮已安排下一步。", toolCalls: 0 };
        }),
        tools: [
          tool("participant_send", false, async () => ({ verified: true })),
          tool("task_get", true, async () => ({ id: "t1", status: "running" })),
        ],
      }),
    );
    assert.equal(result.text, "本轮已安排下一步。");
    const runtime = leaderRuntime?.(store);
    assert.ok(runtime);
    const summary = runtime.summary("t1");
    assert.equal(summary.businessCompletion, "unknown");
    assert.equal(summary.version, 1);
    // No lifecycle verb or tool may be exposed through the inspection surface.
    const surface = JSON.stringify({
      summary,
      session: runtime.session("t1"),
      messages: runtime.messages("t1"),
      operations: runtime.operations("t1"),
    });
    for (const forbidden of ["task_complete", "task_action", "task_create", "destroy", "close"])
      assert.doesNotMatch(surface, new RegExp(`"${forbidden}"`));
    // The per-message read-only paging tool is a legitimate addition; what must
    // never appear is a lifecycle or outer-management tool.
    for (const name of names)
      assert.doesNotMatch(
        name,
        /task_(action|create|complete|close|destroy)|session_clear|participant_(add|remove)/,
      );
    assert.ok(names.includes("task_get"), "the Leader keeps its read path");
  } finally {
    store.close();
  }
});

test("concurrent activations of one task serialize while distinct tasks stay independent", async () => {
  const { runTaskLeader } = await leader();
  const store = new Store(":memory:");
  let concurrent = 0;
  let highest = 0;
  let calls = 0;
  try {
    const run = (taskId: string, eventId: string) =>
      runTaskLeader(
        activation(store, {
          actor: actor(taskId),
          eventId,
          engine: engine(async () => {
            calls++;
            concurrent++;
            highest = Math.max(highest, concurrent);
            await new Promise((resolve) => setTimeout(resolve, 20));
            concurrent--;
            return { messages: [], text: `${taskId}:${eventId} done` };
          }),
        }),
      );
    const results = await Promise.all([
      run("t1", "evt-a"),
      run("t1", "evt-b"),
      run("t2", "evt-a"),
      run("t2", "evt-b"),
    ]);
    assert.equal(calls, 4, "each distinct event activates exactly once");
    assert.equal(highest, 2, "at most one activation per task runs at a time");
    assert.deepEqual(results.map((result) => result.text).sort(), [
      "t1:evt-a done",
      "t1:evt-b done",
      "t2:evt-a done",
      "t2:evt-b done",
    ]);
  } finally {
    store.close();
  }
});

test("an interrupted activation recovers from its checkpoint without replaying the write", async () => {
  const { runTaskLeader, leaderRuntime } = await leader();
  const { path, cleanup } = database();
  let writes = 0;
  let calls = 0;
  try {
    const first = new Store(path);
    // The engine checkpoints a tool call, then dies: the durable checkpoint and
    // the completed operation must be reused rather than re-executed.
    const failing: ConversationEngine = {
      contextTokens: 50_000,
      summarize: async () => "",
      run: async (input: EngineInput) => {
        calls++;
        await input.tools[0]?.execute({ action: "dispatch" }, input.actor);
        input.onCheckpoint?.([
          { role: "user", content: "activate", timestamp: Date.now() },
          {
            role: "assistant",
            api: "openai-responses",
            provider: "myrix",
            model: "test",
            content: [
              {
                type: "toolCall",
                id: "call",
                name: "participant_send",
                arguments: { action: "dispatch" },
              },
            ],
            stopReason: "toolUse",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        ]);
        throw new OperationError("model_failed", "provider disconnected", "unknown");
      },
    };
    const tools = [
      tool("participant_send", false, async () => {
        writes++;
        return { verified: true, dispatchId: "d-1" };
      }),
    ];
    await assert.rejects(
      runTaskLeader(activation(first, { engine: failing, tools })),
      (error: unknown) => error instanceof OperationError && error.code === "model_failed",
    );
    assert.equal(calls, 1);
    assert.equal(writes, 1);
    first.close();

    const reopened = new Store(path);
    try {
      const resumed = await runTaskLeader(
        activation(reopened, {
          engine: engine(async (input) => {
            calls++;
            // The recovered transcript must already contain the confirmed receipt.
            const recovered = JSON.stringify(input.messages);
            assert.match(recovered, /d-1/, "the confirmed result is recovered from the journal");
            return { text: "已按恢复结果继续" };
          }),
          tools,
        }),
      );
      assert.equal(writes, 1, "a recovered confirmed write is never replayed");
      assert.equal(calls, 2);
      assert.equal(resumed.text, "已按恢复结果继续");
      const runtime = leaderRuntime?.(reopened);
      assert.ok(runtime);
      assert.equal(runtime.operations("t1").length, 1);
      assert.equal(runtime.operations("t1")[0]?.state, "complete");
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

test("activation prompts and durable history stay bounded across many activations", async () => {
  const { runTaskLeader, leaderRuntime } = await leader();
  const store = new Store(":memory:");
  const promptBytes: number[] = [];
  const requestBytes: number[] = [];
  let lastRequestMessages = 0;
  try {
    for (let index = 0; index < 12; index++) {
      await runTaskLeader(
        activation(store, {
          eventId: `evt-${index}`,
          revision: `rev-${index}`,
          // A per-activation payload far larger than any sane prompt budget.
          prompt: JSON.stringify({ index, filler: giantText(40_000) }),
          engine: engine(async (input) => {
            promptBytes.push(Buffer.byteLength(input.prompt, "utf8"));
            requestBytes.push(
              Buffer.byteLength(JSON.stringify(input.messages), "utf8") +
                Buffer.byteLength(input.prompt, "utf8"),
            );
            lastRequestMessages = input.messages.length;
            return { text: `答复 ${index}：完整决策历史不应进入下一轮提示。` };
          }),
        }),
      );
    }
    assert.equal(promptBytes.length, 12);
    for (const bytes of promptBytes)
      assert.ok(bytes <= 16 * 1024, `activation prompt was ${bytes} bytes`);
    const runtime = leaderRuntime?.(store);
    assert.ok(runtime);
    // Later activations must not accumulate the whole decision history: the
    // request stays bounded even though every activation is durable.
    const first = requestBytes[0] ?? 0;
    const last = requestBytes[11] ?? 0;
    assert.ok(last < first * 4, `request grew from ${first} to ${last} bytes`);
    // ...but "bounded" must not mean "empty": the per-task Leader is supposed to
    // carry its own durable context forward, so a later activation must still
    // see an earlier answer (bounded), not a single fresh event message.
    assert.ok(
      lastRequestMessages > 1,
      `later activation received only ${lastRequestMessages} messages; durable history was not carried`,
    );
    assert.equal(runtime.messages("t1").length, 24, "every activation stays durable");
    const summary = runtime.summary("t1");
    assert.equal(summary.businessCompletion, "unknown");
  } finally {
    store.close();
  }
});

test("the prompt surface excludes outer-session and foreign-task content", async () => {
  const { runTaskLeader } = await leader();
  const store = new Store(":memory:");
  const seen: string[] = [];
  try {
    await runTaskLeader(
      activation(store, {
        actor: { ...actor("t1"), sessionId: "outer-management-session" },
        engine: engine(async (input) => {
          seen.push(input.prompt);
          seen.push(input.systemPrompt);
          seen.push(JSON.stringify(input.messages));
          return { text: "ok" };
        }),
      }),
    );
    const surface = seen.join("\n");
    // The outer management transcript and any foreign task content never enter
    // the Leader's own surface.
    assert.doesNotMatch(surface, /outer-management-session/);
    assert.doesNotMatch(surface, /t2/);
  } finally {
    store.close();
  }
});

test("bounded Leader values honour the declared model byte budget exactly", async () => {
  const types = (await import("../../src/orchestration/leader-session-types.js")) as {
    boundLeaderValue: (value: unknown, maxBytes?: number) => unknown;
    LEADER_RESULT_MAX_BYTES: number;
    LEADER_MESSAGE_MAX_BYTES: number;
  };
  const budget = types.LEADER_RESULT_MAX_BYTES;
  assert.equal(budget, 16384);
  // Try several magnitudes: the envelope (marker + facts + note + JSON keys)
  // must be counted inside the budget, not added on top of it.
  for (const size of [20_000, 100_000, 400_000, 2_100_000]) {
    const bounded = types.boundLeaderValue({
      outcome: "successful",
      accepted: true,
      taskId: "task_1",
      audit: giantText(size),
    });
    const bytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
    assert.ok(bytes <= budget, `bounded value was ${bytes} bytes, budget ${budget}`);
    // Critical outcome facts must survive the bounding.
    const rendered = JSON.stringify(bounded);
    assert.match(rendered, /successful/);
    assert.match(rendered, /task_1/);
  }
  // Small values stay untouched.
  const small = { accepted: true };
  assert.deepEqual(types.boundLeaderValue(small), small);
});

test("durable tool messages never exceed the per-message model budget", async () => {
  const { createLeaderRuntime } = await leader();
  const store = new Store(":memory:");
  try {
    const runtime = createLeaderRuntime?.({ store });
    assert.ok(runtime);
    const giantOk = {
      outcome: "successful",
      accepted: true,
      taskId: "task_1",
      audit: giantText(400_000),
    };
    await runtime.runTaskLeader(
      activation(store, {
        tools: [tool("task_action", false, async () => giantOk)],
        engine: engine(async (input) => {
          await input.tools[0]?.execute({ action: "complete" }, input.actor);
          return { text: "已登记" };
        }),
      }),
    );
    // The canonical operation journal keeps the full value...
    const operation = runtime.operations("t1")[0] as
      | { state?: string; resultBytes?: number }
      | undefined;
    assert.equal(operation?.state, "complete");
    assert.ok((operation?.resultBytes ?? 0) > 400_000, "canonical value stays complete");
    // ...while every durable model-facing message stays inside its budget.
    for (const message of runtime.messages("t1")) {
      const bytes = Buffer.byteLength(String(message.text ?? ""), "utf8");
      assert.ok(bytes <= 16_384, `${String(message.role)} message was ${bytes} bytes`);
    }
  } finally {
    store.close();
  }
});

test("Leader read and write results stay canonical until the real engine projects them", async () => {
  const { runTaskLeader } = await leader();
  const store = new Store(":memory:");
  try {
    const giant = { outcome: "successful", taskId: "task_1", entries: giantText(400_000) };
    const canonicalValues: unknown[] = [];
    const modelResults: unknown[] = [];
    const pi = new PiEngine(config, {
      streamFn: scripted(
        [
          response("", [
            { type: "toolCall", id: "read-call", name: "task_get", arguments: { action: "read" } },
            {
              type: "toolCall",
              id: "write-call",
              name: "participant_send",
              arguments: { action: "write" },
            },
          ]),
          response("已核对。"),
        ],
        (context) => {
          for (const message of context.messages)
            if (message.role === "toolResult") modelResults.push(message);
        },
      ),
    });
    await runTaskLeader(
      activation(store, {
        engine: engine(async (input) => {
          const project = input.projectToolResult;
          assert.ok(project, "Leader provides the engine's post-evidence projection seam");
          return pi.run({
            ...input,
            projectToolResult: (value) => {
              canonicalValues.push(value.result);
              return project(value);
            },
          });
        }),
        tools: [
          tool("task_get", true, async () => giant),
          tool("participant_send", false, async () => giant),
        ],
      }),
    );
    assert.equal(canonicalValues.length, 2);
    assert.ok(
      canonicalValues.every((value) => value === giant),
      "engine evidence sees canonical values",
    );
    assert.equal(modelResults.length, 2);
    for (const value of modelResults) {
      assert.ok(serializedBytes(value) <= 16_384, "whole provider tool message is bounded");
      assert.match(
        JSON.stringify(value),
        /rt1_/,
        "the model can request the canonical body on demand",
      );
    }
  } finally {
    store.close();
  }
});

interface WorkflowHarnessState {
  toolSets: string[][];
  callerSessions: string[];
  promptKeys: string[];
}

/**
 * Shared end-to-end harness: a real TaskOrchestrator over a real TaskService,
 * with a scripted model that drives the Leader's own tool surface.
 */
async function workflowHarness(options: {
  ticks?: number;
  pickCandidate?: boolean;
  onCall?: (input: EngineInput, state: WorkflowHarnessState) => void;
}) {
  const { TaskOrchestrator } = await import("../../src/app/task-orchestrator.js");
  const { Engine: AppEngine, logger } = await import("../app/helpers.js");
  const { actor: taskActor, discussion, setup } = await import("../tasks/helpers.js");
  const h = setup();
  h.config.ai.enabled = true;
  const state: WorkflowHarnessState = { toolSets: [], callerSessions: [], promptKeys: [] };
  const task = await h.service.create(taskActor, {
    ...discussion,
    orchestration: { mode: "workflow" },
  });
  await h.service.reconcile(task.id);
  const engine = new AppEngine();
  engine.handler = async (input: EngineInput) => {
    options.onCall?.(input, state);
    const choice = input.tools.find((entry) => entry.name === "orchestration_choice");
    if (choice) {
      await choice.execute({ candidateId: "use_template" }, input.actor);
      return { text: "", messages: [] };
    }
    const plan = input.tools.find((entry) => entry.name === "orchestration_plan");
    if (plan) {
      await plan.execute(
        { template: "discussion", instructions: {}, deliveryRequirements: [] },
        input.actor,
      );
      return { text: "", messages: [] };
    }
    if (!options.pickCandidate) return { text: "", messages: [] };
    const status = input.tools.find((entry) => entry.name === "workflow_status");
    if (!status) return { text: "", messages: [] };
    const view = (await status.execute({}, input.actor)) as {
      legalActions?: Array<{ id: string; kind: string }>;
    };
    const candidate = view.legalActions?.[0];
    if (!candidate) return { text: "", messages: [] };
    const target = input.tools.find((entry) => {
      if (entry.readOnly === false || entry.name === "workflow_wait") return false;
      const properties = (entry.parameters as { properties?: Record<string, { enum?: string[] }> })
        .properties;
      return !!properties?.candidateId?.enum?.includes(candidate.id);
    });
    if (target)
      await target.execute({ candidateId: candidate.id, reason: "leader_pick" }, input.actor);
    return { text: "已提交调度动作。", messages: [] };
  };
  const orchestrator = () =>
    new TaskOrchestrator({
      store: h.store,
      config: h.config,
      projects: h.catalog,
      engine,
      tasks: () => h.service,
      tools: () => [],
      logger,
      signal: new AbortController().signal,
      retryDelayMs: 0,
      onReply: async () => {},
    });
  const tick = async () => {
    await orchestrator().tick();
  };
  for (let index = 0; index < (options.ticks ?? 2); index++) await tick();
  return { ...h, task, state, tick, close: h.close };
}

test("workflow scheduling reaches the Leader with scoped tools and no lifecycle authority", async () => {
  const { LEADER_MESSAGES, LEADER_SESSIONS } = await import(
    "../../src/orchestration/leader-session-types.js"
  );
  const h = await workflowHarness({
    onCall: (input, state) => {
      state.toolSets.push(input.tools.map((entry) => entry.name));
      state.callerSessions.push(input.sessionId);
      try {
        state.promptKeys.push(Object.keys(JSON.parse(input.prompt) as object).join(","));
      } catch {
        state.promptKeys.push("non-json");
      }
    },
  });
  try {
    const { toolSets, callerSessions, promptKeys } = h.state;
    const offered = [...new Set(toolSets.flat())];
    // Lifecycle and outer-management tools must never be reachable.
    for (const forbidden of [
      "task_action",
      "task_create",
      "task_complete",
      "task_close",
      "task_destroy",
      "participant_send",
      "session_clear",
    ])
      assert.ok(!offered.includes(forbidden), `Leader was granted ${forbidden}`);
    // The Leader must have real inspect/act tools, not a renamed enum.
    assert.ok(
      offered.some((name) => name.startsWith("workflow_")),
      "no scheduling action tools",
    );
    // Its own session identity, never the outer management session.
    for (const sessionId of callerSessions) assert.match(sessionId, /^task-leader:/);
    assert.equal(h.store.list(LEADER_SESSIONS).length, 1, "one Leader session for the task");
    assert.ok(h.store.list(LEADER_MESSAGES).length > 0, "the Leader transcript is durable");
    // The activation payload carries bounded task facts, not full decision history.
    for (const keys of promptKeys)
      assert.doesNotMatch(keys, /decisions|history|orchestrationHistory/);
  } finally {
    h.close();
  }
});

test("a replayed workflow tick never duplicates a confirmed participant dispatch", async () => {
  const { LEADER_INBOX, LEADER_SESSIONS } = await import(
    "../../src/orchestration/leader-session-types.js"
  );
  const h = await workflowHarness({ ticks: 8, pickCandidate: true });
  try {
    const confirmed = h.herdr.sends.length;
    // Every tick above built a NEW orchestrator, so this is exactly the cold-resume
    // shape: the durable Leader inbox must absorb the repeat, not re-send.
    for (let index = 0; index < 4; index++) await h.tick();
    assert.equal(
      h.herdr.sends.length,
      confirmed,
      `replayed ticks sent ${h.herdr.sends.length - confirmed} duplicate participant inputs`,
    );
    assert.equal(h.store.list(LEADER_SESSIONS).length, 1, "still one Leader session");
    const inbox = h.store.list<{ state: string }>(LEADER_INBOX);
    assert.ok(
      inbox.every((record) => !["pending", "active"].includes(record.state)),
      `unsettled Leader inbox rows: ${inbox.map((record) => record.state).join(",")}`,
    );
  } finally {
    h.close();
  }
});
