import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type OrchestrationEvent,
  type SettledTaskOutput,
  TaskOrchestrator,
} from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import { stableId } from "../../src/core/ids.js";
import type { ActorContext, StoredMessage, Task } from "../../src/core/types.js";
import type { EngineInput, RuntimeTool } from "../../src/runtime/types.js";
import { actor, discussion, setup } from "../tasks/helpers.js";
import { deferred, Engine, logger } from "./helpers.js";

const TABLE = "task_orchestration_events";

async function harness() {
  const h = setup();
  h.config.ai.enabled = true;
  const engine = new Engine();
  const control = new AbortController();
  const replies: string[] = [];
  const task = await h.service.create(actor, {
    ...discussion,
    kind: "development",
    requirements: "Codex 与 Claude 协作交付功能。只修改授权文件；自主评审和修订。",
    orchestration: { mode: "model" },
  });
  await h.service.reconcile(task.id);
  const tools = (_actor: ActorContext): RuntimeTool[] => [
    {
      name: "task_get",
      description: "read",
      readOnly: true,
      parameters: {},
      execute: async (_args, ctx) => h.service.get(ctx, task.id),
    },
    {
      name: "participant_screen",
      description: "screen",
      readOnly: true,
      parameters: {},
      execute: async (args, ctx) => h.service.screen(ctx, task.id, String(args.participantId)),
    },
    {
      name: "participant_send",
      description: "send",
      readOnly: false,
      parameters: {},
      execute: async (args, ctx) =>
        h.service.send(ctx, String(args.taskId), String(args.participantId), String(args.text)),
    },
    {
      name: "task_action",
      description: "forbidden",
      readOnly: false,
      parameters: {},
      execute: async () => assert.fail("background must never close/complete"),
    },
  ];
  const options = {
    store: h.store,
    engine,
    tasks: () => h.service,
    tools,
    signal: control.signal,
    logger,
    retryDelayMs: 0,
    onReply: async (_task: Task, text: string) => {
      replies.push(text);
    },
  };
  const worker = new TaskOrchestrator(options);
  const participants = h.service.records.participants(task);
  const execute = (input: EngineInput, name: string, args: Record<string, unknown>) => {
    const tool = input.tools.find((entry) => entry.name === name);
    assert.ok(tool, name);
    return tool.execute(args, input.actor);
  };
  return { ...h, engine, control, replies, task, participants, worker, options, execute };
}

test("model selects arbitrary participants, revises same agent and delivers verified native output without another user turn", async () => {
  const h = await harness();
  try {
    assert.equal(h.herdr.sends.length, 0, "model tasks provision without imposing first speaker");
    const [first, second] = h.participants;
    assert.ok(first?.execution && second?.execution);
    let step = 0;
    h.engine.handler = async (input) => {
      assert.deepEqual(
        input.tools.map((tool) => tool.name),
        [
          "task_get",
          "participant_screen",
          "participant_send",
          "orchestration_output",
          "orchestration_decide",
        ],
      );
      const data = JSON.parse(input.prompt);
      assert.equal(data.task.requirements, h.task.requirements);
      if (step < 3) {
        const chosen = step < 2 ? second : first;
        await h.execute(input, "participant_send", {
          participantId: chosen.id,
          text: ["先实现完整功能", "评审指出边界不完整，请修订", "独立验证后整合完整交付结论"][
            step
          ],
        });
        await h.execute(input, "orchestration_decide", {
          action: "continue",
          reason: "按当前证据安排下一步。",
        });
      } else {
        const output = data.authoritativeOutputs.find(
          (entry: { entry: { text: string } }) => entry.entry.text === "验证通过，完整交付正文",
        );
        assert.ok(output);
        await h.execute(input, "orchestration_decide", {
          action: "deliver",
          reason: "参与者完成实现、修订和验证，交付结果供验收。",
          outputId: output.entry.id,
        });
      }
      step++;
      return { text: "调度决定已记录", messages: [] };
    };
    await h.worker.tick();
    assert.equal(h.herdr.sends[0]?.pane, second.execution.paneId);
    await h.worker.tick();
    assert.equal(step, 1, "running native work cannot trigger a second planning turn");
    h.herdr.finish(second.execution.paneId, "初版完成，需要处理边界");
    await h.service.reconcile(h.task.id);
    await h.worker.tick();
    assert.equal(h.herdr.sends[1]?.pane, second.execution.paneId);
    h.herdr.finish(second.execution.paneId, "修订完成，请独立检查");
    await h.service.reconcile(h.task.id);
    await h.worker.tick();
    assert.equal(h.herdr.sends[2]?.pane, first.execution.paneId);
    h.herdr.finish(first.execution.paneId, "验证通过，完整交付正文");
    await h.service.reconcile(h.task.id);
    await h.worker.tick();
    await new TaskOrchestrator(h.options).tick();
    assert.equal(step, 4);
    assert.equal(h.herdr.sends.length, 3);
    assert.equal(h.replies.length, 1);
    assert.match(h.replies[0] ?? "", /验证通过，完整交付正文/);
    assert.equal(h.herdr.closes, 0);
    assert.equal(h.service.get(actor, h.task.id).status, "review");
    assert.equal(
      h.store
        .list<OrchestrationEvent>(TABLE)
        .filter((event) => event.decision?.action === "deliver").length,
      1,
    );
  } finally {
    h.close();
  }
});

