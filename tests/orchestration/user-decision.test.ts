import assert from "node:assert/strict";
import test from "node:test";
import { workflowNotice } from "../../src/app/workflow-notifications.js";
import { OperationError } from "../../src/core/errors.js";
import { workflowState } from "../../src/orchestration/state.js";
import {
  currentUserDecision,
  ensureUserDecision,
  parseUserDecisionQuestions,
  renderUserDecision,
  type UserDecisionInput,
  type UserDecisionQuestion,
  type UserDecisionSource,
} from "../../src/orchestration/user-decision.js";
import { WORKFLOWS } from "../../src/orchestration/workflow.js";
import { Engine } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

const question: UserDecisionQuestion = {
  kind: "choice",
  question: "首版是否需要跨设备同步阅读进度？",
  why: "双方对首版范围仍有分歧；当前需求没有说明是否需要账号和云同步。",
  blockedScope: "这会决定账号与存储章节的最终设计，其他阅读界面讨论可继续。",
  sourceRefs: ["issue:sync"],
  options: [
    { label: "先做本地阅读", impact: "首版无需账号服务，阅读进度仅保留在本设备。" },
    { label: "首版包含同步", impact: "需要账号、服务端与多设备进度冲突规则，开发范围扩大。" },
  ],
  replyExample: "首版先做本地阅读，同步留到后续版本。",
};
const sources: UserDecisionSource[] = [
  {
    id: "issue:sync",
    kind: "issue",
    text: "首版是否需要跨设备同步，双方未达成一致。",
    participantId: "p1",
    outputIds: ["out1"],
  },
  { id: "user:create", kind: "user", text: "设计小说阅读软件并落盘。" },
];

async function harness() {
  const h = setup();
  h.config.ai.enabled = true;
  const task = await h.service.create(actor, {
    ...discussion,
    orchestration: { mode: "workflow" },
  });
  const state = workflowState(h.store, task, "user-r1");
  state.issues.push({
    id: "sync",
    description: sources[0]?.text ?? "",
    status: "open",
    blocking: true,
    evidenceRefs: [],
    raisedBy: task.participantIds[0] ?? "p1",
    responses: [
      { outputId: "out1", summary: "首版同步方案影响账号和数据存储，需产品所有者裁决。" },
    ],
  });
  const engine = new Engine();
  engine.handler = async (input) => {
    assert.equal(input.tools.length, 1);
    assert.equal(input.tools[0]?.readOnly, true);
    assert.equal(input.tools[0]?.name, "workflow_user_decision");
    await input.tools[0]?.execute({ status: "ready", questions: [question] }, input.actor);
    return { text: "不使用这段自由文本通知用户。", messages: [] };
  };
  const input: UserDecisionInput = {
    task,
    state,
    engine,
    actor,
    eventId: "event1",
    revision: "r1",
    assertCurrent() {},
    persist(decision) {
      state.userDecision = decision;
      h.store.set(WORKFLOWS, task.id, state);
    },
  };
  return { ...h, task, state, engine, input };
}

test("a grounded user decision explains the question, choices, consequences and exact reply", async () => {
  const h = await harness();
  try {
    const decision = await ensureUserDecision(h.input);
    assert.equal(decision.status, "ready");
    assert.deepEqual(decision.questions, [question]);
    assert.equal(
      decision.sources.find((source) => source.id === "issue:sync")?.outputIds?.[0],
      "out1",
    );
    const rendered = renderUserDecision(decision);
    for (const required of [
      question.question,
      question.why,
      question.blockedScope,
      question.replyExample,
      "首版无需账号服务",
      "开发范围扩大",
    ])
      assert.ok(rendered.includes(required), required);
    assert.doesNotMatch(rendered, /不使用这段自由文本|sourceRefs|补充相关要求/);
    assert.equal(
      h.herdr.sends.length,
      0,
      "question synthesis has no participant dispatch capability",
    );
    const cached = await ensureUserDecision(h.input);
    assert.deepEqual(cached, decision);
    assert.equal(h.engine.calls.length, 1, "same event and evidence reuse the durable question");
  } finally {
    h.close();
  }
});

test("pure missing external input has a concrete format and example without fake choices", () => {
  const inputQuestion = {
    kind: "input",
    question: "请提供你已有小说目录接口的分页返回示例。",
    why: "现有方案要兼容用户自有接口，参与者无权访问其响应。",
    blockedScope: "仅阻塞目录适配层字段设计。",
    sourceRefs: ["issue:sync"],
    missingInput: "一页脱敏 JSON：章节 id、名称，以及下一页标记。",
    example: '{"chapters":[{"id":"c1","title":"第一章"}],"next":null}',
    replyExample: "这是我目前接口的一页脱敏结果：……",
  };
  const parsed = parseUserDecisionQuestions([inputQuestion], sources);
  assert.deepEqual(parsed[0], inputQuestion);
  assert.equal(parsed[0]?.options, undefined);
});

