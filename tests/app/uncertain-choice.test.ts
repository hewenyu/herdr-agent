import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseUncertain, uncertainCandidates } from "../../src/app/uncertain-choice.js";
import type { ActorContext } from "../../src/core/types.js";
import type { ConversationEngine, EngineInput } from "../../src/runtime/types.js";

const actor: ActorContext = {
  source: "system",
  ownerId: "owner",
  chatId: "chat",
  taskId: "task",
  sessionId: "session",
  messageId: "tick",
};
function engine(handler: (input: EngineInput) => Promise<void>): ConversationEngine {
  return {
    contextTokens: 10000,
    summarize: async () => "",
    run: async (input) => {
      await handler(input);
      return { text: "", messages: [] };
    },
  };
}
const input = {
  actor,
  id: "operation",
  state: { evidence: "unknown" },
  candidates: uncertainCandidates,
  signal: new AbortController().signal,
};

test("uncertain choices align with operation resolutions plus escalate", () => {
  assert.deepEqual(
    uncertainCandidates.map((candidate) => candidate.id),
    ["treat_as_done", "retry_once", "abandon_step", "escalate_to_user"],
  );
});

test("uncertain selector delegates to the single read-only pi choice tool", async () => {
  const result = await chooseUncertain({
    ...input,
    engine: engine(async (call) => {
      const tool = call.tools[0];
      assert.ok(tool);
      assert.equal(call.sessionId, "uncertain-selection:operation");
      assert.equal(call.messages.length, 0);
      assert.equal(call.tools.length, 1);
      assert.equal(tool.name, "orchestration_choice");
      assert.equal(tool.readOnly, true);
      await tool.execute({ candidateId: "retry_once" }, actor);
      await assert.rejects(tool.execute({ candidateId: "treat_as_done" }, actor));
    }),
  });
  // A second call marks the run invalid; the selector escalates instead of retrying.
  assert.deepEqual(result, { choice: "escalate_to_user", reason: "no_selection", source: "none" });
});

test("uncertain selector returns a single legal pi choice", async () => {
  const result = await chooseUncertain({
    ...input,
    engine: engine(async (call) => {
      await call.tools[0]?.execute({ candidateId: "treat_as_done" }, actor);
    }),
  });
  assert.equal(result.choice, "treat_as_done");
  assert.equal(result.source, "pi");
});

test("uncertain selector rejects exhausted retry and malformed choices", async () => {
  const result = await chooseUncertain({
    ...input,
    candidates: uncertainCandidates.filter((candidate) => candidate.id !== "retry_once"),
    engine: engine(async (call) => {
      const tool = call.tools[0];
      assert.ok(tool);
      const schema = tool.parameters as {
        properties: { candidateId: { enum: string[] } };
      };
      assert.ok(!schema.properties.candidateId.enum.includes("retry_once"));
      for (const args of [
        { candidateId: "retry_once" },
        { candidateId: "execute_shell" },
        { candidateId: "treat_as_done", injected: true },
      ])
        await assert.rejects(tool.execute(args, actor));
    }),
  });
  assert.deepEqual(result, { choice: "escalate_to_user", reason: "no_selection", source: "none" });
});

test("uncertain selector failures and cancellation route to human without effects", async () => {
  const failed = await chooseUncertain({
    ...input,
    engine: engine(async () => {
      throw new Error("offline");
    }),
  });
  assert.equal(failed.choice, "escalate_to_user");
  assert.equal(failed.source, "none");
  const controller = new AbortController();
  const cancelled = await chooseUncertain({
    ...input,
    signal: controller.signal,
    engine: engine(async (call) => {
      await call.tools[0]?.execute({ candidateId: "retry_once" }, actor);
      controller.abort();
    }),
  });
  assert.deepEqual(cancelled, { choice: "escalate_to_user", reason: "cancelled", source: "none" });
});
