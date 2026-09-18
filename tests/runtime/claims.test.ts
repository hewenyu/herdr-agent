import assert from "node:assert/strict";
import test from "node:test";
import { hasUnverifiedToolClaim } from "../../src/runtime/claims.js";

test("business completion claims require a tool-backed response", () => {
  assert.equal(hasUnverifiedToolClaim("已创建任务 task_fake123"), true);
  assert.equal(hasUnverifiedToolClaim("正在启动 Codex 项目"), true);
  assert.equal(hasUnverifiedToolClaim("我想创建一个任务吗？"), false);
  assert.equal(hasUnverifiedToolClaim("任务是什么？"), false);
  assert.equal(hasUnverifiedToolClaim("你好，今天怎么样？"), false);
});
