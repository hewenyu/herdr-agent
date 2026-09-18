import assert from "node:assert/strict";
import test from "node:test";
import { applicationTools } from "../../src/app/tools.js";
import type { ActorContext } from "../../src/core/types.js";

test("pi task action preserves an omitted group policy and forwards explicit boolean choices", async () => {
  const calls: unknown[][] = [];
  const services = {
    tasks: {
      async action(...args: unknown[]) {
        calls.push(args);
        return { accepted: true };
      },
    },
  } as unknown as Parameters<typeof applicationTools>[0];
  const actor: ActorContext = {
    ownerId: "owner",
    chatId: "task-group",
    taskId: "task-bound",
    sessionId: "session-bound",
    messageId: "message",
  };
  const action = applicationTools(services, actor).find((tool) => tool.name === "task_action");
  assert.ok(action);
  for (const keepGroup of [undefined, true, false]) {
    await action.execute({ action: "complete", keepGroup }, actor);
    assert.deepEqual(calls.at(-1), [
      actor,
      "task-bound",
      "complete",
      { keepGroup, keepExecution: undefined },
    ]);
  }
  for (const keepGroup of ["true", "false", 1, null])
    await assert.rejects(action.execute({ action: "complete", keepGroup }, actor), {
      code: "input",
    });
  assert.equal(calls.length, 3, "invalid policy must not reach the mutation service");
  await action.execute({ action: "complete", keepGroup: true, keepExecution: true }, actor);
  assert.deepEqual(calls.at(-1), [
    actor,
    "task-bound",
    "complete",
    { keepGroup: true, keepExecution: true },
  ]);
  for (const keepExecution of ["true", "false", 1, null])
    await assert.rejects(action.execute({ action: "complete", keepExecution }, actor), {
      code: "input",
    });
  assert.equal(calls.length, 4, "invalid execution retention must not reach the mutation service");
});