test("vague questions, invented references, user-only obligations and malformed options are rejected", () => {
  const invalid: Array<Record<string, unknown>> = [
    { ...question, question: "请补充相关要求、材料或检查结果" },
    { ...question, sourceRefs: [] },
    { ...question, sourceRefs: ["issue:other-task"] },
    { ...question, sourceRefs: ["user:create"] },
    { ...question, why: "" },
    { ...question, blockedScope: "" },
    { ...question, replyExample: "" },
    { ...question, options: [{ label: "继续", impact: "" }] },
    { ...question, options: [question.options?.[0], question.options?.[0]] },
    { ...question, command: "execute something" },
    { ...question, question: "a".repeat(241) },
  ];
  for (const value of invalid) assert.throws(() => parseUserDecisionQuestions([value], sources));
  assert.throws(() => parseUserDecisionQuestions(Array(4).fill(question), sources));
});

test("protocol failure and uncertain selection alone never create user obligations or pi calls", async () => {
  const h = await harness();
  try {
    h.state.issues = [];
    h.input.diagnostics = ["result.json 的 evidenceRefs 引用了未知 E-2；需要参与者修正回执。"];
    const decision = await ensureUserDecision(h.input);
    assert.equal(decision.status, "system");
    assert.equal(h.engine.calls.length, 0);
    assert.deepEqual(decision.questions, []);
    assert.match(renderUserDecision(decision), /E-2/);
    assert.match(renderUserDecision(decision), /无需猜测或补交需求、材料/);
    assert.match(renderUserDecision(decision), /查看当前卡点及失败原因/);
  } finally {
    h.close();
  }
});

test("the restricted model may recognize an internal issue instead of asking a user question", async () => {
  const h = await harness();
  try {
    h.engine.handler = async (input) => {
      await input.tools[0]?.execute({ status: "system", questions: [] }, input.actor);
      return { text: "请补充所有资料", messages: [] };
    };
    const decision = await ensureUserDecision(h.input);
    assert.equal(decision.status, "system");
    assert.doesNotMatch(renderUserDecision(decision), /请补充所有资料/);
  } finally {
    h.close();
  }
});

test("failed generation is persisted as a system diagnosis and does not repeatedly invoke pi", async () => {
  const h = await harness();
  try {
    h.engine.handler = async () => {
      throw new Error("provider secret details");
    };
    const decision = await ensureUserDecision(h.input);
    assert.equal(decision.status, "failed");
    assert.match(renderUserDecision(decision), /待决问题整理失败/);
    assert.doesNotMatch(renderUserDecision(decision), /provider secret details/);
    await ensureUserDecision(h.input);
    assert.equal(h.engine.calls.length, 1);
  } finally {
    h.close();
  }
});

test("free-form model replies cannot substitute for a validated question tool call", async () => {
  const h = await harness();
  try {
    h.engine.handler = async () => ({ text: "请提供所有材料", messages: [] });
    const decision = await ensureUserDecision(h.input);
    assert.equal(decision.status, "failed");
    assert.equal(decision.reason, "missing_question_tool_call");
    assert.deepEqual(decision.questions, []);
  } finally {
    h.close();
  }
});

test("repeated unchanged invalid questions stop model repair and preserve a specific diagnosis", async () => {
  const h = await harness();
  try {
    h.engine.handler = async (input) => {
      const tool = input.tools[0];
      assert.ok(tool);
      const vague = { status: "ready", questions: [{ ...question, question: "请补充相关材料" }] };
      await assert.rejects(tool.execute(vague, input.actor, input.signal));
      assert.equal(input.signal?.aborted, false);
      await assert.rejects(tool.execute(vague, input.actor, input.signal));
      assert.equal(input.signal?.aborted, true);
      return { text: "", messages: [] };
    };
    const result = await ensureUserDecision(h.input);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "repeated_invalid_question");
    assert.deepEqual(result.questions, []);
  } finally {
    h.close();
  }
});

test("source output changes, resolved issues and user revisions invalidate cached questions", async () => {
  const h = await harness();
  try {
    const first = await ensureUserDecision(h.input);
    h.state.issues[0]?.responses.push({ outputId: "out2", summary: "云同步范围进一步明确。" });
    assert.equal(currentUserDecision(h.state), undefined);
    const second = await ensureUserDecision(h.input);
    assert.notEqual(second.fingerprint, first.fingerprint);
    assert.equal(h.engine.calls.length, 2);
    const issue = h.state.issues[0];
    assert.ok(issue);
    issue.status = "resolved";
    assert.equal(currentUserDecision(h.state), undefined);
    const resolved = await ensureUserDecision(h.input);
    assert.equal(resolved.status, "system");
    assert.equal(h.engine.calls.length, 2);
    h.state.userRevision = "user-r2";
    assert.equal(currentUserDecision(h.state), undefined);
    const revised = await ensureUserDecision({ ...h.input, revision: "r2" });
    assert.notEqual(revised.fingerprint, resolved.fingerprint);
  } finally {
    h.close();
  }
});

