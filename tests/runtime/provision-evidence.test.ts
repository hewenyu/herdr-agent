import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { OperationError } from "../../src/core/errors.js";
import { PiEngine, SessionService } from "../../src/runtime/index.js";
import type { RuntimeTool } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { config, response, scripted } from "./helpers.js";

const actor = { ownerId: "owner", chatId: "entry", sessionId: "session", messageId: "message" };
const taskId = "task_provision";
const queued = { id: taskId, status: "queued", groupDeleted: false };
// E39 A2's delivered creation reply claimed constraint delivery in its own bullet,
// while the only task_get snapshot still had initialSent:false.
const e39A2DeliveryClaim = `任务已创建并登记完成，当前进展如下：

- **飞书任务**：MYRIX-E39-A2 已建立
- **任务群**：已建立，开发参与者 codex-dev 正在启动，初始要求投递确认中
- **工作目录**：主目录 main + 附加目录 extra-new（shared 模式，无 worktree）
- **约束已完整转交**：只新增 brief-new.md、不改 brief.md 和输入文件、不提交、不装依赖、字节级断言校验、汇报两条原文和校验结果后等验收、不自动完成、不碰 A1

Codex 启动并在群内汇报后，你可以在任务群验收。`;
function provisioned(claudeSent = true, codexSent = true) {
  return {
    ...queued,
    status: "running",
    chatId: "group",
    remoteTaskId: "remote-task",
    participants: [
      { id: "claude-1", kind: "claude", name: "Claude", started: true, initialSent: claudeSent },
      { id: "codex-1", kind: "codex", name: "Codex", started: true, initialSent: codexSent },
    ],
  };
}
function call(name: string, id: string, args: Record<string, unknown> = { taskId }) {
  return response("", [{ type: "toolCall", name, id, arguments: args }]);
}
function tools(
  get: RuntimeTool["execute"] = async () => queued,
  calls: string[] = [],
): RuntimeTool[] {
  return [
    ["task_create", false, async () => ({ accepted: true, task: queued })],
    ["task_get", true, get],
    ["tasks_list", true, async () => [provisioned(), { ...queued, id: "task_pending" }]],
    ["task_action", false, async () => ({ ...provisioned(), status: "completed" })],
  ].map(([name, readOnly, execute]) => ({
    name: name as string,
    description: name as string,
    readOnly: readOnly as boolean,
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" }, action: { type: "string" } },
      additionalProperties: false,
    },
    execute: async (args, bound, signal, operationId) => {
      calls.push(name as string);
      return (execute as RuntimeTool["execute"])(args, bound, signal, operationId);
    },
  }));
}
async function run(messages: AssistantMessage[], runtimeTools = tools()) {
  const engine = new PiEngine(config, { streamFn: scripted(messages) });
  return engine.run({
    actor,
    sessionId: actor.sessionId,
    prompt: "让 Claude 和 Codex 讨论这个需求",
    systemPrompt: "Only orchestrate. Report verified provisioning facts.",
    messages: [],
    tools: runtimeTools,
  });
}

for (const claim of [
  "讨论群已建立。",
  "群已建。",
  "群已经拉好。",
  "飞书任务已创建。",
  "飞书任务已建好。",
  "要求已转交给 Claude 和 Codex。",
  "Claude 和 Codex 已收到要求。",
  "Claude and Codex received the requirements.",
]) {
  test(`queued registration cannot prove external completion: ${claim}`, async () => {
    const calls: string[] = [];
    await assert.rejects(
      run(
        [
          call("task_create", "create"),
          response(claim),
          call("task_get", "read-queued"),
          response(claim),
        ],
        tools(undefined, calls),
      ),
      (error: unknown) => error instanceof OperationError && error.code === "model_failed",
    );
    assert.deepEqual(calls, ["task_create", "task_get"]);
  });
}

test("recovery may report local registration without inventing remote provisioning", async () => {
  const answer = "任务已登记；群尚未建立，要求尚未转交。";
  const calls: string[] = [];
  const result = await run(
    [call("task_create", "create"), response("群已建立。"), response(answer)],
    tools(undefined, calls),
  );
  assert.equal(result.text, answer);
  assert.deepEqual(calls, ["task_create"]);
  assert.equal(result.toolEvidence?.successfulWrites, 1);
});

