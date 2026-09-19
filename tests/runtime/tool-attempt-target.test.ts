import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { PiEngine } from "../../src/runtime/engine.js";
import { config, response, scripted } from "./helpers.js";

type Scenario = {
  name: string;
  tool: string;
  failureCode?: string;
  failed: Record<string, unknown>;
  next: Record<string, unknown>;
};
const actor = { ownerId: "owner", chatId: "entry", sessionId: "session", messageId: "message" };
const claim = "请求的项目和会话操作已经完成。";
const call = (name: string, id: string, args: Record<string, unknown>) =>
  response("", [{ type: "toolCall", name, id, arguments: args }]);

async function attempt(scenario: Scenario) {
  let writes = 0;
  const engine = new PiEngine(config, {
    streamFn: scripted([
      call(scenario.tool, "failed", scenario.failed),
      call(scenario.tool, "next", scenario.next),
      response(claim),
      response(claim),
    ]),
  });
  const result = await engine.run({
    actor,
    sessionId: actor.sessionId,
    systemPrompt: "Only report supported tool facts.",
    prompt: "按要求处理项目和会话。",
    messages: [],
    tools: [
      {
        name: scenario.tool,
        description: scenario.tool,
        readOnly: false,
        parameters: { type: "object", additionalProperties: true },
        execute: async () => {
          if (++writes === 1)
            throw new OperationError(scenario.failureCode ?? "input", "目标或参数尚未满足要求。");
          return { accepted: true };
        },
      },
    ],
  });
  return { result, writes };
}

const differentTargets: Scenario[] = [
  ...["session_select", "session_rename", "session_archive", "session_restore"].map((tool) => ({
    name: tool,
    tool,
    failureCode: "session_missing",
    failed: { sessionId: "session_a", name: "New name" },
    next: { sessionId: "session_b", name: "New name" },
  })),
  ...["session_create", "project_create", "project_save", "project_remove"].map((tool) => ({
    name: tool,
    tool,
    failed: { name: "first" },
    next: { name: "second" },
  })),
  {
    name: "task creation in another project",
    tool: "task_create",
    failed: { project: "first", title: "Task" },
    next: { project: "second", title: "Task" },
  },
  {
    name: "task creation with another title",
    tool: "task_create",
    failed: { project: "project", title: "First" },
    next: { project: "project", title: "Second" },
  },
  {
    name: "another named participant",
    tool: "participant_add",
    failed: { taskId: "task", name: "first", kind: "codex" },
    next: { taskId: "task", name: "second", kind: "codex" },
  },
  {
    name: "another default participant kind",
    tool: "participant_add",
    failed: { taskId: "task", kind: "claude" },
    next: { taskId: "task", kind: "codex" },
  },
];
for (const scenario of differentTargets) {
  test(`${scenario.name}: another target's success cannot erase the first failure`, async () => {
    await assert.rejects(
      attempt(scenario),
      (error: unknown) =>
        error instanceof OperationError &&
        error.code === "model_failed" &&
        error.outcome === "not_executed",
    );
  });
}

const correctedPayloads: Scenario[] = [
  {
    name: "rename payload",
    tool: "session_rename",
    failed: { sessionId: "session_a", name: "" },
    next: { sessionId: "session_a", name: "Valid name" },
  },
  {
    name: "project directories",
    tool: "project_save",
    failed: { name: "project", directories: [] },
    next: { name: "project", directories: ["/valid"] },
  },
  {
    name: "task requirements",
    tool: "task_create",
    failed: { project: "project", title: "Task", requirements: "" },
    next: { project: "project", title: "Task", requirements: "Full requirement" },
  },
  {
    name: "participant role",
    tool: "participant_add",
    failed: { taskId: "task", kind: "codex", name: "Coder", role: "" },
    next: { taskId: "task", kind: "codex", name: "Coder", role: "Implementation" },
  },
];
for (const scenario of correctedPayloads) {
  test(`same target accepts a corrected ${scenario.name}`, async () => {
    const { result, writes } = await attempt(scenario);
    assert.equal(result.text, claim);
    assert.equal(writes, 2);
    assert.equal(result.toolEvidence?.notExecuted, 1, "original failure remains recorded");
    assert.equal(result.toolEvidence?.unresolvedNotExecuted, 0);
  });
}
