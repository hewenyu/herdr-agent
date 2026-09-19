import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session, Task } from "../../src/core/types.js";
import { deferred, Platform, setup } from "./helpers.js";

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("independent work did not progress")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("Application polls admit a new task and a Web conversation while another task notice is pending", async () => {
  const h = setup();
  h.config.runtime.maxConcurrentTasks = 2;
  const entered = deferred();
  const release = deferred();
  const newStarted = deferred();
  let slowId = "";
  let newId = "";
  h.engine.handler = async (input) => {
    if (input.sessionId.startsWith("notice:")) {
      const event = JSON.parse(input.prompt) as { event: string; task: Task };
      if (event.task.id === slowId && event.event === "group_ready") {
        entered.resolve();
        await release.promise;
      }
      return { text: '{"notify":false,"text":""}', messages: [] };
    }
    return { text: "独立调度会话已响应", messages: [] };
  };
  const unsubscribe = h.app.subscribe(() => {
    if (newId && h.store.get<Task>("tasks", newId)?.status === "running") newStarted.resolve();
  });
  const ticks: Promise<void>[] = [];
  const create = async (title: string) =>
    (await h.app.dispatch("task.create", {
      kind: "discussion",
      title,
      requirements: "隔离并发验证",
      participants: [{ kind: "codex" }],
      createRemoteTask: false,
    })) as Task;
  try {
    slowId = (await create("慢通知任务")).id;
    ticks.push(h.app.tick());
    await within(entered.promise);
    const session = (await h.app.dispatch("session.create", { name: "另一调度会话" })) as Session;
    const reply = await within(
      h.app.dispatch("chat.send", { sessionId: session.id, text: "查询本工具状态" }),
    );
    assert.ok(reply);
    newId = (await create("后来创建的任务")).id;
    ticks.push(h.app.tick());
    await within(newStarted.promise);
    assert.equal(h.store.get<Task>("tasks", slowId)?.status, "starting");
    assert.equal(h.herdr.starts, 1);
  } finally {
    release.resolve();
    await Promise.all(ticks);
    unsubscribe();
    await h.close();
  }
});

test("platform reconnect stops the old task scheduler before replacement", async () => {
  const h = setup();
  const task = (await h.app.dispatch("task.create", {
    kind: "discussion",
    title: "重连中的活动任务",
    requirements: "验证旧调度器停止",
    participants: [{ kind: "codex" }],
    createRemoteTask: false,
  })) as Task;
  const old = h.app.tasks;
  let stopped = 0;
  const stop = old.stop.bind(old);
  old.stop = () => {
    stopped++;
    stop();
  };
  try {
    await h.app.tick();
    const replacement = new Platform();
    h.app.attachPlatform(replacement);
    assert.equal(stopped, 1);
    assert.notEqual(h.app.tasks, old);
    assert.equal(h.app.platform, replacement);
    assert.equal(
      h.app.tasks.get(
        { ownerId: "owner", chatId: "entry", sessionId: "s", messageId: "reconnect" },
        task.id,
      ).id,
      task.id,
    );
  } finally {
    await h.close();
  }
});

test("platform reconnect aborts an in-flight old reconciliation before its next remote write", async () => {
  const h = setup();
  const task = (await h.app.dispatch("task.create", {
    kind: "development",
    title: "重连中的远端完成同步",
    requirements: "验证旧连接读请求返回后不会继续写完成状态",
    participants: [{ kind: "codex" }],
    createGroup: false,
    createRemoteTask: true,
  })) as Task;
  await h.app.tick();
  const persisted = h.store.get<Task>("tasks", task.id);
  assert.ok(persisted?.remoteTaskId);
  h.store.set("tasks", task.id, { ...persisted, completionRequest: "complete" });

  const old = h.app.tasks;
  const entered = deferred();
  const release = deferred();
  const get = h.platform.getTask.bind(h.platform);
  const update = h.platform.updateTask.bind(h.platform);
  let getCalls = 0;
  let updateCalls = 0;
  h.platform.getTask = async (id) => {
    getCalls++;
    entered.resolve();
    await release.promise;
    return get(id);
  };
  h.platform.updateTask = async (...args) => {
    updateCalls++;
    return update(...args);
  };

  try {
    const running = old.reconcile(task.id, { forceRemote: true });
    await within(entered.promise);
    const callsBeforeReconnect = getCalls;
    const replacement = new Platform();
    h.app.attachPlatform(replacement);
    release.resolve();
    await running;

    assert.equal(getCalls, callsBeforeReconnect);
    assert.equal(updateCalls, 0);
    assert.equal(replacement.updates, 0);
    assert.equal(h.store.get<Task>("tasks", task.id)?.status, persisted.status);
    assert.equal(h.store.get<Task>("tasks", task.id)?.completionRequest, "complete");
    assert.equal(h.app.platform, replacement);
  } finally {
    release.resolve();
    await h.close();
  }
});

test("Web pi sessions run independently while turns within one session remain serialized", async () => {
  const h = setup();
  const entered = deferred();
  const release = deferred();
  const turns: Promise<unknown>[] = [];
  h.engine.handler = async (input) => {
    if (input.prompt === "slow") {
      entered.resolve();
      await release.promise;
    }
    return { text: input.prompt, messages: [] };
  };
  try {
    const first = h.app.sessions.create("owner");
    const second = h.app.sessions.create("owner");
    turns.push(h.app.dispatch("chat.send", { sessionId: first.id, text: "slow" }));
    await within(entered.promise);
    turns.push(h.app.dispatch("chat.send", { sessionId: first.id, text: "same-session-next" }));
    await within(h.app.dispatch("chat.send", { sessionId: second.id, text: "fast" }));
    assert.deepEqual(
      h.engine.calls.map((call) => call.prompt),
      ["slow", "fast"],
    );
    release.resolve();
    await Promise.all(turns);
    assert.deepEqual(
      h.engine.calls.map((call) => call.prompt),
      ["slow", "fast", "same-session-next"],
    );
  } finally {
    release.resolve();
    await Promise.all(turns);
    await h.close();
  }
});