test("recovery task_get supplies remote task, group and both initial delivery facts", async () => {
  const claim = "飞书任务已创建，群已建立，要求已转交给 Claude 和 Codex。";
  const calls: string[] = [];
  const result = await run(
    [call("task_create", "create"), response(claim), call("task_get", "read"), response(claim)],
    tools(async () => provisioned(), calls),
  );
  assert.equal(result.text, claim);
  assert.deepEqual(calls, ["task_create", "task_get"]);
  assert.equal(result.toolEvidence?.provisioning?.tasks[0]?.group, true);
  assert.equal(result.toolEvidence?.provisioning?.tasks[0]?.remoteTask, true);
});

for (const [claudeSent, codexSent, claim] of [
  [false, false, "要求已转交给 Claude 和 Codex。"],
  [true, false, "要求已转交给 Claude 和 Codex。"],
  [true, false, "要求已转交给双方参与者。"],
  [false, false, "Claude 和 Codex 已收到要求。"],
  [true, false, "Claude 和 Codex 已收到要求。"],
  [true, false, "Claude, Codex received the requirements."],
] as const) {
  test(`started participants do not prove all initial deliveries: ${claudeSent}/${codexSent}/${claim}`, async () => {
    await assert.rejects(
      run(
        [
          call("task_create", "create"),
          call("task_get", "first-read"),
          response(claim),
          call("task_get", "second-read"),
          response(claim),
        ],
        tools(async () => provisioned(claudeSent, codexSent)),
      ),
      (error: unknown) => error instanceof OperationError && error.code === "model_failed",
    );
  });
}

test("one verified participant can be reported without claiming the other was sent", async () => {
  const answer = "要求已转交给 Claude；Codex 尚未收到要求。";
  const result = await run(
    [call("task_create", "create"), call("task_get", "read"), response(answer)],
    tools(async () => provisioned(true, false)),
  );
  assert.equal(result.text, answer);
});

for (const answer of [
  "Claude 和 Codex 已收到要求。",
  "Claude and Codex received the requirements.",
]) {
  test(`verified initial delivery supports receipt claims: ${answer}`, async () => {
    const result = await run(
      [call("task_create", "create"), call("task_get", "read"), response(answer)],
      tools(async () => provisioned()),
    );
    assert.equal(result.text, answer);
  });
}

test("negative, pending and questioned receipt statements do not claim delivery", async () => {
  for (const answer of [
    "Claude 和 Codex 尚未收到要求。",
    "Claude and Codex have not received the requirements.",
    "Claude 和 Codex 会收到要求。",
    "Claude 和 Codex 已收到要求吗？",
  ]) {
    const result = await run([call("task_create", "create"), response(answer)]);
    assert.equal(result.text, answer);
  }
});

test("verified participant_send receipts support received without initialSent in the snapshot", async () => {
  const available = tools(async () => provisioned(false, false));
  available.push({
    name: "participant_send",
    description: "Send participant instructions",
    readOnly: false,
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" }, participantId: { type: "string" } },
      required: ["taskId", "participantId"],
    },
    execute: async () => ({ status: "delivered", verified: true }),
  });
  const answer = "Claude 和 Codex 已收到要求。";
  const result = await run(
    [
      call("task_get", "read"),
      call("participant_send", "send-claude", { taskId, participantId: "claude-1" }),
      call("participant_send", "send-codex", { taskId, participantId: "codex-1" }),
      response(answer),
    ],
    available,
  );
  assert.equal(result.text, answer);
  assert.equal(result.toolEvidence?.successfulWrites, 2);
});

test("task ids scope each assertion without applying another task's pending facts", async () => {
  const answer = "task_provision 群已创建。task_pending 尚未建群。";
  const result = await run([
    call("task_create", "create"),
    call("tasks_list", "list", {}),
    response(answer),
  ]);
  assert.equal(result.text, answer);
});

