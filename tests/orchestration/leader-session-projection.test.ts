import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ActorContext } from "../../src/core/types.js";
import {
  adoptResultProjection,
  type ResultProjectionLike,
  runTaskLeader,
} from "../../src/orchestration/leader-session.js";
import type { LeaderProjectionInput } from "../../src/orchestration/leader-session-types.js";
import { RESULT_TOOL_NAME } from "../../src/runtime/tool-results.js";
import type { EngineInput, EngineResult, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";

/**
 * D + B boundary: the Leader must consume B's durable projection factory when
 * it is available, while keeping the canonical receipt authoritative.
 *
 * B's module is authored in parallel, so the factory is loaded dynamically. If
 * it is missing, this suite skips instead of failing the D scope.
 */
type Factory = (store: Store, actor: ActorContext, scope: string) => ResultProjectionLike;

async function loadFactory(): Promise<Factory | undefined> {
  try {
    const module = (await import("../../src/runtime/tool-results.js")) as {
      createResultProjection?: Factory;
    };
    return module.createResultProjection;
  } catch {
    return undefined;
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "leader-b-"));
  const store = new Store(join(directory, "state.sqlite"));
  return {
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

type ProjectedInput = EngineInput & {
  projectToolResult?: (input: LeaderProjectionInput) => unknown | Promise<unknown>;
};

function engine(run: (input: ProjectedInput) => Promise<Partial<EngineResult>>) {
  return {
    contextTokens: 50000,
    async run(input: EngineInput): Promise<EngineResult> {
      const partial = await run(input as ProjectedInput);
      return { text: partial.text ?? "", messages: partial.messages ?? [], ...partial };
    },
    async summarize() {
      return "summary";
    },
  };
}

function oversizedTool(payload: string): RuntimeTool {
  return {
    name: "task_audit",
    description: "read-only audit",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute: async () => ({ outcome: "ok", payload }),
  };
}

test("D+B: an oversized result is stored durably and bounded on the Leader surface", async (t) => {
  const create = await loadFactory();
  if (!create) {
    t.skip("B's src/runtime/tool-results.ts is not present yet");
    return;
  }
  const h = fixture();
  try {
    const actor: ActorContext = {
      source: "system",
      ownerId: "owner",
      chatId: "chat",
      sessionId: "task-leader:t1",
      taskId: "t1",
      messageId: "evt",
    };
    const projection = adoptResultProjection(create(h.store, actor, "leader:t1"), "leader:t1");
    assert.equal(projection.source, "durable-store");
    const payload = "q".repeat(200_000);
    await runTaskLeader({
      store: h.store,
      engine: engine(async (input) => {
        const value = await input.tools[0]?.execute({}, input.actor);
        // The engine receives the canonical value for evidence evaluation and
        // the durable projection seam turns it into a bounded, paged reference
        // for the request the model actually sees.
        assert.equal((value as { payload: string }).payload.length, 200_000);
        const projected = await input.projectToolResult?.({
          tool: "task_audit",
          args: {},
          toolCallId: "audit",
          result: value,
          isError: false,
        });
        const rendered = JSON.stringify(projected);
        assert.ok(Buffer.byteLength(rendered, "utf8") <= 16_384);
        assert.match(rendered, /rt1_/);
        return { text: "已读取审计", toolCalls: 1 };
      }),
      actor,
      eventId: "evt-b",
      revision: "rev",
      systemPrompt: "LEADER",
      prompt: "读取审计",
      tools: [oversizedTool(payload)],
      projection,
    });
    // The durable model surface holds only the bounded reference + the answer.
    const messages = h.store
      .list<{ id: string; taskId: string; role: string; text: string; bytes: number }>(
        "leader_messages",
      )
      .filter((message) => message.taskId === "t1");
    assert.ok(messages.length > 0);
    for (const message of messages)
      assert.ok(message.bytes <= 16_384 + 512, `${message.id} exceeded the model bound`);
    // B's read-only pagination tool is exposed to the Leader alongside its own.
    const paged = messages.find((message) => message.text.includes(RESULT_TOOL_NAME));
    assert.ok(paged, "the durable result reference must be recorded on the surface");
  } finally {
    h.close();
  }
});

test("D+B: B's pagination tool is exposed to the Leader when the factory supplies one", async (t) => {
  const create = await loadFactory();
  if (!create) {
    t.skip("B's src/runtime/tool-results.ts is not present yet");
    return;
  }
  const h = fixture();
  try {
    const actor: ActorContext = {
      source: "system",
      ownerId: "owner",
      chatId: "chat",
      sessionId: "task-leader:t1",
      taskId: "t1",
      messageId: "evt",
    };
    const projection = adoptResultProjection(create(h.store, actor, "leader:t1"), "leader:t1");
    const names: string[] = [];
    await runTaskLeader({
      store: h.store,
      engine: engine(async (input) => {
        names.push(...input.tools.map((tool) => tool.name));
        // The engine hook receives canonical values when it is offered.
        assert.equal(typeof input.projectToolResult, "function");
        return { text: "已检查工具" };
      }),
      actor,
      eventId: "evt-b2",
      revision: "rev",
      systemPrompt: "LEADER",
      prompt: "检查工具",
      tools: [],
      projection,
    });
    assert.ok(
      names.includes(RESULT_TOOL_NAME),
      `expected ${RESULT_TOOL_NAME} in ${names.join(",")}`,
    );
  } finally {
    h.close();
  }
});