test("an issue cannot recreate a user obligation from an older project version or an obsolete reply", async () => {
  const h = await harness();
  try {
    h.input.artifactRevision = "source-new";
    h.state.nodes["opening-1"] = {
      status: "blocked",
      attempt: 1,
      outputId: "out1",
      artifactRevision: "source-old",
    };
    const stale = await ensureUserDecision(h.input);
    assert.equal(stale.status, "system");
    assert.equal(
      stale.sources.some((source) => source.kind === "issue"),
      false,
    );
    assert.equal(h.engine.calls.length, 0);

    h.state.nodes["opening-1"].artifactRevision = "source-new";
    const current = await ensureUserDecision(h.input);
    assert.equal(current.status, "ready");
    assert.equal(h.engine.calls.length, 1);

    h.state.issues[0]?.responses.push({
      outputId: "out2",
      summary: "来自另一项目版本的新回应尚未复核。",
    });
    const changedReply = await ensureUserDecision(h.input);
    assert.equal(
      changedReply.status,
      "system",
      "a matching earlier response cannot bless the latest obsolete reply",
    );
    assert.equal(h.engine.calls.length, 1);

    h.state.evidence.push({
      id: "evidence-current",
      outputId: "out2",
      source: "self_report",
      description: "当前版本已经核对该分歧",
      artifactRevision: "source-new",
      result: "passed",
    });
    const stillStale = await ensureUserDecision(h.input);
    assert.equal(
      stillStale.status,
      "system",
      "retained historical evidence cannot validate a missing current-node response",
    );
    h.state.nodes["opening-1"].outputId = "out2";
    const reviewed = await ensureUserDecision(h.input);
    assert.equal(reviewed.status, "ready");
    assert.equal(h.engine.calls.length, 2);
  } finally {
    h.close();
  }
});

test("cancellation and supersession during synthesis never persist or display stale questions", async () => {
  const h = await harness();
  try {
    let superseded = false;
    h.input.assertCurrent = () => {
      if (superseded) throw new OperationError("orchestration_superseded", "changed");
    };
    h.engine.handler = async (input) => {
      await input.tools[0]?.execute({ status: "ready", questions: [question] }, input.actor);
      superseded = true;
      return { text: "", messages: [] };
    };
    await assert.rejects(ensureUserDecision(h.input), { code: "orchestration_superseded" });
    assert.equal(h.state.userDecision, undefined);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(ensureUserDecision({ ...h.input, signal: controller.signal }), {
      code: "cancelled",
    });
    assert.equal(h.engine.calls.length, 1);
  } finally {
    h.close();
  }
});

test("lifecycle notices render current persisted questions and never reuse a resolved dispute", async () => {
  const h = await harness();
  try {
    await ensureUserDecision(h.input);
    h.state.stall.awaitingUser = true;
    h.store.set(WORKFLOWS, h.task.id, h.state);
    const notice = workflowNotice(h.task, "progress", [], h.store);
    assert.match(notice.text, /首版是否需要跨设备同步阅读进度/);
    assert.match(notice.text, /回复示例/);
    assert.equal(notice.evidenceFingerprint, h.state.userDecision?.fingerprint);
    const issue = h.state.issues[0];
    assert.ok(issue);
    issue.status = "resolved";
    h.store.set(WORKFLOWS, h.task.id, h.state);
    const stale = workflowNotice(h.task, "progress", [], h.store);
    assert.doesNotMatch(stale.text, /首版是否需要跨设备同步阅读进度/);
    assert.match(stale.text, /尚未整理出可回答的具体问题/);
    assert.equal(h.engine.calls.length, 1, "rendering a notice cannot invoke models");
  } finally {
    h.close();
  }
});

test("a durable wait event exclusively owns question delivery even before its send is confirmed", async () => {
  const h = await harness();
  try {
    const decision = await ensureUserDecision(h.input);
    h.state.stall.awaitingUser = true;
    h.store.set(WORKFLOWS, h.task.id, h.state);
    for (const notificationState of [undefined, "sending", "uncertain", "sent"]) {
      h.store.set("task_orchestration_events", decision.eventId, {
        taskId: h.task.id,
        userRevision: decision.revision,
        decision: { action: "wait" },
        notificationState,
      });
      assert.equal(workflowNotice(h.task, "progress", [], h.store).notify, false);
    }
    h.store.set("task_orchestration_events", decision.eventId, {
      taskId: "foreign-task",
      userRevision: decision.revision,
      decision: { action: "wait" },
    });
    assert.equal(workflowNotice(h.task, "progress", [], h.store).notify, true);
  } finally {
    h.close();
  }
});
