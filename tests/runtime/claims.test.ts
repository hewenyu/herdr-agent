import assert from "node:assert/strict";
import test from "node:test";
import { hasUnverifiedToolClaim, requiresWriteEvidence } from "../../src/runtime/claims.js";

test("business completion claims require a tool-backed response", () => {
  assert.equal(hasUnverifiedToolClaim("已创建任务 task_fake123"), true);
  assert.equal(hasUnverifiedToolClaim("正在启动 Codex 项目"), true);
  assert.equal(hasUnverifiedToolClaim("我想创建一个任务吗？"), false);
  assert.equal(hasUnverifiedToolClaim("任务是什么？"), false);
  assert.equal(hasUnverifiedToolClaim("你好，今天怎么样？"), false);
});

test("English completion claims are guarded while capability questions remain ordinary text", () => {
  assert.equal(hasUnverifiedToolClaim("Created project demo and started Codex"), true);
  assert.equal(hasUnverifiedToolClaim("The task is completed and the group is closed"), true);
  assert.equal(hasUnverifiedToolClaim("Task creation succeeded"), true);
  assert.equal(hasUnverifiedToolClaim("The task was not created"), false);
  assert.equal(hasUnverifiedToolClaim("Can you create a project?"), false);
  assert.equal(hasUnverifiedToolClaim("是否已创建任务？"), false);
});

test("Chinese failure and negation statements are not completion claims", () => {
  for (const text of ["任务未创建", "创建失败", "无法创建项目", "没有成功创建任务", "创建不成功"]) {
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
