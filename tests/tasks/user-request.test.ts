import assert from "node:assert/strict";
import { test } from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import { canonical, stableId } from "../../src/core/ids.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { ActorContext, Task, TaskCreateInput } from "../../src/core/types.js";
import { TaskService } from "../../src/tasks/service.js";
import { currentUserRequest } from "../../src/tasks/user-request.js";
import { actor, discussion, setup } from "./helpers.js";

const feishuActor: ActorContext = { ...actor, source: "feishu", chatType: "private" };
const original =
  "请读取主目录和附加目录各自的 input.txt，把两条原文按目录顺序写入主目录 brief.md，不改其他文件，不提交 Git。";
const rewritten = "在附加目录 brief.md 中写入主目录 input.txt 的原文";

function ingress(h: ReturnType<typeof setup>, who = feishuActor, text = original): InboxRecord {
  const record: InboxRecord = {
    id: `message:${who.messageId}`,
    type: "message",
    actor: who,
    payload: {
      source: "feishu",
      eventId: `event:${who.messageId}`,
      messageId: who.messageId,
      ownerId: who.ownerId,
      chatId: who.chatId,
      chatType: who.chatType ?? "private",
      text,
      mentionedBot: true,
    },
    lane: `${who.ownerId}:${who.chatId}`,
    state: "processing",
    sequence: 1,
    createdAt: new Date().toISOString(),
  };
  h.store.set("inbox", record.id, record);
  return record;
}

test("E38 conflicting pi rewrite retains exact ingress in task, native prompt, remote description and parent snapshot", async () => {
  const h = setup();
  try {
    ingress(h);
    const task = await h.service.create(feishuActor, {
      ...discussion,
      kind: "development",
      participants: [{ kind: "codex" }],
      requirements: rewritten,
      userRequest: { text: "模型伪造原文不能覆盖真实来源" },
    } as TaskCreateInput);
    assert.equal(task.userRequest?.text, original);
    assert.equal(task.userRequest?.messageId, actor.messageId);
    assert.equal(task.requirements, rewritten);
    await h.service.tick();
    const prompt = h.herdr.sends[0]?.text ?? "";
    assert.ok(prompt.includes(JSON.stringify(original)));
    assert.ok(prompt.includes(rewritten));
    assert.match(prompt, /硬约束优先于 pi 摘要/);
    const remote = [...h.platform.tasks.values()][0];
    assert.ok(remote?.description.includes(original));
    assert.ok(remote?.description.includes("pi 分派摘要"));
    assert.doesNotMatch(remote?.description ?? "", /内容已截断/);
    const childActor = { ...feishuActor, messageId: "child" };
    ingress(h, childActor, "继续已讨论任务，只实现 A");
    const child = await h.service.create(childActor, { ...discussion, parentTaskId: task.id });
    assert.deepEqual(child.parentContext?.userRequest, task.userRequest);
    task.userRequest.text = "后续变更不应影响子任务快照";
    h.store.set("tasks", task.id, task);
    assert.equal(h.service.get(childActor, child.id).parentContext?.userRequest?.text, original);
  } finally {
    h.close();
  }
});

test("long source remains complete in storage and native input while remote description marks truncation", async () => {
  const h = setup();
  try {
    const constraint = "末尾禁止项：禁止删除输入文件，不提交 Git，不自动完成任务。";
    const longOriginal = `${"项目背景🧭".repeat(800)}\n${constraint}`;
    ingress(h, feishuActor, longOriginal);
    const task = await h.service.create(feishuActor, {
      ...discussion,
      requirements: constraint,
    });
    await h.service.tick();
    assert.equal(h.store.get<Task>("tasks", task.id)?.userRequest?.text, longOriginal);
    assert.ok(h.herdr.sends[0]?.text.includes(JSON.stringify(longOriginal)));
    const remote = [...h.platform.tasks.values()][0];
    assert.ok(remote);
    assert.ok([...remote.description].length <= 2999);
    assert.ok(remote.description.includes("项目背景🧭"));
    assert.equal(remote.description.includes(constraint), false);
    assert.match(remote.description, /【内容已截断】此处展示不完整，可能省略要求或禁止项/);
    assert.match(remote.description, /完整用户原文请查看会话历史或本地任务记录。$/);
  } finally {
    h.close();
  }
});

test("source lookup binds every ingress identity, excludes unrelated messages and system relays", () => {
  const h = setup();
  try {
    const record = ingress(h);
    for (const patch of [
      { ownerId: "other" },
      { sessionId: "other-session" },
      { chatId: "other-chat" },
      { messageId: "other-message" },
      { taskId: "other-task" },
      { source: "system" as const },
      { chatType: "group" as const },
    ]) {
      assert.equal(currentUserRequest(h.store, { ...feishuActor, ...patch }), undefined);
    }
    assert.ok(currentUserRequest(h.store, feishuActor));
    h.store.set("inbox", record.id, { ...record, actor: undefined });
    assert.equal(currentUserRequest(h.store, feishuActor), undefined);
    h.store.set("inbox", record.id, {
      ...record,
      payload: { ...record.payload, ownerId: "other" },
    });
    assert.equal(currentUserRequest(h.store, feishuActor), undefined);
    h.store.set("inbox", record.id, { ...record, type: "action" });
    assert.equal(currentUserRequest(h.store, feishuActor), undefined);
  } finally {
    h.close();
  }
});

