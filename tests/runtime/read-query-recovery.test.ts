import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { PiEngine, SessionService } from "../../src/runtime/index.js";
import type { EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "./helpers.js";

const taskId = "task_e39";
const task = {
  id: taskId,
  status: "starting",
  remoteTaskId: "remote-e39",
  chatId: "group-e39",
  groupDeleted: false,
  participants: [
    { id: "claude-1", name: "claude-1", kind: "claude", started: true, initialSent: false },
  ],
};
const actor = { ownerId: "owner", chatId: "entry", sessionId: "session", messageId: "message" };
const answer = "飞书任务已创建，任务群已建立。claude-1 的执行器已启动，初始要求投递尚待确认。";
const call = (name: string, id: string, args: Record<string, unknown> = {}) =>
  response("", [{ type: "toolCall", name, id, arguments: args }]);

function available(get: RuntimeTool["execute"], action?: RuntimeTool["execute"]): RuntimeTool[] {
  return [
    {
      name: "task_create",
      readOnly: false,
      execute: async () => ({ accepted: true, task: { id: taskId, status: "queued" } }),
    },
    { name: "task_get", readOnly: true, execute: get },
    {
      name: "task_action",
      readOnly: false,
      execute: action ?? (async () => ({ ...task, status: "completed" })),
    },
  ].map((tool) => ({
    ...tool,
    description: tool.name,
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        participantId: { type: "string" },
        action: { type: "string" },
      },
    },
  }));
}

function input(tools: RuntimeTool[]): EngineInput {
  return {
    actor,
    sessionId: actor.sessionId,
    systemPrompt: "Report only verified tool facts.",
    prompt: "创建飞书任务和群",
    messages: [],
    tools,
  };
}

function rejected(error: unknown): boolean {
  return error instanceof OperationError && error.code === "model_failed";
}

for (const mode of ["throw", "returned"] as const) {
  test(`E39 missing task_get input is corrected before an accurate creation reply: ${mode}`, async () => {
    const engine = new PiEngine(config, {
      streamFn: scripted([
        call("task_create", "create"),
        call("task_get", "missing"),
        call("task_get", "correct", { taskId }),
        response(answer),
      ]),
    });
    const result = await engine.run(
      input(
        available(async (args) => {
          if (!args.taskId) {
            if (mode === "throw") throw new OperationError("input", "缺少有效字段：taskId");
            return { code: "input", outcome: "not_executed", message: "缺少有效字段：taskId" };
          }
          return task;
        }),
      ),
    );
    assert.equal(result.text, answer);
    assert.equal(result.toolCalls, 3, "no extra recovery query after corrected read");
    assert.equal(result.toolEvidence?.notExecuted, 1, "retain the original rejection in evidence");
    assert.equal(result.toolEvidence?.unresolvedNotExecuted, 0);
    assert.equal(result.toolEvidence?.successfulWrites, 1);
    assert.equal(result.toolEvidence?.provisioning?.tasks[0]?.participants[0]?.sent, false);
  });
}

test("E39 corrected read allows SessionService to persist and deliver the creation reply", async () => {
  const store = new Store(":memory:");
  const engine = new PiEngine(config, {
    streamFn: scripted([
      call("task_create", "create"),
      call("task_get", "missing"),
      call("task_get", "correct", { taskId }),
      response(answer),
    ]),
  });
  const sessions = new SessionService(store, engine, {
    tools: () =>
      available(async (args) => {
        if (!args.taskId) throw new OperationError("input", "缺少有效字段：taskId");
        return task;
      }),
  });
  try {
    const session = sessions.current(actor.ownerId, actor.chatId);
    const reply = await sessions.reply({ ...actor, sessionId: session.id }, "创建飞书任务和群");
    assert.equal(reply.text, answer);
    assert.equal(sessions.history(actor.ownerId, session.id).at(-1)?.id, reply.id);
    assert.equal(sessions.beginDelivery(actor.ownerId, reply.id), true);
    sessions.recordDelivery(actor.ownerId, reply.id, { complete: true, ids: ["feishu-reply"] });
    assert.equal(sessions.history(actor.ownerId, session.id).at(-1)?.delivery, "delivered");
  } finally {
    store.close();
  }
});

