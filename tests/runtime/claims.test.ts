import assert from "node:assert/strict";
import test from "node:test";
import {
  hasUnverifiedToolClaim,
  requiresToolForRequest,
  requiresWriteEvidence,
} from "../../src/runtime/claims.js";

test("business completion claims require a tool-backed response", () => {
  assert.equal(hasUnverifiedToolClaim("已创建任务 task_fake123"), true);
  assert.equal(hasUnverifiedToolClaim("正在启动 Codex 项目"), true);
  for (const text of [
    "我会创建一个新项目并拉群",
    "我将安排任务",
    "我来建群",
    "我马上启动 Codex",
    "我马上会创建任务",
    "接下来启动 Codex 项目",
    "我帮你创建任务",
    "我会帮你创建项目",
    "我们会创建项目",
  ]) {
    assert.equal(hasUnverifiedToolClaim(text), true, text);
  }
  assert.equal(hasUnverifiedToolClaim("我想创建一个任务吗？"), false);
  assert.equal(hasUnverifiedToolClaim("任务是什么？"), false);
  assert.equal(hasUnverifiedToolClaim("你好，今天怎么样？"), false);
  assert.equal(hasUnverifiedToolClaim("我会告诉你如何创建项目"), false);
});

test("English completion claims are guarded while capability questions remain ordinary text", () => {
  assert.equal(hasUnverifiedToolClaim("Created project demo and started Codex"), true);
  assert.equal(hasUnverifiedToolClaim("The task is completed and the group is closed"), true);
  assert.equal(hasUnverifiedToolClaim("Task creation succeeded"), true);
  for (const text of [
    "I will create a project",
    "I'll schedule a task",
    "I'm going to start Codex",
    "I will help you create a group",
    "We will create a project",
  ]) {
    assert.equal(hasUnverifiedToolClaim(text), true, text);
  }
  assert.equal(hasUnverifiedToolClaim("The task was not created"), false);
  assert.equal(hasUnverifiedToolClaim("I will not create a project"), false);
  assert.equal(hasUnverifiedToolClaim("I'll explain how to create a project"), false);
  assert.equal(hasUnverifiedToolClaim("Can you create a project?"), false);
  assert.equal(hasUnverifiedToolClaim("是否已创建任务？"), false);
});

test("Chinese failure and negation statements are not completion claims", () => {
  for (const text of ["任务未创建", "创建失败", "无法创建项目", "没有成功创建任务", "创建不成功"]) {
    assert.equal(hasUnverifiedToolClaim(text), false, text);
  }
  for (const text of ["我不会创建项目", "我不来安排任务", "我不帮你拉群"]) {
    assert.equal(hasUnverifiedToolClaim(text), false, text);
  }
  assert.equal(hasUnverifiedToolClaim("任务已创建"), true);
  assert.equal(hasUnverifiedToolClaim("创建失败，但任务已登记"), true);
});

test("action claims require a write fact even when a read-only lookup ran", () => {
  assert.equal(requiresWriteEvidence("task created after lookup"), true);
  assert.equal(requiresWriteEvidence("已创建任务 task-1"), true);
  assert.equal(requiresWriteEvidence("我会拉群并创建任务"), true);
  assert.equal(requiresWriteEvidence("I will create a project"), true);
  assert.equal(requiresWriteEvidence("任务已完成，群已关闭"), false);
  assert.equal(requiresWriteEvidence("当前任务状态是 review"), false);
});

test("explicit business requests require a tool attempt even when the reply makes no claim", () => {
  for (const text of [
    "创建一个新项目并拉群",
    "请帮我查询当前任务",
    "我想安排 Claude 和 Codex 讨论",
    "看看有哪些未完成任务",
    "create a project and start Codex",
    "please list my active tasks",
    "让 Claude 和 Codex 讨论这个需求",
    "用 Codex 开始实现这个项目",
    "把这个需求交给 Codex",
    "开个讨论任务，让 Claude 帮我梳理这个需求",
    "拉个群，让 Claude 和 Codex 一起讨论",
    "让 Claude 参与讨论",
    "请 Claude 解释这个需求",
    "先停一下，保留讨论，稍后继续",
    "继续这个讨论任务",
    "先暂停这个讨论",
    "继续当前讨论",
    "开发这个项目",
    "执行这个项目的任务",
    "帮我实现这个项目",
    "Please implement this project",
    "不要建群，先查询任务",
    "别启动 Claude，不过请查看项目",
    "Ask Codex to implement this project",
    "Have Claude and Codex discuss this requirement",
    "Delegate the review to Claude",
    "Don't create a task, but list the projects",
    "请解释创建任务的流程，然后创建一个任务",
    "请解释创建任务的流程，帮我创建一个任务",
    "请解释创建任务的流程。让 Claude 参与讨论",
    "Claude 可以参与讨论吗？现在让 Claude 参与讨论",
    "任务未完成，先查询任务状态",
    "查询未完成任务",
  ]) {
    assert.equal(requiresToolForRequest(text), true, text);
  }
  for (const text of [
    "你好，今天怎么样？",
    "请告诉我如何创建项目",
    "我想知道如何创建项目",
    "帮我解释如何创建项目",
    "怎么查询任务？",
    "能否创建一个项目？",
    "I will explain how to create a project",
    "What is a task?",
    "不要让 Claude 和 Codex 讨论这个需求",
    "先不要创建任务",
    "禁止用 Codex 执行项目",
    "我不需要创建项目",
    "只是讨论如何让 Claude 开始开发项目",
    "请解释让 Claude 和 Codex 讨论需求的流程",
    "只解释如何让 Claude 和 Codex 参与讨论，不要执行。",
    "怎么让 Claude 参与讨论？",
    "能否让 Claude 创建任务？",
    "我想知道如何让 Codex 实现项目",
    "他说让 Claude 和 Codex 讨论这个需求",
    "用户说：用 Codex 开始实现这个项目",
    "举个例子：“让 Claude 创建任务”",
    "日志显示任务创建失败",
    "这个项目开发得很好",
    "Don't ask Codex to implement the project",
    "Can you ask Claude to create a project?",
    "Explain how to ask Codex to start the project",
    "She said to let Claude create a task",
    'Example: "Create a project and start Codex"',
    "请解释创建任务的流程，第一步创建项目，第二步让 Claude 参与讨论。",
    "请解释创建任务的流程：先创建项目，让 Claude 参与讨论。",
    "任务未完成。",
    "任务尚未创建。",
    "Claude 可以参与讨论吗？",
    "可以让 Claude 参与讨论吗？",
  ]) {
    assert.equal(requiresToolForRequest(text), false, text);
  }
});
