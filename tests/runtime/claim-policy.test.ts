import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { evaluateClaimPolicy } from "../../src/runtime/claim-policy.js";
import { PiEngine, SessionService } from "../../src/runtime/index.js";
import {
  type ProvisionEvidence,
  recordProvisionEvidence,
} from "../../src/runtime/provision-evidence.js";
import type { ConversationEngine, RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "./helpers.js";

const actor = { ownerId: "owner", chatId: "entry", sessionId: "session", messageId: "message" };
const taskId = "task_existing";
const task = {
  id: taskId,
  remoteTaskId: "remote-existing",
  chatId: "group-existing",
  groupDeleted: false,
  participants: [{ id: "codex1", kind: "codex", name: "Codex", initialSent: false }],
};
const evidence = (result: unknown = task, name = "task_get") => {
  const provisioning: ProvisionEvidence = { created: [], tasks: [] };
  recordProvisionEvidence(provisioning, name, { taskId }, result);
  return { successful: 1, successfulWrites: 0, unknown: 0, notExecuted: 0, provisioning };
};
const tool = (result: unknown = task, name = "task_get"): RuntimeTool => ({
  name,
  description: "Read current task state",
  readOnly: true,
  parameters: { type: "object", properties: { taskId: { type: "string" } } },
  execute: async () => result,
});
const call = (name = "task_get") =>
  response("", [{ type: "toolCall", name, id: "read", arguments: { taskId } }]);
const modelFailure = (error: unknown) =>
  error instanceof OperationError && error.code === "model_failed";

for (const name of ["task_get", "task_progress", "tasks_list"]) {
  test(`${name} state facts do not require a current write in either boundary`, async () => {
    const text = "飞书任务已创建，任务群已就绪";
    const result = name === "tasks_list" ? [task] : task;
    assert.equal(evaluateClaimPolicy(text, evidence(result, name)).rejected, false);
    const engine = new PiEngine(config, { streamFn: scripted([call(name), response(text)]) });
    const store = new Store(":memory:");
    const sessions = new SessionService(store, engine, { tools: () => [tool(result, name)] });
    try {
      const session = sessions.current(actor.ownerId, actor.chatId);
      const reply = await sessions.reply({ ...actor, sessionId: session.id }, "查询任务现状");
      assert.equal(reply.text, text);
      assert.equal(sessions.history(actor.ownerId, session.id).at(-1)?.id, reply.id);
      assert.equal(store.list("pi_operations").length, 0);
    } finally {
      store.close();
    }
  });
}

const rejectedReads = [
  { name: "missing group", result: { ...task, chatId: undefined }, text: "任务群已就绪" },
  { name: "deleted group", result: { ...task, groupDeleted: true }, text: "任务群已就绪" },
  {
    name: "missing remote task",
    result: { ...task, remoteTaskId: undefined },
    text: "飞书任务已创建",
  },
  { name: "unverified delivery", result: task, text: "已把要求转交给 Codex" },
  { name: "first-person creation", result: task, text: "我已为你创建飞书任务" },
  { name: "beneficiary creation", result: task, text: "已为您创建飞书任务" },
  { name: "new creation", result: task, text: "已创建新的飞书任务" },
  { name: "this-turn creation", result: task, text: "本轮已创建飞书任务" },
  { name: "scheduling", result: task, text: "飞书任务已创建，已安排 Codex 执行任务" },
  { name: "unknown identifier", result: task, text: "已创建任务 task_fake123" },
  {
    name: "question after false group state",
    result: { ...task, chatId: undefined },
    text: "任务群已建立，还需要什么？",
  },
];

for (const scenario of rejectedReads) {
  test(`PiEngine rejects read-only ${scenario.name}`, async () => {
    const engine = new PiEngine(config, {
      streamFn: scripted([call(), response(scenario.text), response(scenario.text)]),
    });
    await assert.rejects(
      engine.run({
        actor,
        sessionId: actor.sessionId,
        systemPrompt: "Report only current tool facts",
        prompt: "查询任务现状",
        messages: [],
        tools: [tool(scenario.result)],
      }),
      modelFailure,
    );
  });

  test(`SessionService independently rejects read-only ${scenario.name}`, async () => {
    const store = new Store(":memory:");
    const engine: ConversationEngine = {
      contextTokens: 50000,
      summarize: async () => "",
      run: async () => ({
        text: scenario.text,
        messages: [],
        toolCalls: 1,
        writeCalls: 0,
        toolEvidence: evidence(scenario.result),
      }),
    };
    const sessions = new SessionService(store, engine, { tools: () => [tool(scenario.result)] });
    try {
      const session = sessions.current(actor.ownerId, actor.chatId);
      await assert.rejects(
        sessions.reply({ ...actor, sessionId: session.id }, "查询任务现状"),
        modelFailure,
      );
      assert.equal(
        sessions.history(actor.ownerId, session.id).some((message) => message.role === "assistant"),
        false,
      );
    } finally {
      store.close();
    }
  });
}

for (const text of ["任务已创建。还需要什么？", "任务已创建，还需要什么？"]) {
  test(`both boundaries reject unsupported assertion before question: ${text}`, async () => {
    const engine = new PiEngine(config, { streamFn: scripted([response(text)]) });
    await assert.rejects(
      engine.run({
        actor,
        sessionId: actor.sessionId,
        systemPrompt: "",
        prompt: "你好",
        messages: [],
        tools: [],
      }),
      modelFailure,
    );
    const store = new Store(":memory:");
    const custom: ConversationEngine = {
      contextTokens: 50000,
      summarize: async () => "",
      run: async () => ({ text, messages: [] }),
    };
    const sessions = new SessionService(store, custom);
    try {
      const session = sessions.current(actor.ownerId, actor.chatId);
      await assert.rejects(
        sessions.reply({ ...actor, sessionId: session.id }, "你好"),
        modelFailure,
      );
    } finally {
      store.close();
    }
  });
}

test("pure questions remain allowed without evidence in both boundaries", async () => {
  const text = "飞书任务已创建吗？任务群是否已建立？";
  const engine = new PiEngine(config, { streamFn: scripted([response(text)]) });
  const store = new Store(":memory:");
  const sessions = new SessionService(store, engine);
  try {
    const session = sessions.current(actor.ownerId, actor.chatId);
    assert.equal((await sessions.reply({ ...actor, sessionId: session.id }, "你好")).text, text);
  } finally {
    store.close();
  }
});

test("verified initial delivery can be reported from a read, but unknown effects still block it", () => {
  const facts = evidence({
    ...task,
    participants: [{ ...task.participants[0], initialSent: true }],
  });
  assert.equal(evaluateClaimPolicy("要求已转交给 Codex", facts).rejected, false);
  assert.equal(evaluateClaimPolicy("要求已转交给 Codex", { ...facts, unknown: 1 }).rejected, true);
  assert.equal(evaluateClaimPolicy("飞书任务已创建", { ...facts, notExecuted: 1 }).rejected, true);
  assert.equal(evaluateClaimPolicy("任务群已就绪", { ...facts, unknown: 1 }).rejected, true);
  assert.equal(evaluateClaimPolicy("任务群已就绪", { ...facts, successful: 0 }).rejected, true);
});

test("a write counter cannot prove a fabricated task identifier or missing group before a question", () => {
  const facts = { ...evidence({ ...task, chatId: undefined }), successfulWrites: 1 };
  assert.equal(evaluateClaimPolicy("已创建任务 task_fake123", facts).rejected, true);
  assert.equal(evaluateClaimPolicy("任务群已建立，还需要什么？", facts).rejected, true);
});

/**
 * A refused read-only call produces no side effect, so a later successful read
 * can prove the current state and fully resolve the earlier refusal. Regression
 * for the v0.3.26 false `model_failed`: a task_get with a missing argument
 * (code "input") then a corrected task_get, whose accurate answer was rejected
 * as not_executed on every retry even though the turn had a confirmed write.
 */
test("a refused read-only lookup never becomes an outstanding business action", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "wrong", name: "task_get", arguments: {} }]),
      response("", [{ type: "toolCall", id: "correct", name: "task_get", arguments: { taskId } }]),
      response("飞书任务已创建，任务群已就绪"),
    ]),
  });
  const result = await engine.run({
    actor,
    sessionId: actor.sessionId,
    systemPrompt: "Report only current tool facts",
    prompt: "查询任务现状",
    messages: [],
    tools: [
      {
        ...tool(task, "task_get"),
        execute: async (args) => {
          if (!args.taskId) throw new OperationError("input", "缺少有效字段：taskId");
          return task;
        },
      },
    ],
  });
  assert.equal(result.text, "飞书任务已创建，任务群已就绪");
  assert.equal(result.toolEvidence?.notExecuted, 1);
  assert.equal(result.toolEvidence?.unresolvedNotExecuted, 0);
});