test("current source wraps direct followup, source mutation conflicts, automatic relay never reuses followup", async () => {
  const h = setup();
  try {
    ingress(h);
    const task = await h.service.create(feishuActor, discussion);
    await h.service.tick();
    h.herdr.finish("p1", "第一轮观点");
    await h.service.tick();
    const followup = { ...feishuActor, messageId: "followup" };
    ingress(h, followup, "只回复蓝色，不修改文件");
    await h.service.send(followup, task.id, task.participantIds[0], "只回复红色");
    assert.match(h.herdr.sends.at(-1)?.text ?? "", /只回复蓝色，不修改文件/);
    const sentCount = h.herdr.sends.length;
    await h.service.send(followup, task.id, task.participantIds[0], "只回复红色");
    assert.equal(h.herdr.sends.length, sentCount);
    ingress(h, followup, "更换同一消息正文");
    await assert.rejects(
      h.service.send(followup, task.id, task.participantIds[0], "只回复红色"),
      /同一操作标识对应不同参数/,
    );
    const current = h.store.get<Task>("tasks", task.id);
    assert.ok(current);
    current.discussion.paused = false;
    h.store.set("tasks", task.id, current);
    h.herdr.finish("p1", "本轮普通讨论数据");
    await h.service.tick();
    assert.match(h.herdr.sends.at(-1)?.text ?? "", /本轮普通讨论数据/);
    assert.doesNotMatch(h.herdr.sends.at(-1)?.text ?? "", /只回复蓝色|更换同一消息正文/);
  } finally {
    h.close();
  }
});

test("legacy source-free task and completed send remain idempotent after ingress becomes available", async () => {
  const h = setup();
  try {
    const task = await h.service.create(feishuActor, discussion);
    assert.equal(task.userRequest, undefined);
    assert.equal(Object.hasOwn(task, "userRequest"), false);
    assert.equal(Object.hasOwn(h.service.get(feishuActor, task.id), "userRequest"), false);
    const childActor = { ...feishuActor, messageId: "source-free-child" };
    const child = await h.service.create(childActor, { ...discussion, parentTaskId: task.id });
    assert.ok(child.parentContext);
    assert.equal(Object.hasOwn(child.parentContext, "userRequest"), false);
    assert.deepEqual(h.service.get(childActor, child.id).parentContext, child.parentContext);
    ingress(h);
    const retry = await h.service.create(feishuActor, discussion);
    assert.equal(retry.id, task.id);
    assert.equal(retry.userRequest, undefined);
    await h.service.tick();
    const participantId = task.participantIds[0];
    assert.ok(participantId);
    const who = { ...feishuActor, messageId: "old-send" };
    const text = "继续";
    const operationId = `${task.id}:send:${stableId(who.messageId, participantId, text)}`;
    h.store.set("operations", operationId, {
      id: operationId,
      fingerprint: stableId(canonical({ participant: participantId, text })),
      state: "done",
      result: h.herdr.delivery,
      updatedAt: new Date().toISOString(),
    });
    ingress(h, who, "旧回执已完成，不得重复投递");
    const count = h.herdr.sends.length;
    await h.service.send(who, task.id, participantId, text);
    assert.equal(h.herdr.sends.length, count);
  } finally {
    h.close();
  }
});

test("unknown initial followup with trusted source recovers from exact native readback without replay", async () => {
  const h = setup();
  try {
    ingress(h);
    const task = await h.service.create(feishuActor, discussion);
    await h.service.tick();
    const second = h.service.get(feishuActor, task.id).participants[1];
    assert.ok(second?.execution);
    assert.equal(second.initialSent, false);
    const who = { ...feishuActor, messageId: "first-arrangement" };
    ingress(h, who, "只列一个问题，不修改文件");
    h.herdr.delivery = { status: "unconfirmed", verified: false, acked: true, attempts: 1 };
    await assert.rejects(h.service.send(who, task.id, second.id, "列出三个问题"), /尚未确认到达/);
    const count = h.herdr.sends.length;
    const sent = h.herdr.sends.at(-1)?.text;
    assert.ok(sent);
    assert.match(sent, /只列一个问题，不修改文件/);
    (h.herdr as HerdrPort).initialInput = async () => sent;
    const restored = new TaskService(h.options);
    await restored.tick();
    assert.equal(restored.get(feishuActor, task.id).participants[1]?.initialSent, true);
    assert.equal(h.herdr.sends.length, count);
  } finally {
    h.close();
  }
});