for (const answer of [
  "task_provision 群已创建，task_pending 尚未建群。",
  "task_pending 尚未建群，task_provision 群已创建。",
  "task_provision 群已创建, task_pending 尚未建群。",
  "task_provision 群已创建，但task_pending 尚未建群。",
  "task_provision 群已创建，而 task_pending 尚未建群。",
]) {
  test(`task clauses keep independent group assertions: ${answer}`, async () => {
    const result = await run([
      call("task_create", "create"),
      call("tasks_list", "list", {}),
      response(answer),
    ]);
    assert.equal(result.text, answer);
  });
}

for (const answer of [
  "task_provision 群已创建，task_pending 群已创建。",
  "task_provision 群已创建，而 task_pending 群已创建。",
  "task_provision 尚未建群，task_pending 群已创建。",
  "task_provision, task_pending 群已创建。",
  "task_provision、task_pending 群已创建。",
  "task_provision 群已创建，task_unknown 群已创建。",
  "task_pending 已登记，群已创建。",
  "群已创建。",
]) {
  test(`mixed or unscoped claims cannot borrow another task's group fact: ${answer}`, async () => {
    await assert.rejects(
      run([
        // Supply a successful write without selecting a newly-created task as
        // the implicit subject. Unscoped assertions must cover every listed task.
        call("task_action", "action", { taskId, action: "complete" }),
        call("tasks_list", "list", {}),
        response(answer),
        call("tasks_list", "verify", {}),
        response(answer),
      ]),
      (error: unknown) => error instanceof OperationError && error.code === "model_failed",
    );
  });
}

test("questions about provisioning remain questions without requiring completed facts", async () => {
  const answer = "群是否已建立？";
  const result = await run([call("task_get", "read"), response(answer)]);
  assert.equal(result.text, answer);
});

for (const answer of ["已将要求发送给实现者。", "要求已转交给参与者 p1。"]) {
  test(`same-kind participants are scoped by explicit name or id: ${answer}`, async () => {
    const result = await run(
      [call("task_create", "create"), call("task_get", "read"), response(answer)],
      tools(async () => ({
        ...provisioned(),
        participants: [
          { id: "p1", name: "实现者", kind: "codex", initialSent: true },
          { id: "p2", name: "评审者", kind: "codex", initialSent: false },
        ],
      })),
    );
    assert.equal(result.text, answer);
  });
}

for (const claim of ["要求已转交给参与者 p2。", "要求已发送给所有 Codex，包括实现者。"]) {
  test(`naming a participant cannot hide incomplete delivery: ${claim}`, async () => {
    await assert.rejects(
      run(
        [
          call("task_create", "create"),
          call("task_get", "read"),
          response(claim),
          call("task_get", "verify"),
          response(claim),
        ],
        tools(async () => ({
          ...provisioned(),
          participants: [
            { id: "p1", name: "实现者", kind: "codex", initialSent: true },
            { id: "p2", name: "评审者", kind: "codex", initialSent: false },
          ],
        })),
      ),
      (error: unknown) => error instanceof OperationError && error.code === "model_failed",
    );
  });
}

test("tasks_list preserves prior enriched participants when only ids are returned", async () => {
  const available = tools(async () => provisioned());
  const list = available.find((tool) => tool.name === "tasks_list");
  assert.ok(list);
  list.execute = async () => {
    const { participants, ...task } = provisioned();
    return [{ ...task, participantIds: participants.map((participant) => participant.id) }];
  };
  const answer = "要求已转交给 Claude 和 Codex。";
  const result = await run(
    [
      call("task_create", "create"),
      call("task_get", "read"),
      call("tasks_list", "list", {}),
      response(answer),
    ],
    available,
  );
  assert.equal(result.text, answer);
  assert.equal(result.toolEvidence?.provisioning?.tasks[0]?.participants.length, 2);
});

test("new explicit participant facts replace earlier delivery evidence", async () => {
  const available = tools(async () => provisioned());
  const list = available.find((tool) => tool.name === "tasks_list");
  assert.ok(list);
  list.execute = async () => [provisioned(true, false)];
  const claim = "要求已转交给 Claude 和 Codex。";
  await assert.rejects(
    run(
      [
        call("task_create", "create"),
        call("task_get", "read"),
        call("tasks_list", "list", {}),
        response(claim),
        call("tasks_list", "verify", {}),
        response(claim),
      ],
      available,
    ),
    (error: unknown) => error instanceof OperationError && error.code === "model_failed",
  );
});