test("model-only failure retries boundedly and an explicit wait is durable across restarts", async () => {
  const h = await harness();
  try {
    let attempts = 0;
    h.engine.handler = async (input) => {
      if (++attempts < 3) throw new OperationError("model_failed", "transient", "unknown");
      await h.execute(input, "orchestration_decide", {
        action: "wait",
        reason: "请补充部署目标，当前授权信息不足。",
      });
      return { text: "等待必要信息", messages: [] };
    };
    await h.worker.tick();
    await h.worker.tick();
    await h.worker.tick();
    await new TaskOrchestrator(h.options).tick();
    assert.equal(attempts, 3);
    assert.equal(h.herdr.sends.length, 0);
    assert.deepEqual(h.replies, ["请补充部署目标，当前授权信息不足。"]);
    assert.equal(h.store.list<OrchestrationEvent>(TABLE)[0]?.state, "done");
  } finally {
    h.close();
  }
});

test("unknown native dispatch freezes the event and is never replayed after restart", async () => {
  const h = await harness();
  try {
    h.herdr.delivery = { status: "unconfirmed", acked: false, verified: false, attempts: 1 };
    h.engine.handler = async (input) => {
      await h.execute(input, "participant_send", {
        participantId: h.participants[0]?.id,
        text: "执行原任务",
      });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    await h.worker.tick();
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.engine.calls.length, 1);
    assert.equal(h.store.list<OrchestrationEvent>(TABLE)[0]?.state, "attention");
  } finally {
    h.close();
  }
});

test("a crash after a verified send recovers the operation receipt without invoking the model or resending", async () => {
  const h = await harness();
  try {
    h.engine.handler = async (input) => {
      await h.execute(input, "participant_send", {
        participantId: h.participants[0]?.id,
        text: "唯一执行要求",
      });
      throw new OperationError("model_failed", "response lost", "unknown");
    };
    await h.worker.tick();
    const event = h.store.list<OrchestrationEvent>(TABLE)[0];
    assert.ok(event?.dispatches[0]);
    h.store.set(TABLE, event.id, {
      ...event,
      state: "processing",
      decision: undefined,
      dispatches: [{ ...event.dispatches[0], state: "pending" }],
    });
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.engine.calls.length, 1);
    assert.equal(h.store.get<OrchestrationEvent>(TABLE, event.id)?.decision?.action, "continue");
  } finally {
    h.close();
  }
});

test("pause during model planning invalidates tools before any native effect", async () => {
  const h = await harness();
  try {
    const started = deferred();
    const proceed = deferred();
    h.engine.handler = async (input) => {
      started.resolve();
      await proceed.promise;
      await h.execute(input, "participant_send", {
        participantId: h.participants[0]?.id,
        text: "不应发送",
      });
      return { text: "", messages: [] };
    };
    const run = h.worker.tick();
    await started.promise;
    await h.service.action({ ...actor, messageId: "pause" }, h.task.id, "pause");
    proceed.resolve();
    await run;
    assert.equal(h.herdr.sends.length, 0);
    assert.equal(h.store.list<OrchestrationEvent>(TABLE)[0]?.state, "superseded");
  } finally {
    h.close();
  }
});

