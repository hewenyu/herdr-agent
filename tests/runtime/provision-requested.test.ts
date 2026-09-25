import assert from "node:assert/strict";
import test from "node:test";
import { PiEngine } from "../../src/runtime/index.js";
import {
  type ProvisionEvidence,
  recordProvisionEvidence,
  unsupportedProvisionClaim,
} from "../../src/runtime/provision-evidence.js";
import { config, response, scripted } from "./helpers.js";

// E42 C1: the original candidate was rejected after accepted/queued, before task_get.
// Source: e42-task-c-created.json, checkpoint da6ecd87… at 2026-09-19T15:11:11.974Z.
const taskId = "task_75eec76e171df567ac26a06e2f6e4fc8";
const queued = { id: taskId, status: "queued", groupDeleted: false };
const candidate = `已登记完成：

- 项目：MYRIX-E42-PROJECT-C（默认 Codex），主目录 \`/Users/yueban/herder-agent-code/MYRIX-E42-PROJECT-C\`
- 开发任务：MYRIX-E42-C1（task_75eec76e171df567ac26a06e2f6e4fc8），共享模式，已申请创建飞书任务和群

飞书任务、任务群和 Codex 执行器正在后台异步创建，稍后会自动把完整要求投递给 Codex 执行。待资源就绪、要求投递确认后，进度会在任务群中跟进汇报。`;

function evidence(): ProvisionEvidence {
  const facts: ProvisionEvidence = { created: [], tasks: [] };
  recordProvisionEvidence(facts, "task_create", {}, { accepted: true, task: queued });
  return facts;
}

test("E42 queued creation can report the requested provisioning stage without recovery", async () => {
  let calls = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted([
      response("", [{ type: "toolCall", id: "create", name: "task_create", arguments: {} }]),
      response(candidate),
    ]),
  });
  const result = await engine.run({
    actor: { ownerId: "owner", chatId: "entry", sessionId: "session", messageId: "e42" },
    sessionId: "session",
    prompt: "创建 MYRIX-E42-C1 开发任务，建立飞书任务和群。",
    systemPrompt: "Only orchestrate. Report the verified provisioning stage.",
    messages: [],
    tools: [
      {
        name: "task_create",
        description: "Register task provisioning",
        readOnly: false,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          calls += 1;
          return { accepted: true, task: queued };
        },
      },
    ],
  });
  assert.equal(result.text, candidate);
  assert.equal(result.toolCalls, 1);
  assert.equal(calls, 1);
  assert.equal(result.toolEvidence?.provisioning?.tasks[0]?.group, false);
  assert.equal(result.toolEvidence?.provisioning?.tasks[0]?.remoteTask, false);
});

for (const text of [
  "已申请创建飞书任务和群。",
  "已请求建立飞书任务和任务群。",
  "已经申请创建协作群，尚未确认建立。",
  "任务已登记，已请求建立群聊。",
  "已申请创建群，现尚未创建成功。",
  "已请求建立群，并且之后会创建成功。",
  "已申请创建飞书任务，现已创建失败。",
]) {
  test(`a provisioning request is not a completion claim: ${text}`, () => {
    assert.equal(unsupportedProvisionClaim(text, evidence()), false);
  });
}

for (const [text, resource] of [
  ["已申请创建群，现已创建成功。", "group"],
  ["已申请创建群且创建成功。", "group"],
  ["已申请创建飞书任务，现已创建成功。", "remote"],
  ["已请求建立群，而且已经建立成功。", "group"],
  ["已申请创建飞书任务和群，现已创建成功。", "both"],
] as const) {
  test(`implicit completion keeps the requested resource subject: ${text}`, () => {
    const facts = evidence();
    assert.equal(unsupportedProvisionClaim(text, facts), true);
    recordProvisionEvidence(
      facts,
      "task_get",
      {},
      {
        ...queued,
        ...(resource !== "remote" ? { chatId: "group" } : {}),
        ...(resource !== "group" ? { remoteTaskId: "remote" } : {}),
      },
    );
    assert.equal(unsupportedProvisionClaim(text, facts), false);
  });
}

test("implicit completion cannot borrow another explicit task's provisioning facts", () => {
  const facts = evidence();
  recordProvisionEvidence(
    facts,
    "task_get",
    {},
    {
      id: "task_ready",
      groupDeleted: false,
      chatId: "group",
    },
  );
  assert.equal(
    unsupportedProvisionClaim(`task_ready 群已建立，${taskId} 已申请创建群，现已创建成功。`, facts),
    true,
  );
});

for (const text of [
  "已申请创建飞书任务和群，群已建立。",
  "已请求建立群聊，并且群已建立。",
  "已申请创建群且群已建立。",
  "已申请创建群 群已建立。",
  "已申请创建群，飞书任务已创建。",
  "已申请创建群，要求已转交给 Codex。",
  "已请求建立群并且要求已转交给 Codex。",
]) {
  test(`a requested stage cannot hide a later completion claim: ${text}`, () => {
    assert.equal(unsupportedProvisionClaim(text, evidence()), true);
  });
}

test("a pending remote request does not contaminate a verified group assertion", () => {
  const facts = evidence();
  recordProvisionEvidence(facts, "task_get", {}, { ...queued, chatId: "group" });
  assert.equal(unsupportedProvisionClaim("已申请创建飞书任务，群已建立。", facts), false);
  assert.equal(unsupportedProvisionClaim("已申请创建群，飞书任务已创建。", facts), true);
});

test("requested stages retain explicit task isolation and do not borrow another task's facts", () => {
  const facts = evidence();
  recordProvisionEvidence(
    facts,
    "task_get",
    {},
    {
      id: "task_ready",
      chatId: "group",
      groupDeleted: false,
      remoteTaskId: "remote",
      participants: [{ id: "codex", kind: "codex", initialSent: true }],
    },
  );
  assert.equal(
    unsupportedProvisionClaim(
      `${taskId} 已申请创建飞书任务和群，task_ready 群已建立，要求已转交给 Codex。`,
      facts,
    ),
    false,
  );
  assert.equal(
    unsupportedProvisionClaim(
      `task_ready 已请求建立群，${taskId} 群已建立，要求已转交给 Codex。`,
      facts,
    ),
    true,
  );
  assert.equal(
    unsupportedProvisionClaim("task_ready 已请求建立群，task_unknown 群已建立。", facts),
    true,
  );
});
