import assert from "node:assert/strict";
import { test } from "node:test";
import { taskInput } from "../../src/app/validation.js";
import type { Task } from "../../src/core/types.js";
import {
  discussionParents,
  type TaskContextInput,
  taskContextFields,
} from "../../src/web/client/task-context.js";
import type { WebState } from "../../src/web/contracts.js";

function discussion(id: string, ownerId = "owner-a", kind: Task["kind"] = "discussion"): Task {
  return {
    id,
    ownerId,
    kind,
    title: `讨论 ${id}`,
    requirements: "旧要求不可替代本次指令",
    sessionId: "session",
    entryChatId: "entry",
    directories: [],
    directoryMode: "shared",
    bypass: false,
    status: "completed",
    participantIds: [],
    groupDeleted: false,
    createGroup: false,
    createRemoteTask: false,
    keepGroup: true,
    worktreeReady: false,
    discussion: {
      mode: "manual",
      maxRounds: 4,
      maxMinutes: 30,
      rounds: 0,
      nextParticipant: 0,
      paused: true,
    },
    result: "旧结论不能成为新授权",
    closeRequested: false,
    createdAt: "2026-09-18",
    updatedAt: "2026-09-18",
  };
}
function state(): WebState {
  return {
    activeOwnerId: "owner-a",
    catalog: {
      defaultProject: "existing",
      bypass: false,
      projects: [{ name: "existing", directories: ["/tmp/project"], agent: "codex" }],
    },
    tasks: [
      discussion("own-discussion"),
      discussion("foreign-discussion", "owner-b"),
      discussion("own-development", "owner-a", "development"),
    ],
  };
}
const input: TaskContextInput = {
  kind: "development",
  projectMode: "existing",
  existingProject: "",
  newProjectName: "",
  parentTaskId: "",
  requirements: "只实现明确选定的部分；不要自动发布。",
};

test("existing/default project ignores a stale new-project name and never requests a new directory", () => {
  assert.deepEqual(taskContextFields({ ...input, newProjectName: "accidental-new" }, state()), {
    project: "existing",
    requirements: input.requirements,
  });
  assert.throws(
    () => taskContextFields({ ...input, existingProject: "removed" }, state()),
    /已登记项目/,
  );
  assert.throws(
    () =>
      taskContextFields(input, { catalog: { projects: [], defaultProject: "", bypass: false } }),
    /已登记项目/,
  );
});

test("new project is explicit, trims its name, and rejects occupied or path-like names", () => {
  const request = {
    ...input,
    projectMode: "new",
    existingProject: "existing",
    newProjectName: "  比武页面_1  ",
  };
  assert.deepEqual(taskContextFields(request, state()), {
    requirements: input.requirements,
    project: "比武页面_1",
    newProject: true,
  });
  for (const name of ["", "../escape", "/tmp/project", "has space", "x".repeat(81)])
    assert.throws(
      () => taskContextFields({ ...request, newProjectName: name }, state()),
      /项目名称/,
    );
  assert.throws(
    () => taskContextFields({ ...request, newProjectName: "existing" }, state()),
    /同名项目/,
  );
});

test("projectless discussion discards stale project fields and cannot become projectless development", () => {
  const request = {
    ...input,
    kind: "discussion",
    projectMode: "none",
    existingProject: "existing",
    newProjectName: "stale",
  };
  assert.deepEqual(taskContextFields(request, state()), { requirements: input.requirements });
  for (const kind of ["development", "review", "test"])
    assert.throws(() => taskContextFields({ ...request, kind }, state()), /仅讨论任务/);
  assert.throws(
    () => taskContextFields({ ...request, projectMode: "unknown" }, state()),
    /项目方式/,
  );
});

test("discussion choices belong to the active owner and keep completed discussion history available", () => {
  const snapshot = state();
  assert.deepEqual(
    discussionParents(snapshot).map((task) => task.id),
    ["own-discussion"],
  );
  assert.deepEqual(
    discussionParents({ ...snapshot, activeOwnerId: "owner-b" }).map((task) => task.id),
    ["foreign-discussion"],
  );
  assert.deepEqual(discussionParents({ ...snapshot, activeOwnerId: undefined }), []);
});

test("linking a discussion still requires complete new requirements and never substitutes old instructions", () => {
  const request = {
    ...input,
    parentTaskId: "own-discussion",
    requirements: "  使用旧讨论背景。仅评审，不要开发。  ",
  };
  const result = taskContextFields(request, state());
  assert.deepEqual(result, {
    project: "existing",
    parentTaskId: "own-discussion",
    requirements: "使用旧讨论背景。仅评审，不要开发。",
  });
  assert.throws(
    () => taskContextFields({ ...request, requirements: " \n " }, state()),
    /本次完整要求/,
  );
});

test("foreign, nondiscussion and stale parent selections are rejected before dispatch", () => {
  for (const parentTaskId of ["foreign-discussion", "own-development", "removed"])
    assert.throws(() => taskContextFields({ ...input, parentTaskId }, state()), /关联讨论/);
  assert.throws(
    () =>
      taskContextFields(
        { ...input, parentTaskId: "own-discussion" },
        { ...state(), activeOwnerId: "owner-b" },
      ),
    /关联讨论/,
  );
});

test("new-project plus discussion form fields survive the actual task action parser", () => {
  const fields = taskContextFields(
    { ...input, projectMode: "new", newProjectName: "new-project", parentTaskId: "own-discussion" },
    state(),
  );
  const parsed = taskInput({
    ...fields,
    kind: "development",
    title: "新任务",
    participants: [{ kind: "codex" }],
    directoryMode: "shared",
    createGroup: false,
    createRemoteTask: false,
  });
  assert.equal(parsed.newProject, true);
  assert.equal(parsed.project, "new-project");
  assert.equal(parsed.parentTaskId, "own-discussion");
  assert.equal(parsed.requirements, input.requirements);
});