test("new user requirements invalidate an in-flight model decision", async () => {
  const h = await harness();
  try {
    h.engine.handler = async (input) => {
      const message: StoredMessage = {
        id: "new-user-message",
        sessionId: "task-session",
        taskId: h.task.id,
        role: "user",
        source: "user",
        text: "先不要修改，只审查",
        createdAt: new Date().toISOString(),
        delivery: "delivered",
        deliveryIds: [],
        generation: 0,
      };
      h.store.set("messages", message.id, message);
      await assert.rejects(
        h.execute(input, "participant_send", {
          participantId: h.participants[0]?.id,
          text: "旧执行计划",
        }),
        /新的用户要求/,
      );
      await h.execute(input, "orchestration_decide", { action: "wait", reason: "旧计划" });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    assert.equal(h.herdr.sends.length, 0);
    assert.equal(h.store.list<OrchestrationEvent>(TABLE)[0]?.state, "superseded");
  } finally {
    h.close();
  }
});

test("delivery requires an actual settled native output and background tools cannot cross task scope", async () => {
  const h = await harness();
  try {
    h.engine.handler = async (input) => {
      await assert.rejects(
        h.execute(input, "orchestration_decide", {
          action: "deliver",
          reason: "编造完成",
          outputId: "invented",
        }),
        /实际输出/,
      );
      await assert.rejects(
        h.execute(input, "participant_send", {
          taskId: "another-task",
          participantId: h.participants[0]?.id,
          text: "越界",
        }),
        /当前任务/,
      );
      await h.execute(input, "orchestration_decide", {
        action: "wait",
        reason: "需要用户澄清验收范围。",
      });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    assert.equal(h.herdr.sends.length, 0);
    assert.equal(h.store.list<OrchestrationEvent>(TABLE)[0]?.decision?.action, "wait");
  } finally {
    h.close();
  }
});

test("a model which only talks cannot leave an infinite silent planning loop", async () => {
  const h = await harness();
  try {
    h.engine.handler = async () => ({ text: "我来安排", messages: [] });
    for (let n = 0; n < 6; n++) await h.worker.tick();
    assert.equal(h.engine.calls.length, 3);
    const event = h.store.list<OrchestrationEvent>(TABLE)[0];
    assert.equal(event?.state, "attention");
    assert.equal(event?.error?.code, "orchestration_no_decision");
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    h.close();
  }
});

test("a clarification after wait wakes the model without requiring the user to repeat the task", async () => {
  const h = await harness();
  try {
    let decisions = 0;
    h.engine.handler = async (input) => {
      if (decisions++ === 0)
        await h.execute(input, "orchestration_decide", {
          action: "wait",
          reason: "需要部署目标。",
        });
      else {
        const snapshot = JSON.parse(input.prompt);
        assert.equal(snapshot.event.trigger, "user_revision");
        assert.equal(snapshot.userRevisions.at(-1).text, "部署到测试环境，继续。 ");
        await h.execute(input, "participant_send", {
          participantId: h.participants[1]?.id,
          text: "目标已明确为测试环境，继续原任务。",
        });
        await h.execute(input, "orchestration_decide", {
          action: "continue",
          reason: "已收到必需信息。",
        });
      }
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    h.store.set("messages", "clarification", {
      id: "clarification",
      taskId: h.task.id,
      role: "user",
      source: "user",
      text: "部署到测试环境，继续。 ",
      createdAt: new Date().toISOString(),
    });
    await h.worker.tick();
    assert.equal(decisions, 2);
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    h.close();
  }
});

for (const legacyLimits of [false, true])
  test(`model work continues beyond 32 decisions and 240 minutes (${legacyLimits ? "legacy limits" : "defaults"})`, async () => {
    const h = await harness();
    try {
      const task = h.service.get(actor, h.task.id);
      if (legacyLimits) {
        task.orchestration = { mode: "model", maxDecisions: 1, maxMinutes: 1 };
        h.service.records.save(task);
      }
      let time = Date.now();
      let calls = 0;
      const worker = new TaskOrchestrator({ ...h.options, clock: () => time });
      const participant = h.participants[0];
      assert.ok(participant?.execution);
      h.engine.handler = async (input) => {
        calls++;
        if (calls <= 34)
          await h.execute(input, "participant_send", {
            participantId: participant.id,
            text: `继续完成第 ${calls} 项交付`,
          });
        else {
          const data = JSON.parse(input.prompt);
          await h.execute(input, "orchestration_decide", {
            action: "deliver",
            reason: "所有已授权目标均有真实产出。",
            outputId: data.authoritativeOutputs.at(-1).entry.id,
          });
        }
        return { text: "", messages: [] };
      };
      await worker.tick();
      for (let step = 1; step <= 34; step++) {
        h.herdr.finish(participant.execution.paneId, `第 ${step} 项交付完成`);
        await h.service.reconcile(task.id);
        time += 10 * 60_000;
        await worker.tick();
      }
      assert.equal(calls, 35);
      assert.equal(h.herdr.sends.length, 34);
      assert.equal(h.replies.length, 1);
      assert.match(h.replies[0] ?? "", /第 34 项交付完成/);
      assert.ok(h.store.list<OrchestrationEvent>(TABLE).every((event) => !event.error));
      assert.equal(h.service.get(actor, task.id).status, "review");
    } finally {
      h.close();
    }
  });

for (const paused of [false, true])
  test(`legacy budget attention recovers without replaying native work (${paused ? "explicit pause respected" : "automatic"})`, async () => {
    const h = await harness();
    try {
      const task = h.service.get(actor, h.task.id);
      let calls = 0;
      h.engine.handler = async (input) => {
        if (calls++ === 0)
          await h.execute(input, "participant_send", {
            participantId: h.participants[0]?.id,
            text: "先完成第一阶段",
          });
        else {
          const data = JSON.parse(input.prompt);
          await h.execute(input, "orchestration_decide", {
            action: "deliver",
            reason: "原生交付完整，供用户验收。",
            outputId: data.authoritativeOutputs[0].entry.id,
          });
        }
        return { text: "", messages: [] };
      };
      await h.worker.tick();
      h.herdr.finish(h.participants[0]?.execution?.paneId ?? "", "第一阶段完成");
      await h.service.reconcile(task.id);
      const previous = h.store.list<OrchestrationEvent>(TABLE)[0];
      const output = h.store.list<SettledTaskOutput>("task_settled_outputs")[0];
      assert.ok(previous && output);
      const budget: OrchestrationEvent = {
        id: `orchestrate:${stableId(task.id, "output", previous.userRevision, output.entry.id)}`,
        taskId: task.id,
        trigger: "output",
        outputIds: [output.entry.id],
        userRevision: previous.userRevision,
        state: "attention",
        attempts: 0,
        dispatches: [],
        error: {
          code: "orchestration_budget",
          message: "旧调度预算已用完",
          outcome: "not_executed",
        },
        notified: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      h.store.set(TABLE, budget.id, budget);
      const current = h.service.get(actor, task.id);
      current.status = paused ? "paused" : "attention";
      current.discussion.paused = paused;
      current.error = budget.error?.message;
      h.service.records.save(current);
      const restarted = new TaskOrchestrator(h.options);
      if (paused) {
        await restarted.tick();
        assert.equal(calls, 1);
        assert.equal(h.store.get<OrchestrationEvent>(TABLE, budget.id)?.state, "attention");
        assert.equal(h.service.get(actor, task.id).discussion.paused, true);
        await h.service.action({ ...actor, messageId: "explicit-resume" }, task.id, "resume");
      }
      await restarted.tick();
      assert.equal(calls, 2);
      assert.equal(h.herdr.sends.length, 1);
      assert.equal(h.replies.length, 1, "old attention notice must not suppress the final output");
      assert.match(h.replies[0] ?? "", /第一阶段完成/);
      assert.equal(h.service.get(actor, task.id).error, undefined);
      const recovered = h.store.get<OrchestrationEvent>(TABLE, budget.id);
      assert.equal(recovered?.retiredBudgetRecovery?.error.code, "orchestration_budget");
      assert.equal(recovered?.state, paused ? "superseded" : "done");
      await new TaskOrchestrator(h.options).tick();
      assert.equal(calls, 2);
      assert.equal(h.replies.length, 1);
    } finally {
      h.close();
    }
  });

test("accepted task-group input blocks background dispatch even before it enters session history", async () => {
  const h = await harness();
  try {
    const queued = {
      id: "message:foreground",
      type: "message",
      payload: { chatId: h.task.chatId, text: "暂停" },
      actor: { ...actor, taskId: h.task.id },
      lane: "foreground",
      state: "queued",
      sequence: 1,
      createdAt: new Date().toISOString(),
    };
    h.store.set("inbox", queued.id, queued);
    await h.worker.tick();
    assert.equal(h.engine.calls.length, 0);
    h.store.set("inbox", queued.id, { ...queued, state: "done" });
    h.engine.handler = async (input) => {
      h.store.set("inbox", queued.id, { ...queued, state: "processing" });
      await h.execute(input, "participant_send", {
        participantId: h.participants[0]?.id,
        text: "不可抢在已接受消息前执行",
      });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    assert.equal(h.herdr.sends.length, 0);
    const event = h.store.list<OrchestrationEvent>(TABLE)[0];
    assert.equal(event?.state, "pending");
    assert.equal(event?.attempts, 0, "foreground deferral does not consume model failure budget");
  } finally {
    h.close();
  }
});

test("unknown native effects remain frozen even when a new user message arrives", async () => {
  const h = await harness();
  try {
    h.herdr.delivery = { status: "unconfirmed", acked: false, verified: false, attempts: 1 };
    h.engine.handler = async (input) => {
      await h.execute(input, "participant_send", {
        participantId: h.participants[0]?.id,
        text: "唯一原始输入",
      });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    h.store.set("messages", "retry-user", {
      id: "retry-user",
      taskId: h.task.id,
      role: "user",
      source: "user",
      text: "继续",
      createdAt: new Date().toISOString(),
    });
    await h.worker.tick();
    assert.equal(h.engine.calls.length, 1);
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.store.list<OrchestrationEvent>(TABLE)[0]?.state, "attention");
  } finally {
    h.close();
  }
});

test("crash before the native operation journal exists resumes safely instead of freezing forever", async () => {
  const h = await harness();
  try {
    h.engine.handler = async (input) => {
      await h.execute(input, "orchestration_decide", { action: "wait", reason: "等待信息。" });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    const event = h.store.list<OrchestrationEvent>(TABLE)[0];
    assert.ok(event);
    h.store.set(TABLE, event.id, {
      ...event,
      state: "processing",
      decision: undefined,
      dispatches: [
        {
          operationId: `${h.task.id}:send:crash-before-journal`,
          participantId: h.participants[0]?.id,
          state: "pending",
        },
      ],
    });
    h.engine.handler = async (input) => {
      await h.execute(input, "participant_send", {
        participantId: h.participants[0]?.id,
        text: "只执行这一次",
      });
      await h.execute(input, "orchestration_decide", {
        action: "continue",
        reason: "恢复了未执行步骤。",
      });
      return { text: "", messages: [] };
    };
    await new TaskOrchestrator(h.options).tick();
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(h.store.get<OrchestrationEvent>(TABLE, event.id)?.state, "done");
  } finally {
    h.close();
  }
});

test("unknown delivery notification is persisted visibly and never replayed, but new user intent can continue", async () => {
  const h = await harness();
  try {
    let sends = 0;
    h.options.onReply = async () => {
      sends++;
      throw new OperationError("outbox_unknown", "平台投递结果未知。", "unknown");
    };
    h.engine.handler = async (input) => {
      await h.execute(input, "orchestration_decide", { action: "wait", reason: "需要确认。" });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    await new TaskOrchestrator(h.options).tick();
    assert.equal(sends, 1);
    const event = h.store.list<OrchestrationEvent>(TABLE)[0];
    assert.equal(event?.notificationState, "uncertain");
    assert.equal(event?.state, "attention");
    assert.equal(h.service.get(actor, h.task.id).status, "attention");
    h.store.set("messages", "user-confirm", {
      id: "user-confirm",
      taskId: h.task.id,
      role: "user",
      source: "user",
      text: "我已确认，继续。",
      createdAt: new Date().toISOString(),
    });
    h.engine.handler = async (input) => {
      await h.execute(input, "participant_send", {
        participantId: h.participants[0]?.id,
        text: "根据新确认继续任务",
      });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(sends, 1);
    assert.equal(
      h.store.get<OrchestrationEvent>(TABLE, event?.id ?? "")?.notificationState,
      "uncertain",
    );
  } finally {
    h.close();
  }
});

test("revoked task owner is never sent to the orchestration model", async () => {
  const h = await harness();
  try {
    h.config.feishu.allowedOpenIds = ["other"];
    await h.worker.tick();
    assert.equal(h.engine.calls.length, 0);
    assert.equal(h.replies.length, 0);
  } finally {
    h.close();
  }
});

test("oversized mandatory user constraints stop before a model call instead of being truncated", async () => {
  const h = await harness();
  try {
    h.engine.contextTokens = 7000;
    const task = h.service.get(actor, h.task.id);
    task.requirements = "不得删除用户文件；".repeat(3000);
    h.service.records.save(task);
    await h.worker.tick();
    assert.equal(h.engine.calls.length, 0);
    assert.equal(
      h.store.list<OrchestrationEvent>(TABLE)[0]?.error?.code,
      "orchestration_context_budget",
    );
    assert.equal(h.service.get(actor, h.task.id).requirements, task.requirements);
  } finally {
    h.close();
  }
});

test("per-model cancellation prevents late native dispatch and local decision writes", async () => {
  const h = await harness();
  try {
    h.engine.handler = async (input) => {
      const control = new AbortController();
      control.abort();
      const send = input.tools.find((tool) => tool.name === "participant_send");
      const decide = input.tools.find((tool) => tool.name === "orchestration_decide");
      assert.ok(send && decide);
      await assert.rejects(
        send.execute(
          { participantId: h.participants[0]?.id, text: "不得迟到执行" },
          input.actor,
          control.signal,
        ),
        /取消/,
      );
      await assert.rejects(
        decide.execute({ action: "wait", reason: "失效决定" }, input.actor, control.signal),
        /取消/,
      );
      await h.execute(input, "orchestration_decide", {
        action: "wait",
        reason: "本轮已停止派发。",
      });
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    assert.equal(h.herdr.sends.length, 0);
    assert.equal(h.store.list<OrchestrationEvent>(TABLE)[0]?.decision?.reason, "本轮已停止派发。");
  } finally {
    h.close();
  }
});

test("main-entry authenticated task revisions are included in the next autonomous decision", async () => {
  const h = await harness();
  try {
    let calls = 0;
    h.engine.handler = async (input) => {
      if (calls++ === 0)
        await h.execute(input, "orchestration_decide", { action: "wait", reason: "等待确认。" });
      else {
        const data = JSON.parse(input.prompt);
        assert.equal(data.event.trigger, "user_revision");
        assert.ok(
          data.userRevisions.some(
            (message: { text: string }) => message.text === "继续任务，但只修改文档。",
          ),
        );
        await h.execute(input, "participant_send", {
          participantId: h.participants[0]?.id,
          text: "仅修改文档，继续原目标。",
        });
      }
      return { text: "", messages: [] };
    };
    await h.worker.tick();
    h.store.set("task_user_revisions", "private-followup", {
      taskId: h.task.id,
      source: {
        source: "feishu",
        ownerId: "owner",
        sessionId: "main-session",
        chatId: "entry",
        messageId: "private-followup",
        eventId: "private-followup-event",
        text: "继续任务，但只修改文档。",
      },
      at: new Date().toISOString(),
    });
    await h.worker.tick();
    assert.equal(calls, 2);
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    h.close();
  }
});

test("an unknown final notification recovers from exact delivered proof before the attention gate without resending", async () => {
  const h = await harness();
  try {
    let sends = 0;
    let confirmedEvent: string | undefined;
    let proof: "missing" | "unavailable" | "delivered" = "missing";
    const worker = new TaskOrchestrator({
      ...h.options,
      onReply: async (_task, _text, eventId) => {
        sends++;
        confirmedEvent = eventId;
        throw new OperationError("delivery_uncertain", "最终输出仍在发送。", "unknown");
      },
      replyConfirmed: async (task, eventId) => {
        assert.equal(task.id, h.task.id);
        assert.equal(eventId, confirmedEvent);
        if (proof === "unavailable") throw new OperationError("read_failed", "只读核验暂时失败。");
        return proof === "delivered";
      },
    });
    h.engine.handler = async (input) => {
      const data = JSON.parse(input.prompt);
      if (data.event.trigger === "ready")
        await h.execute(input, "participant_send", {
          participantId: h.participants[0]?.id,
          text: "完成原始工作并给出最终结果",
        });
      else
        await h.execute(input, "orchestration_decide", {
          action: "deliver",
          reason: "交付真实结果供验收。",
          outputId: data.authoritativeOutputs[0].entry.id,
        });
      return { text: "", messages: [] };
    };
    await worker.tick();
    h.herdr.finish(h.participants[0]?.execution?.paneId ?? "", "完整原生交付结果");
    await h.service.reconcile(h.task.id);
    await worker.tick();
    assert.equal(sends, 1);
    assert.equal(h.service.get(actor, h.task.id).error, "最终输出仍在发送。");
    await worker.tick();
    proof = "unavailable";
    await worker.tick();
    assert.equal(h.store.get<OrchestrationEvent>(TABLE, confirmedEvent ?? "")?.state, "attention");
    assert.equal(sends, 1);
    proof = "delivered";
    await worker.tick();
    const event = h.store.get<OrchestrationEvent>(TABLE, confirmedEvent ?? "");
    assert.equal(event?.state, "done");
    assert.equal(event?.notificationState, "sent");
    assert.equal(event?.notified, true);
    assert.equal(event?.error, undefined);
    assert.equal(h.service.get(actor, h.task.id).error, undefined);
    assert.equal(h.service.get(actor, h.task.id).status, "review");
    assert.equal(sends, 1);
    assert.equal(h.engine.calls.length, 2);
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    h.close();
  }
});

test("restart after final envelope delivery recovers the sending checkpoint without clearing unrelated task errors", async () => {
  const h = await harness();
  try {
    const delivered = new Set<string>();
    let sends = 0;
    const options = {
      ...h.options,
      onReply: async (_task: Task, _text: string, eventId: string) => {
        sends++;
        delivered.add(eventId);
      },
      replyConfirmed: async (_task: Task, eventId: string) => delivered.has(eventId),
    };
    const worker = new TaskOrchestrator(options);
    h.engine.handler = async (input) => {
      const data = JSON.parse(input.prompt);
      if (data.event.trigger === "ready")
        await h.execute(input, "participant_send", {
          participantId: h.participants[0]?.id,
          text: "生成真实交付",
        });
      else
        await h.execute(input, "orchestration_decide", {
          action: "deliver",
          reason: "交付。",
          outputId: data.authoritativeOutputs[0].entry.id,
        });
      return { text: "", messages: [] };
    };
    await worker.tick();
    h.herdr.finish(h.participants[0]?.execution?.paneId ?? "", "真实结果");
    await h.service.reconcile(h.task.id);
    await worker.tick();
    const final = h.store
      .list<OrchestrationEvent>(TABLE)
      .find((event) => event.decision?.action === "deliver");
    assert.ok(final);
    h.store.set(TABLE, final.id, {
      ...final,
      notified: false,
      notificationState: "sending",
      error: {
        code: "orchestration_notification_unknown",
        message: "旧通知错误",
        outcome: "unknown",
      },
    });
    const task = h.service.get(actor, h.task.id);
    task.status = "attention";
    task.error = "另一条新故障";
    h.service.records.save(task);
    await new TaskOrchestrator(options).tick();
    assert.equal(sends, 1);
    assert.equal(h.store.get<OrchestrationEvent>(TABLE, final.id)?.notificationState, "sent");
    assert.equal(h.store.get<OrchestrationEvent>(TABLE, final.id)?.notified, true);
    assert.equal(h.store.get<OrchestrationEvent>(TABLE, final.id)?.error, undefined);
    assert.equal(h.service.get(actor, h.task.id).error, "另一条新故障");
    assert.equal(h.service.get(actor, h.task.id).status, "attention");
    assert.equal(h.engine.calls.length, 2);
  } finally {
    h.close();
  }
});
