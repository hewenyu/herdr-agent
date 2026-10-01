import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { evaluateClaimPolicy } from "../../src/runtime/claim-policy.js";
import { PiEngine } from "../../src/runtime/engine.js";
import {
  type ProvisionEvidence,
  recordProvisionEvidence,
  supportedStartedClaim,
  unsupportedProvisionClaim,
} from "../../src/runtime/provision-evidence.js";
import type { RuntimeTool } from "../../src/runtime/types.js";
import { config, response, scripted } from "./helpers.js";

const actor = { ownerId: "owner", chatId: "entry", sessionId: "session", messageId: "message" };
const taskId = "task_stage";
const queued = { id: taskId, status: "queued", groupDeleted: false };

/** A synthetic mixed-stage snapshot: resources exist, delivery/discussion do not. */
function mixedStage(claudeStarted = true, codexStarted = true, sent = false) {
  return {
    ...queued,
    status: "running",
    chatId: "group",
    remoteTaskId: "remote-task",
    participants: [
      { id: "claude-1", kind: "claude", name: "Claude", started: claudeStarted, initialSent: sent },
      { id: "codex-1", kind: "codex", name: "Codex", started: codexStarted, initialSent: sent },
    ],
  };
}

/** Issue 3: only resource existence plus both process starts are asserted. */
const stageReply =
  "飞书任务已创建，任务群已建立。Claude、Codex 执行环境均已启动；初始要求尚未投递，讨论未开始。";
/** Issue 2: local registration is done, external resources are still pending. */
const pendingReply =
  "任务已登记，正在异步创建飞书任务、专属群并启动 Claude 和 Codex。外部资源还在创建中。";

function call(name: string, id: string, args: Record<string, unknown> = { taskId }) {
  return response("", [{ type: "toolCall", name, id, arguments: args }]);
}

function tools(get: RuntimeTool["execute"] = async () => queued): RuntimeTool[] {
  return (
    [
      ["task_create", false, async () => ({ accepted: true, task: queued })],
      ["task_get", true, get],
    ] as const
  ).map(([name, readOnly, execute]) => ({
    name,
    description: name,
    readOnly,
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" }, action: { type: "string" } },
      additionalProperties: false,
    },
    execute: execute as RuntimeTool["execute"],
  }));
}

