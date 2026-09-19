import assert from "node:assert/strict";
import test from "node:test";
import {
  type LifecycleEvidence,
  unsupportedLifecycleClaim,
} from "../../src/runtime/lifecycle-evidence.js";

function evidence(): LifecycleEvidence {
  return {
    task: {
      id: "task_lifecycle",
      status: "destroying",
      chatId: "group",
      groupDeleted: false,
      keepGroup: false,
      groupRetentionSource: "default",
      closeRequested: true,
    },
    participants: [
      { id: "p1", name: "实现者", kind: "claude", status: "gone", started: true },
      { id: "p2", name: "评审者", kind: "codex", status: "gone", started: true },
    ],
  };
}

for (const text of [
  "任务已完成收尾，任务群即将解散。",
  "任务已完成收尾但群尚未解散。",
  "已经全部处理完毕，群将在回复后解散。",
  "任务收尾已完成；群等待删除。",
  "任务群已解散。",
  "已关闭任务群。",
  "任务群解散了。",
  "Cleanup is completed. The group will be deleted shortly.",
  "The group has been dissolved.",
]) {
  test(`pending group cannot support cleanup completion: ${text}`, () => {
    assert.equal(unsupportedLifecycleClaim(text, evidence()), true);
  });
}

for (const text of [
  "任务已确认完成，执行器已关闭，任务群即将解散。",
  "任务完成状态已同步，尚未完成收尾。",
  "任务收尾尚未完成，群尚未解散。",
  "即将完成收尾；稍后会关闭任务群。",
  "任务群是否已解散？",
  "是否已完成收尾？",
  "Have the Claude sessions been closed?",
  "Cleanup is not completed. The group will be deleted shortly.",
  "The group has not been dissolved.",
]) {
  test(`pending, negative and question statements remain allowed: ${text}`, () => {
    assert.equal(unsupportedLifecycleClaim(text, evidence()), false);
  });
}

test("fully destroyed task, deleted group and gone participants support completion", () => {
  const facts = evidence();
  facts.task.status = "destroyed";
  facts.task.groupDeleted = true;
  assert.equal(
    unsupportedLifecycleClaim("收尾已完成，任务群已解散，Claude 和 Codex session 已关闭。", facts),
    false,
  );
});

test("a deleted group does not prove remaining execution resources closed", () => {
  const facts = evidence();
  facts.task.status = "destroyed";
  facts.task.groupDeleted = true;
  const codex = facts.participants[1];
  assert.ok(codex);
  codex.status = "done";
  assert.equal(unsupportedLifecycleClaim("已完成收尾。", facts), true);
  assert.equal(unsupportedLifecycleClaim("Claude 和 Codex 已关闭。", facts), true);
  assert.equal(unsupportedLifecycleClaim("Claude session 已关闭，Codex 等待关闭。", facts), false);
});

test("named execution closure requires the named participant's gone receipt", () => {
  const facts = evidence();
  const reviewer = facts.participants[1];
  assert.ok(reviewer);
  reviewer.kind = "claude";
  reviewer.status = "idle";
  assert.equal(unsupportedLifecycleClaim("参与者实现者已关闭。", facts), false);
  assert.equal(unsupportedLifecycleClaim("参与者 p1 已关闭。", facts), false);
  assert.equal(unsupportedLifecycleClaim("参与者 p2 已关闭。", facts), true);
  assert.equal(unsupportedLifecycleClaim("全部 Claude 已关闭，包括实现者。", facts), true);
});

test("finished turns and output do not claim the underlying execution session closed", () => {
  const facts = evidence();
  for (const participant of facts.participants) participant.status = "done";
  for (const text of [
    "Claude 本轮已结束。",
    "Codex 已结束发言。",
    "Codex 已完成输出。",
    "Claude 和 Codex 已结束本轮讨论。",
    "Codex 已结束。",
  ]) {
    assert.equal(unsupportedLifecycleClaim(text, facts), false, text);
  }
  for (const text of ["Codex session 已结束。", "Claude 会话已结束。", "Codex 进程已退出。"]) {
    assert.equal(unsupportedLifecycleClaim(text, facts), true, text);
  }
});

test("explicitly retained group permits completed cleanup but never group deletion claims", () => {
  const facts = evidence();
  facts.task.status = "destroyed";
  facts.task.keepGroup = true;
  facts.task.groupRetentionSource = "explicit";
  assert.equal(unsupportedLifecycleClaim("已完成收尾，按要求保留群。", facts), false);
  assert.equal(unsupportedLifecycleClaim("群已解散。", facts), true);
  facts.task.groupRetentionSource = "legacy";
  assert.equal(unsupportedLifecycleClaim("已完成收尾。", facts), true);
  facts.task.groupRetentionSource = "default";
  assert.equal(unsupportedLifecycleClaim("已完成收尾。", facts), true);
});