test("an unresolved write refusal still blocks a completion claim", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "write", name: "task_create", arguments: {} }]),
      response("", [{ type: "toolCall", id: "read", name: "task_get", arguments: { taskId } }]),
      response("飞书任务已创建，任务群已就绪"),
      response("飞书任务已创建，任务群已就绪"),
    ]),
  });
  await assert.rejects(
    engine.run({
      actor,
      sessionId: actor.sessionId,
      systemPrompt: "Report only current tool facts",
      prompt: "创建任务并确认现状",
      messages: [],
      tools: [
        {
          name: "task_create",
          description: "Register a task",
          readOnly: false,
          parameters: { type: "object", properties: {} },
          execute: async () => {
            throw new OperationError("project_name", "新建项目需要明确名称。");
          },
        },
        tool(task, "task_get"),
      ],
    }),
    (error: unknown) => modelFailure(error),
  );
});

test("a claim rejection after a confirmed write reports an unknown, never not_executed effect", async () => {
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "write", name: "task_create", arguments: {} }]),
      response("已创建任务 task_fake123"),
      response("已创建任务 task_fake123"),
    ]),
  });
  await assert.rejects(
    engine.run({
      actor,
      sessionId: actor.sessionId,
      systemPrompt: "Report only current tool facts",
      prompt: "创建任务",
      messages: [],
      tools: [
        {
          name: "task_create",
          description: "Register a task",
          readOnly: false,
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            accepted: true,
            task: { id: "task_real", status: "queued", groupDeleted: false },
          }),
        },
      ],
    }),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === "model_failed" &&
      error.outcome === "unknown",
  );
});
