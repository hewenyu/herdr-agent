import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import {
  leaderRuntime,
  runTaskLeader,
  type TaskLeaderInput,
} from "../../src/orchestration/leader-session.js";
import { PiEngine } from "../../src/runtime/engine.js";
import type { ConversationEngine, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "../runtime/helpers.js";

function fixture(run: ConversationEngine["run"], execute: RuntimeTool["execute"]) {
  const store = new Store(":memory:");
  const input: TaskLeaderInput = {
    store,
    engine: { contextTokens: 50000, summarize: async () => "", run },
    actor: {
      source: "system",
      ownerId: "owner",
      chatId: "chat",
      sessionId: "outer",
      taskId: "task",
      messageId: "event-1",
    },
    eventId: "event-1",
    revision: "revision-1",
    systemPrompt: "Only perform authorized task-scoped scheduling.",
    prompt: "Read current state and arrange the next step.",
    tools: [
      {
        name: "write",
        description: "Record an authorized dispatch",
        readOnly: false,
        parameters: { type: "object", properties: { text: { type: "string" } } },
        execute,
      },
    ],
  };
  return { store, input };
}

for (const readOnly of [true, false]) {
  test(`Leader preserves oversized canonical ${readOnly ? "read" : "write"} values until PiEngine evidence evaluation`, async () => {
    const canonical = { outcome: "successful", verified: true, body: "canonical".repeat(20_000) };
    const seen: unknown[] = [];
    const pi = new PiEngine(config, {
      streamFn: scripted([
        response("", [{ type: "toolCall", id: "call", name: "write", arguments: {} }]),
        response("The supplied evidence was recorded."),
      ]),
    });
    const { store, input } = fixture(
      (request) => {
        const project = request.projectToolResult;
        assert.ok(project, "the actual PiEngine receives a durable projection seam");
        return pi.run({
          ...request,
          projectToolResult: (projection) => {
            if (projection.tool === "write") seen.push(projection.result);
            return project(projection);
          },
        });
      },
      async () => canonical,
    );
    const tool = input.tools[0];
    assert.ok(tool);
    tool.readOnly = readOnly;
    try {
      const result = await runTaskLeader(input);
      assert.ok(seen.length > 0, "the real engine invokes its post-evidence projection");
      assert.ok(
        seen.every((value) => value === canonical),
        "a preprojected reference must never replace the canonical receipt at the evidence boundary",
      );
      assert.equal(result.toolEvidence?.successful, 1);
      for (const message of result.messages)
        if (message.role === "toolResult")
          assert.ok(Buffer.byteLength(JSON.stringify(message), "utf8") <= 16_384);
    } finally {
      store.close();
    }
  });
}

// A receipt belongs to an event/revision, not to all equal requests for the
// lifetime of the task. A new settled output may require the same instruction.
test("Leader deduplicates one event but does not swallow identical writes in a new event", async () => {
  let writes = 0;
  let calls = 0;
  const { store, input } = fixture(
    async (request) => {
      calls++;
      await request.tools
        .find((tool) => tool.name === "write")
        ?.execute({ text: "review again" }, request.actor);
      return { text: "recorded", messages: [], toolCalls: 1, writeCalls: 1 };
    },
    async () => {
      writes++;
      return { verified: true };
    },
  );
  try {
    await runTaskLeader(input);
    await runTaskLeader(input);
    assert.equal(calls, 1);
    assert.equal(writes, 1);
    await runTaskLeader({ ...input, eventId: "event-2", revision: "revision-2" });
    assert.equal(calls, 2);
    assert.equal(writes, 2, "new canonical event must execute its own authorized operation");
  } finally {
    store.close();
  }
});

test("Leader fences each tool call against a revision change during inference", async () => {
  let current = true;
  let writes = 0;
  const { store, input } = fixture(
    async (request) => {
      current = false;
      await request.tools
        .find((tool) => tool.name === "write")
        ?.execute({ text: "obsolete" }, request.actor);
      return { text: "recorded", messages: [] };
    },
    async () => {
      writes++;
      return { verified: true };
    },
  );
  input.assertCurrent = () => {
    if (!current) throw new OperationError("orchestration_superseded", "new user revision");
  };
  try {
    await assert.rejects(runTaskLeader(input), { code: "orchestration_superseded" });
    assert.equal(writes, 0, "post-run validation cannot undo an obsolete write");
  } finally {
    store.close();
  }
});

test("Leader cannot replace an unknown write with changed arguments on the next activation", async () => {
  let calls = 0;
  let writes = 0;
  const { store, input } = fixture(
    async (request) => {
      calls++;
      try {
        await request.tools
          .find((tool) => tool.name === "write")
          ?.execute({ text: `attempt-${calls}` }, request.actor);
      } catch {
        /* The provider can receive an error receipt and then disconnect. */
      }
      throw new OperationError("model_failed", "provider disconnected", "unknown");
    },
    async () => {
      writes++;
      throw new OperationError("transport", "delivery outcome unknown", "unknown");
    },
  );
  try {
    await assert.rejects(runTaskLeader(input), { code: "model_failed" });
    await assert.rejects(runTaskLeader({ ...input, eventId: "event-2" }));
    assert.equal(writes, 1, "a new event or arguments must not bypass unresolved effects");
    assert.equal(calls, 1, "unknown effects must be resolved before rescheduling");
  } finally {
    store.close();
  }
});

test("revision changes after an effect cannot erase its completed canonical receipt", async () => {
  let current = true;
  let writes = 0;
  const { store, input } = fixture(
    async (request) => {
      await request.tools
        .find((tool) => tool.name === "write")
        ?.execute({ text: "authorized when sent" }, request.actor);
      return { text: "recorded", messages: [] };
    },
    async () => {
      writes++;
      current = false;
      return { verified: true, nativeReceipt: "delivered" };
    },
  );
  input.assertCurrent = () => {
    if (!current)
      throw new OperationError("orchestration_superseded", "revision changed during delivery");
  };
  try {
    await assert.rejects(runTaskLeader(input), { code: "orchestration_superseded" });
    assert.equal(writes, 1);
    const receipt = leaderRuntime(store).operations("task")[0];
    assert.equal(
      receipt?.state,
      "complete",
      "supersession must not rewrite an already completed business effect",
    );
    assert.deepEqual(receipt?.result, { verified: true, nativeReceipt: "delivered" });
  } finally {
    store.close();
  }
});

test("abandoning an unknown write does not grant permission to replay that operation", async () => {
  let writes = 0;
  const { store, input } = fixture(
    async (request) => {
      await request.tools
        .find((tool) => tool.name === "write")
        ?.execute({ text: "same operation" }, request.actor);
      return { text: "recorded", messages: [] };
    },
    async () => {
      writes++;
      throw new OperationError("transport", "unknown effect", "unknown");
    },
  );
  try {
    await assert.rejects(runTaskLeader(input), { code: "transport" });
    const runtime = leaderRuntime(store);
    const operation = runtime.operations("task")[0];
    assert.ok(operation);
    runtime.resolveWrite({
      taskId: "task",
      operationId: operation.id,
      choice: "abandon",
      decidedBy: "user",
      reason: "Do not retry this operation",
    });
    await assert.rejects(runTaskLeader(input));
    assert.equal(writes, 1, "abandon means do not retry, not proven-safe-to-reexecute");
  } finally {
    store.close();
  }
});

test("Leader keeps mandatory prompt constraints or refuses before inference, never truncates them", async () => {
  let calls = 0;
  const marker = "MANDATORY: never close this task without explicit user acceptance.";
  const { store, input } = fixture(
    async (request) => {
      calls++;
      assert.ok(
        request.prompt.includes(marker) || JSON.stringify(request.messages).includes(marker),
        "the scheduling model must receive mandatory constraints, not a severed JSON prefix",
      );
      return { text: "read", messages: [] };
    },
    async () => ({ verified: true }),
  );
  input.prompt = JSON.stringify({ requirements: "x".repeat(24000), prohibition: marker });
  try {
    try {
      await runTaskLeader(input);
      assert.equal(calls, 1);
    } catch (error) {
      if (
        !(error instanceof OperationError) ||
        !["context_budget", "orchestration_context_budget"].includes(error.code)
      )
        throw error;
      assert.equal(calls, 0, "over-budget mandatory input must fail before inference");
    }
  } finally {
    store.close();
  }
});