test("corrected task_get followed by completion resolves an earlier rejected lookup in PiEngine", async () => {
  const calls: string[] = [];
  const result = await run(
    [
      call("task_get", "wrong", { taskId: "wrong-id" }),
      call("task_get", "correct"),
      call("task_action", "complete", { taskId, action: "complete" }),
      response("任务已完成。"),
    ],
    tools(async (args) => {
      if (args.taskId !== taskId)
        throw new OperationError("task_missing", "任务不存在或无权访问。");
      return provisioned();
    }, calls),
  );
  assert.equal(result.text, "任务已完成。");
  assert.equal(result.toolEvidence?.notExecuted, 1);
  assert.equal(result.toolEvidence?.unresolvedNotExecuted, 0);
  assert.equal(result.toolEvidence?.successful, 2);
  assert.deepEqual(calls, ["task_get", "task_get", "task_action"]);
});

test("SessionService persists completion after rejected lookup was corrected by the real pi loop", async () => {
  const store = new Store(":memory:");
  const engine = new PiEngine(config, {
    streamFn: scripted([
      call("task_get", "wrong", { taskId: "wrong-id" }),
      call("task_get", "correct"),
      call("task_action", "complete", { taskId, action: "complete" }),
      response("任务已完成。"),
    ]),
  });
  const calls: string[] = [];
  const sessions = new SessionService(store, engine, {
    tools: () =>
      tools(async (args) => {
        if (args.taskId !== taskId)
          throw new OperationError("task_missing", "任务不存在或无权访问。");
        return provisioned();
      }, calls),
  });
  try {
    const session = sessions.current("owner", "entry");
    const reply = await sessions.reply({ ...actor, sessionId: session.id }, "确认任务完成");
    assert.equal(reply.text, "任务已完成。");
    assert.equal(sessions.history("owner", session.id).at(-1)?.id, reply.id);
    assert.deepEqual(calls, ["task_get", "task_get", "task_action"]);
    assert.equal(sessions.beginDelivery("owner", reply.id), true);
    sessions.recordDelivery("owner", reply.id, { complete: true, ids: ["reply"] });
    assert.equal(sessions.history("owner", session.id).at(-1)?.delivery, "delivered");
  } finally {
    store.close();
  }
});

test("SessionService accepts recovery from a wrong task_action using list, action and task_get receipts", async () => {
  const store = new Store(":memory:");
  const engine = new PiEngine(config, {
    streamFn: scripted([
      call("task_action", "wrong", { taskId: "task_missing", action: "complete" }),
      call("tasks_list", "find", {}),
      call("task_action", "complete", { taskId, action: "complete" }),
      call("task_get", "verify"),
      response("任务已完成。"),
    ]),
  });
  const calls: string[] = [];
  const available = tools(async () => ({ ...provisioned(), status: "completed" }), calls);
  const action = available.find((tool) => tool.name === "task_action");
  assert.ok(action);
  const execute = action.execute;
  action.execute = async (args, ...rest) => {
    if (args.taskId === "task_missing") {
      calls.push("task_action");
      throw new OperationError("task_missing", "任务不存在或无权访问。");
    }
    return execute(args, ...rest);
  };
  const sessions = new SessionService(store, engine, { tools: () => available });
  try {
    const session = sessions.current("owner", "entry");
    const reply = await sessions.reply({ ...actor, sessionId: session.id }, "确认任务完成");
    assert.equal(reply.text, "任务已完成。");
    assert.equal(sessions.history("owner", session.id).at(-1)?.id, reply.id);
    assert.deepEqual(calls, ["task_action", "tasks_list", "task_action", "task_get"]);
  } finally {
    store.close();
  }
});