for (const scenario of [
  { name: "explicit task", failed: { taskId: "task_other" }, corrected: { taskId } },
  {
    name: "participant selector",
    failed: { participantId: "other" },
    corrected: { taskId, participantId: "claude-1" },
  },
]) {
  test(`another target cannot erase a read input rejection: ${scenario.name}`, async () => {
    let reads = 0;
    const engine = new PiEngine(config, {
      streamFn: scripted([
        call("task_create", "create"),
        call("task_get", "failed", scenario.failed),
        call("task_get", "different", scenario.corrected),
        response(answer),
        call("task_get", "verify", scenario.corrected),
        response(answer),
      ]),
    });
    await assert.rejects(
      engine.run(
        input(
          available(async () => {
            if (++reads === 1) throw new OperationError("input", "字段无效");
            return task;
          }),
        ),
      ),
      rejected,
    );
    assert.equal(reads, 3);
  });
}

test("an actor-bound task prevents a targetless query failure being erased by another task", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      call("task_create", "create"),
      call("task_get", "missing"),
      call("task_get", "different", { taskId }),
      response(answer),
      call("task_get", "verify", { taskId }),
      response(answer),
    ]),
  });
  await assert.rejects(
    engine.run({
      ...input(
        available(async (args) => {
          if (!args.taskId) throw new OperationError("input", "缺少有效字段：taskId");
          return task;
        }),
      ),
      actor: { ...actor, taskId: "task_bound" },
    }),
    rejected,
  );
});

test("a successful read cannot erase a missing-input write rejection", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      call("task_create", "create"),
      call("task_action", "missing", { action: "complete" }),
      call("task_get", "read", { taskId }),
      response(answer),
      call("task_get", "verify", { taskId }),
      response(answer),
    ]),
  });
  await assert.rejects(
    engine.run(
      input(
        available(
          async () => task,
          async () => {
            throw new OperationError("input", "缺少有效字段：taskId");
          },
        ),
      ),
    ),
    rejected,
  );
});

test("another successful write cannot erase a missing-input write rejection", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      call("task_action", "missing", { action: "complete" }),
      call("task_action", "other", { taskId, action: "complete" }),
      response("任务已完成。"),
      call("task_get", "verify", { taskId }),
      response("任务已完成。"),
    ]),
  });
  await assert.rejects(
    engine.run(
      input(
        available(
          async () => task,
          async (args) => {
            if (!args.taskId) throw new OperationError("input", "缺少有效字段：taskId");
            return { ...task, status: "completed" };
          },
        ),
      ),
    ),
    rejected,
  );
});

test("correcting a read preserves an earlier unknown write outcome", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      call("task_action", "unknown", { taskId, action: "complete" }),
      call("task_get", "missing"),
      call("task_get", "correct", { taskId }),
      response("任务已完成。"),
      call("task_get", "verify", { taskId }),
      response("任务已完成。"),
    ]),
  });
  let writes = 0;
  await assert.rejects(
    engine.run(
      input(
        available(
          async (args) => {
            if (!args.taskId) throw new OperationError("input", "缺少有效字段：taskId");
            return task;
          },
          async () => {
            writes++;
            throw new OperationError("unknown", "结果未知", "unknown");
          },
        ),
      ),
    ),
    (error: unknown) => rejected(error) && (error as OperationError).outcome === "unknown",
  );
  assert.equal(writes, 1);
});

test("corrected read does not invent group provisioning evidence", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      call("task_create", "create"),
      call("task_get", "missing"),
      call("task_get", "correct", { taskId }),
      response("任务群已建立。"),
      call("task_get", "verify", { taskId }),
      response("任务群已建立。"),
    ]),
  });
  await assert.rejects(
    engine.run(
      input(
        available(async (args) => {
          if (!args.taskId) throw new OperationError("input", "缺少有效字段：taskId");
          return { id: taskId, status: "queued" };
        }),
      ),
    ),
    rejected,
  );
});
