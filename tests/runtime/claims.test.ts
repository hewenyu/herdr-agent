import assert from "node:assert/strict";
import test from "node:test";
import { hasUnverifiedToolClaim, requiresWriteEvidence } from "../../src/runtime/claims.js";

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
  assert.equal(requiresWriteEvidence("任务已完成，群已关闭"), false);
  assert.equal(requiresWriteEvidence("当前任务状态是 review"), false);
});
