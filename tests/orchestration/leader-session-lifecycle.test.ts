import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OperationError } from "../../src/core/errors.js";
import type { ActorContext } from "../../src/core/types.js";
import { createLeaderRuntime } from "../../src/orchestration/leader-session.js";
import {
  LEADER_SESSIONS,
  type LeaderSessionRecord,
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

function _writeTool(name: string, execute: RuntimeTool["execute"]): RuntimeTool {
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

test("D: one activation persists the session surface, journal and stable receipt", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    const journaled: string[] = [];
    const result = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async (input) => {
        assert.equal(input.sessionId, "task-leader:t1");
        // The caller's tool plus the runtime's own scoped result reader.
        assert.ok(input.tools.some((tool) => tool.name === "state_read"));
        assert.ok(input.tools.some((tool) => tool.name === "tool_result_read"));
        assert.equal(input.enforceClaims, false);
        journaled.push(JSON.stringify(input.actor));
        await input.tools[0]?.execute({ action: "read" }, input.actor);
        return { text: "已读取状态。", toolCalls: 1 };
      }),
      actor: actor("t1"),
      eventId: "evt-1",
      revision: "rev-1",
      systemPrompt: "LEADER",
      prompt: "推进任务",
      tools: [
        readTool("state_read", async () => {
          journaled.push("tool");
          return { outcome: "ok" };
        }),
      ],
    });
    assert.equal(result.text, "已读取状态。");
    const session = h.store.get<LeaderSessionRecord>(LEADER_SESSIONS, "task-leader:t1");
    assert.equal(session?.taskId, "t1");
    assert.equal(session?.status, "idle");
    assert.equal(session?.generation, 0);
    const summary = runtime.summary("t1");
    assert.equal(summary.messages > 0, true);
    assert.equal(summary.inbox.recorded, 1);
    assert.equal(summary.activations.recorded, 1);
    assert.equal(summary.businessCompletion, "unknown");
    // Journal records activation start and the recorded activation.
    const kinds = runtime.journal("t1").map((entry) => entry.kind);
    assert.ok(kinds.includes("activation_started"));
    assert.ok(kinds.includes("activation_recorded"));
    // The read-only receipt is durable and bounded, so a later activation sees
    // what this one already observed.
    const toolMessage = runtime.messages("t1").find((message) => message.role === "tool");
    assert.ok(toolMessage, "read-only receipts belong on the durable surface");
    assert.match(toolMessage.text, /state_read/);
    assert.equal(toolMessage.truncated, false);
    // The caller-supplied actor is never handed to a tool.
    assert.ok(!journaled.some((value) => value.includes("orchestration:t1")));
  } finally {
    h.close();
  }
});

test("D: duplicate delivery of the same event+revision returns the receipt without rerun", async () => {
  const h = fixture();
  try {
    let runs = 0;
    const runtime = createLeaderRuntime({ store: h.store });
    const invoke = () =>
      runtime.runTaskLeader({
        store: h.store,
        engine: engine(async () => {
          runs += 1;
          return { text: "第一次结果" };
        }),
        actor: actor("t1"),
        eventId: "evt-dup",
        revision: "rev-1",
        systemPrompt: "",
        prompt: "推进",
        tools: [],
      });
    const first = await invoke();
    const second = await invoke();
    assert.equal(runs, 1, "duplicate event must not call the engine again");
    assert.equal(second.text, first.text);
    assert.equal(runtime.summary("t1").inbox.recorded, 1);
  } finally {
    h.close();
  }
});

test("D: the same event survives a restart and still dedupes", async () => {
  const h = fixture();
  try {
    let runs = 0;
    const first = createLeaderRuntime({ store: h.store });
    await first.runTaskLeader({
      store: h.store,
      engine: engine(async () => {
        runs += 1;
        return { text: "冷启动结果" };
      }),
      actor: actor("t1"),
      eventId: "evt-restart",
      revision: "rev-1",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    // A fresh runtime object simulates a new process over the same store.
    const restarted = createLeaderRuntime({ store: h.store });
    const replayed = await restarted.runTaskLeader({
      store: h.store,
      engine: engine(async () => {
        runs += 1;
        return { text: "不应出现" };
      }),
      actor: actor("t1"),
      eventId: "evt-restart",
      revision: "rev-1",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    assert.equal(runs, 1);
    assert.equal(replayed.text, "冷启动结果");
    const receipt = restarted.inboxReceipt("t1", "evt-restart", "rev-1");
    assert.equal(receipt?.state, "recorded");
    assert.equal(receipt?.attempts, 1);
  } finally {
    h.close();
  }
});

test("D: an unexecuted older revision is durably superseded, not executed", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    // rev-1 is enqueued but never activated; rev-2 arrives first and wins.
    const current = await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "rev-2 结果" })),
      actor: actor("t1"),
      eventId: "evt-rev",
      revision: "rev-2",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    assert.equal(current.text, "rev-2 结果");
    assert.equal(runtime.inboxReceipt("t1", "evt-rev", "rev-2")?.state, "recorded");
  } finally {
    h.close();
  }
});

test("D: an enqueued older revision is superseded when a newer revision arrives first", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    const seen: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    // rev-1 starts executing and commits its inbox while rev-2 is enqueued.
    const inFlight = runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => {
        seen.push("rev-1");
        await gate;
        return { text: "rev-1 结果" };
      }),
      actor: actor("t1"),
      eventId: "evt-order",
      revision: "rev-1",
      systemPrompt: "",
      prompt: "rev-1",
      tools: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseFirst?.();
    const first = await inFlight;
    assert.equal(first.text, "rev-1 结果");
    assert.ok(seen.includes("rev-1"));
    // A newer revision for the same event after a recorded activation is stale
    // by the event-identity rule and must not execute.
    await expectRejection(
      () =>
        runtime.runTaskLeader({
          store: h.store,
          engine: engine(async () => {
            seen.push("rev-2");
            return { text: "rev-2 结果" };
          }),
          actor: actor("t1"),
          eventId: "evt-order",
          revision: "rev-2",
          systemPrompt: "",
          prompt: "rev-2",
          tools: [],
        }),
      "revision_stale",
    );
    assert.deepEqual(seen, ["rev-1"]);
  } finally {
    h.close();
  }
});

test("D: a stale revision delivered after a recorded activation is refused", async () => {
  const h = fixture();
  try {
    const runtime = createLeaderRuntime({ store: h.store });
    await runtime.runTaskLeader({
      store: h.store,
      engine: engine(async () => ({ text: "rev-2 结果" })),
      actor: actor("t1"),
      eventId: "evt-rev",
      revision: "rev-2",
      systemPrompt: "",
      prompt: "推进",
      tools: [],
    });
    let staleRuns = 0;
    // rev-1 was never registered for this event, and rev-2 is already recorded:
    // the runtime cannot order them, so it refuses instead of guessing.
    await expectRejection(
      () =>
        runtime.runTaskLeader({
          store: h.store,
          engine: engine(async () => {
            staleRuns += 1;
            return { text: "不应执行" };
          }),
          actor: actor("t1"),
          eventId: "evt-rev",
          revision: "rev-1",
          systemPrompt: "",
          prompt: "推进",
          tools: [],
        }),
      "revision_stale",
    );
    assert.equal(staleRuns, 0, "a stale revision must never execute");
    assert.equal(runtime.inboxReceipt("t1", "evt-rev", "rev-2")?.state, "recorded");
  } finally {
    h.close();
  }
});