function run(messages: ReturnType<typeof response>[], runtimeTools = tools()) {
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

const modelFailure = (error: unknown) =>
  error instanceof OperationError && error.code === "model_failed";

test("Issue 2: a queued local task may report registration plus pending external resources", async () => {
  const result = await run([call("task_create", "create"), response(pendingReply)]);
  assert.equal(result.text, pendingReply);
  assert.equal(result.toolEvidence?.successfulWrites, 1);
  assert.equal(result.toolEvidence?.unknown, 0);
});

test("Issue 2: a read-only task_get snapshot also supports registration plus pending stages", async () => {
  const result = await run(
    [call("task_create", "create"), call("task_get", "read"), response(pendingReply)],
    tools(async () => mixedStage(false, false, false)),
  );
  assert.equal(result.text, pendingReply);
});

test("Issue 2 negative: pending wording cannot excuse an unsupported completed clause", async () => {
  // The read-only snapshots lack the remote task / group the completed clause
  // asserts; the pending half of the same sentence must not supply that fact.
  const missingRemote = tools(async () => ({ ...mixedStage(), remoteTaskId: undefined }));
  const missingGroup = tools(async () => ({ ...mixedStage(), chatId: undefined }));
  for (const [text, available] of [
    ["飞书任务已创建，正在创建专属群。", missingRemote],
    ["专属群已建立，正在创建飞书任务。", missingGroup],
  ] as const)
    await assert.rejects(
      run([call("task_get", "read"), response(text), response(text)], available),
      modelFailure,
    );
});

test("Issue 3: a read-only snapshot supports resource existence plus started processes", async () => {
  const result = await run(
    [call("task_get", "read"), response(stageReply)],
    tools(async () => mixedStage(true, true, false)),
  );
  assert.equal(result.text, stageReply);
  assert.equal(result.toolCalls, 1, "accurate mixed-stage text must not trigger recovery");
  assert.equal(result.toolEvidence?.provisioning?.tasks[0]?.participants[0]?.started, true);
  assert.equal(result.toolEvidence?.provisioning?.tasks[0]?.participants[0]?.sent, false);
});

test("Issue 3 negative: a stopped process cannot support a started-process reply", async () => {
  await assert.rejects(
    run(
      [call("task_get", "read"), response(stageReply), response(stageReply)],
      tools(async () => mixedStage(false, false, false)),
    ),
    modelFailure,
  );
});

test("Issue 3 negative: one unstarted participant cannot be covered by the other", async () => {
  await assert.rejects(
    run(
      [call("task_get", "read"), response(stageReply), response(stageReply)],
      tools(async () => mixedStage(true, false, false)),
    ),
    modelFailure,
  );
});

test("Issue 3 negative: started is process creation, not delivery or discussion", async () => {
  for (const text of [
    "飞书任务已创建，任务群已建立。Claude、Codex 执行环境均已启动，初始要求已投递。",
    "飞书任务已创建，任务群已建立。Claude、Codex 执行环境均已启动，要求已转交给双方。",
    "飞书任务已创建，任务群已建立。Claude、Codex 执行环境均已启动，讨论已开始。",
  ])
    await assert.rejects(
      run(
        [call("task_create", "create"), call("task_get", "read"), response(text), response(text)],
        tools(async () => mixedStage(true, true, false)),
      ),
      modelFailure,
    );
});

test("started support is clause-scoped and never generalizes every start assertion", () => {
  const evidence: ProvisionEvidence = { created: [taskId], tasks: [] };
  recordProvisionEvidence(evidence, "task_get", { taskId }, mixedStage(true, true, false));
  assert.equal(supportedStartedClaim("Claude、Codex 执行环境均已启动；", evidence), true);
  for (const clause of [
    "执行环境均已启动。",
    "我已启动 Claude、Codex 执行环境。",
    "我刚刚让 Claude、Codex 执行环境均已启动。",
    "Claude、Codex 已启动部署。",
    "Claude、Codex 执行环境将启动。",
    "已启动讨论。",
    "已启动初始要求投递。",
    "任务群已建立，Claude、Codex 执行环境均已启动；",
    "已创建并启动 Claude 和 Codex。",
    "要求已转交给 Claude 和 Codex。",
  ])
    assert.equal(supportedStartedClaim(clause, evidence), false, clause);
});

test("Issue 1: a rejected claim after a successful write reports an unknown, not not_executed, outcome", () => {
  const provisioning: ProvisionEvidence = { created: [], tasks: [] };
  recordProvisionEvidence(provisioning, "task_create", {}, { accepted: true, task: queued });
  const facts = {
    successful: 1,
    successfulWrites: 1,
    unknown: 0,
    notExecuted: 0,
    provisioning,
  };
  // The reply still fabricates a resource the snapshot does not contain, so it
  // must be rejected — but the confirmed local write means the outcome is
  // unknown, never "not executed" (which would invite a duplicate creation).
  const policy = evaluateClaimPolicy("飞书任务已创建，任务群已建立。", facts);
  assert.equal(policy.rejected, true);
  assert.equal(unsupportedProvisionClaim("飞书任务已创建，任务群已建立。", provisioning), true);
  const engine = new PiEngine(config, {
    streamFn: scripted([
      call("task_create", "create"),
      response("飞书任务已创建，任务群已建立。"),
      response("飞书任务已创建，任务群已建立。"),
    ]),
  });
  return assert.rejects(
    engine.run({
      actor,
      sessionId: actor.sessionId,
      prompt: "创建任务",
      systemPrompt: "Only orchestrate.",
      messages: [],
      tools: tools(),
    }),
    (error: unknown) => modelFailure(error) && (error as OperationError).outcome === "unknown",
  );
});