for (const scenario of [
  {
    name: "another task's successful completion cannot clear an ordinary rejection",
    code: "invalid_state",
    reversed: false,
    action: "complete",
    claim: "task_a 和 task_b 已完成。",
  },
  {
    name: "correcting an unknown task cannot prove completion of the original target",
    code: "task_missing",
    reversed: false,
    action: "complete",
    claim: "task_a 已完成。",
  },
  {
    name: "success before a missing-task failure cannot resolve that later failure",
    code: "task_missing",
    reversed: true,
    action: "complete",
    claim: "task_b 已完成。",
  },
  {
    name: "successful pause cannot resolve a missing-task completion attempt",
    code: "task_missing",
    reversed: false,
    action: "pause",
    claim: "task_b 已完成。",
  },
]) {
  test(scenario.name, async () => {
    const available = tools(async (args) => ({ ...provisioned(), id: args.taskId }));
    const action = available.find((tool) => tool.name === "task_action");
    assert.ok(action);
    action.execute = async (args) => {
      if (args.taskId === "task_a") throw new OperationError(scenario.code, "操作未执行。");
      return {
        ...provisioned(),
        id: args.taskId,
        status: args.action === "complete" ? "completed" : "paused",
      };
    };
    const failed = call("task_action", "failed", { taskId: "task_a", action: "complete" });
    const succeeded = call("task_action", "succeeded", {
      taskId: "task_b",
      action: scenario.action,
    });
    const failures: Record<string, unknown>[] = [];
    const engine = new PiEngine(config, {
      streamFn: scripted([
        ...(scenario.reversed ? [succeeded, failed] : [failed, succeeded]),
        response(scenario.claim),
        call("task_get", "verify", { taskId: "task_b" }),
        response(scenario.claim),
      ]),
      logger: {
        info() {},
        warn() {},
        error(_message, fields) {
          failures.push(fields ?? {});
        },
      },
    });
    await assert.rejects(
      engine.run({
        actor,
        sessionId: actor.sessionId,
        prompt: "确认任务完成",
        systemPrompt: "Only orchestrate.",
        messages: [],
        tools: available,
      }),
      (error: unknown) => error instanceof OperationError && error.code === "model_failed",
    );
    const failure = failures.find((entry) => entry.event === "pi.turn_failed");
    assert.equal((failure?.toolEvidence as { notExecuted?: number })?.notExecuted, 1);
    assert.equal(failure?.toolCalls, 3);
  });
}

// Exact candidate text and relevant task_get facts from E36 checkpoint
// 1c151246262c73379de53335d6765155566d597af5b1c40656c83be0df61b409, indices 23/29.
const e36Candidates = [
  {
    text: "已创建并核验真实状态：\n\n- 任务：**MYRIX-E36-COMPLETE-20260919**\n- 任务编号：`task_53dbc3f2899b8fb0c719be0c5d96b91b`\n- 飞书任务已创建：[打开任务](https://applink.feishu.cn/client/todo/detail?guid=78e579af-47c3-4121-bde2-59d9e99c014d&suite_entity_num=t100036)\n- 专属任务群已建立：群 ID `oc_0211e7b2e6c1c30869aeed041d04d718`\n- 当前状态：启动中\n- Codex：已加入，但尚未启动，初始要求的投递尚未确认\n- 已保留 Bypass；讨论目录已生成，目录信任按 pi 启动流程处理，其他确认留在群内\n- 不会自动验收、完成或关闭；Codex 输出 `MYRIX_E36_OK` 后将等待你确认完成",
    snapshot: {
      id: "task_53dbc3f2899b8fb0c719be0c5d96b91b",
      status: "starting",
      remoteTaskId: "78e579af-47c3-4121-bde2-59d9e99c014d",
      chatId: "oc_0211e7b2e6c1c30869aeed041d04d718",
      groupDeleted: false,
      participants: [
        {
          id: "task_53dbc3f2899b8fb0c719be0c5d96b91b:p1",
          name: "Codex",
          kind: "codex",
          status: "pending",
          started: false,
          initialSent: false,
        },
      ],
    },
  },
  {
    text: [
      "已按要求**只读复核，未重复创建任务**。当前已核验阶段如下：",
      "",
      "- **飞书任务已实际创建**：任务编号 `task_53dbc3f2899b8fb0c719be0c5d96b91b`  ",
      "  [打开飞书任务](https://applink.feishu.cn/client/todo/detail?guid=78e579af-47c3-4121-bde2-59d9e99c014d&suite_entity_num=t100036)",
      "- **专属任务群已建立**：群 ID `oc_0211e7b2e6c1c30869aeed041d04d718`，且 `groupDeleted=false`",
      "- **参与者**：仅一名 Codex，已在正确讨论目录中启动并进入交互界面",
      "- **任务状态**：`starting`，尚未完成、未关闭，也不会自动验收",
      "- **Bypass**：已保留为开启",
      "- **尚未确认**：Codex 初始要求的投递仍为 `initialSent=false`，因此不能声称要求已经转交；目前也未捕获到 `MYRIX_E36_OK` 输出",
      "",
      "结论：任务与群均已真实建立，当前处于 **Codex 启动后、初始要求投递确认前** 的阶段。",
    ].join("\n"),
    snapshot: {
      id: "task_53dbc3f2899b8fb0c719be0c5d96b91b",
      status: "starting",
      remoteTaskId: "78e579af-47c3-4121-bde2-59d9e99c014d",
      chatId: "oc_0211e7b2e6c1c30869aeed041d04d718",
      groupDeleted: false,
      participants: [
        {
          id: "task_53dbc3f2899b8fb0c719be0c5d96b91b:p1",
          name: "Codex",
          kind: "codex",
          status: "blocked",
          started: true,
          initialSent: false,
        },
      ],
    },
  },
];