test("explicitly retained executions permit policy completion without claiming sessions closed", () => {
  const facts = evidence();
  facts.task.status = "completed";
  facts.task.closeRequested = false;
  facts.task.keepGroup = true;
  facts.task.groupRetentionSource = "explicit";
  for (const participant of facts.participants) participant.status = "idle";
  assert.equal(unsupportedLifecycleClaim("已完成收尾，按要求保留群和执行器。", facts), false);
  assert.equal(unsupportedLifecycleClaim("Claude 和 Codex 会话已关闭。", facts), true);
  assert.equal(unsupportedLifecycleClaim("群已解散。", facts), true);
  facts.task.closeRequested = true;
  assert.equal(unsupportedLifecycleClaim("已完成收尾。", facts), true);
});

test("an absent group permits explicitly retained executions only after completion", () => {
  const facts = evidence();
  delete facts.task.chatId;
  facts.task.status = "completed";
  facts.task.closeRequested = false;
  const participant = facts.participants[0];
  assert.ok(participant);
  participant.status = "working";
  assert.equal(unsupportedLifecycleClaim("已完成收尾，执行器按要求保留。", facts), false);
  facts.task.status = "running";
  assert.equal(unsupportedLifecycleClaim("已完成收尾。", facts), true);
});

test("completion sync, outstanding work or errors prevent blanket completion", () => {
  const base = evidence();
  base.task.status = "destroyed";
  base.task.groupDeleted = true;
  for (const pending of [
    { completionRequest: "complete" as const },
    { pending: "cleanup" },
    { syncError: "未确认" },
    { error: "关闭失败" },
  ]) {
    assert.equal(
      unsupportedLifecycleClaim("已完成收尾。", { ...base, task: { ...base.task, ...pending } }),
      true,
    );
  }
});

test("cleanup of an unprovisioned task does not claim nonexistent sessions were closed", () => {
  const facts = evidence();
  delete facts.task.chatId;
  facts.task.status = "destroyed";
  facts.participants = [
    { id: "p1", name: "未启动", kind: "codex", status: "pending", started: false },
  ];
  assert.equal(unsupportedLifecycleClaim("已完成收尾。", facts), false);
  assert.equal(unsupportedLifecycleClaim("Codex session 已关闭。", facts), true);
  assert.equal(unsupportedLifecycleClaim("群已解散。", facts), true);
});

test("trusted task title is data, not a cleanup-completion assertion", () => {
  const facts = evidence();
  const snapshot = { ...facts, task: { ...facts.task, title: "受控收尾通知验证" } };
  const probe =
    "任务“受控收尾通知验证”已完成。按照默认收尾策略，其任务群即将解散；任务记录、代码与历史内容会保留，不受影响。";
  assert.equal(unsupportedLifecycleClaim(probe, snapshot), false);
  assert.equal(
    unsupportedLifecycleClaim("任务“受控收尾通知验证”已完成收尾，任务群即将解散。", snapshot),
    true,
  );
});

test("quoted title isolation preserves actual assertions and negations after the title", () => {
  for (const [open, close] of [
    ["“", "”"],
    ["「", "」"],
    ["《", "》"],
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
  ]) {
    for (const title of ["收尾", "群已解散", "尚未完成收尾", "cleanup"]) {
      const facts = evidence();
      const snapshot = { ...facts, task: { ...facts.task, title } };
      const reference = `${open}${title}${close}`;
      assert.equal(unsupportedLifecycleClaim(`任务${reference}已完成。`, snapshot), false);
      assert.equal(unsupportedLifecycleClaim(`任务${reference}已完成收尾。`, snapshot), true);
      assert.equal(unsupportedLifecycleClaim(`任务${reference}尚未完成收尾。`, snapshot), false);
      assert.equal(unsupportedLifecycleClaim(`任务${reference}：群已解散。`, snapshot), true);
    }
  }
});

test("title isolation requires a matching quoted title instead of suppressing ordinary claims", () => {
  const facts = evidence();
  const snapshot = { ...facts, task: { ...facts.task, title: "收尾" } };
  assert.equal(unsupportedLifecycleClaim("任务已完成收尾。", snapshot), true);
  assert.equal(unsupportedLifecycleClaim("任务“别的收尾任务”已完成收尾。", snapshot), true);
  assert.equal(unsupportedLifecycleClaim("任务“收尾”已完成收尾。", facts), true);
});
