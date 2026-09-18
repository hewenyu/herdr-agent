import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session, Task } from "../../src/core/types.js";
import { deferred, setup } from "./helpers.js";

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