for (const { text, snapshot } of e36Candidates) {
  test(`E36 real creation candidate reports pending delivery without inventing receipt: ${snapshot.participants[0]?.status}`, async () => {
    const available = tools(async () => snapshot);
    const create = available.find((tool) => tool.name === "task_create");
    assert.ok(create);
    create.execute = async () => ({ accepted: true, task: { ...queued, id: snapshot.id } });
    const result = await run(
      [
        call("task_create", "create"),
        call("task_get", "read", { taskId: snapshot.id }),
        response(text),
      ],
      available,
    );
    assert.equal(result.text, text);
    assert.equal(result.toolCalls, 2, "Accurate pending-stage text must not trigger recovery");
    assert.equal(result.toolEvidence?.provisioning?.tasks[0]?.participants[0]?.sent, false);
  });
}

for (const text of [
  "任务与群均已真实建立，Codex 已收到初始要求。",
  "Codex：已加入，初始要求已投递给 Codex。",
  "任务与群均已真实建立，要求已转交给 Codex。",
  "Codex，已收到。",
  "Codex 已转交要求，但投递尚未确认。",
]) {
  test(`separate actual delivery assertions still require a receipt: ${text}`, async () => {
    await assert.rejects(
      run(
        [
          call("task_create", "create"),
          call("task_get", "read"),
          response(text),
          call("task_get", "verify"),
          response(text),
        ],
        tools(async () => provisioned(false, false)),
      ),
      (error: unknown) => error instanceof OperationError && error.code === "model_failed",
    );
  });
}

for (const claim of [e39A2DeliveryClaim, "约束已完整转交。", "Constraints have been delivered."]) {
  test(`constraint delivery needs a participant receipt even in a separate Markdown bullet: ${claim.slice(0, 30)}`, async () => {
    const get = async () => ({
      ...provisioned(),
      participants: [
        { id: "codex-dev", name: "codex-dev", kind: "codex", started: false, initialSent: false },
      ],
    });
    await assert.rejects(
      run(
        [
          call("task_create", "create"),
          call("task_get", "read"),
          response(claim),
          call("task_get", "verify"),
          response(claim),
        ],
        tools(get),
      ),
      (error: unknown) => error instanceof OperationError && error.code === "model_failed",
    );
    const result = await run(
      [call("task_create", "create"), call("task_get", "read"), response(claim)],
      tools(async () => ({
        ...(await get()),
        participants: [
          { id: "codex-dev", name: "codex-dev", kind: "codex", started: true, initialSent: true },
        ],
      })),
    );
    assert.equal(result.text, claim);
  });
}

for (const text of [
  "约束已随任务登记，初始投递尚待确认。",
  "约束尚未完整转交。",
  "约束已完整转交了吗？",
  "当前不能声称约束已完整转交。",
]) {
  test(`pending or questioned constraint delivery remains a valid reply: ${text}`, async () => {
    const result = await run(
      [call("task_create", "create"), call("task_get", "read"), response(text)],
      tools(async () => provisioned(false, false)),
    );
    assert.equal(result.text, text);
  });
}
