import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Task } from "../../src/core/types.js";
import { actor, setup } from "./helpers.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("independent task did not progress")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function projectTask(h: ReturnType<typeof setup>, name: string) {
  const directory = join(h.directory, name);
  await mkdir(directory);
  await h.catalog.save({ name, directories: [directory], agent: "codex" });
  return h.service.create(
    { ...actor, messageId: name, sessionId: `session-${name}` },
    {
      kind: "development",
      project: name,
      title: name,
      requirements: `仅修改项目 ${name}`,
      participants: [{ kind: "codex" }],
      createRemoteTask: false,
    },
  );
}

test("a slow provisioning notice does not hold the next batch behind an idle worker", async () => {
  const entered = deferred();
  const release = deferred();
  const lastStarted = deferred();
  let slowId = "";
  let lastId = "";
  const h = setup({
    notice: async (task, kind) => {
      if (task.id === slowId && kind === "welcome") {
        entered.resolve();
        await release.promise;
      }
    },
    changed: (task) => {
      if (task.id === lastId && task.status === "running") lastStarted.resolve();
    },
  });
  h.config.runtime.maxConcurrentTasks = 2;
  let running: Promise<void> | undefined;
  try {
    await projectTask(h, "project-a");
    await projectTask(h, "project-b");
    await projectTask(h, "project-c");
    const ordered = h.store.list<Task>("tasks");
    slowId = ordered[0]?.id ?? "";
    lastId = ordered[2]?.id ?? "";
    running = h.service.tick();
    await within(entered.promise);
    await within(lastStarted.promise);
    assert.equal(h.service.get(actor, slowId).status, "starting");
    assert.equal(h.service.get(actor, lastId).participants[0]?.initialSent, true);
  } finally {
    release.resolve();
    await running;
    h.close();
  }
});

test("later polls schedule newly created projects while a prior reconcile remains unfinished", async () => {
  const entered = deferred();
  const release = deferred();
  const newStarted = deferred();
  let slowId = "";
  let newId = "";
  let slowNotices = 0;
  const h = setup({
    notice: async (task, kind) => {
      if (task.id === slowId && kind === "welcome") {
        slowNotices++;
        entered.resolve();
        await release.promise;
      }
    },
    changed: (task) => {
      if (task.id === newId && task.status === "running") newStarted.resolve();
    },
  });
  h.config.runtime.maxConcurrentTasks = 2;
  const polls: Promise<void>[] = [];
  try {
    slowId = (await projectTask(h, "slow-project")).id;
    polls.push(h.service.tick());
    await within(entered.promise);
    newId = (await projectTask(h, "new-project")).id;
    polls.push(h.service.tick(), h.service.tick());
    await within(newStarted.promise);
    assert.equal(slowNotices, 1);
    assert.equal(h.service.get(actor, newId).participants[0]?.initialSent, true);
    assert.equal(h.herdr.starts, 1);
  } finally {
    release.resolve();
    await Promise.all(polls);
    h.close();
  }
});

test("overlapping polls respect the worker limit and reuse a released slot without duplicating tasks", async () => {
  const firstEntered = deferred();
  const secondEntered = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  const thirdStarted = deferred();
  let thirdId = "";
  const blocked: string[] = [];
  const h = setup({
    notice: async (task, kind) => {
      if (kind !== "welcome") return;
      if (!blocked.includes(task.id)) blocked.push(task.id);
      if (blocked[0] === task.id) {
        firstEntered.resolve();
        await releaseFirst.promise;
      } else if (blocked[1] === task.id) {
        secondEntered.resolve();
        await releaseSecond.promise;
      }
    },
    changed: (task) => {
      if (task.id === thirdId && task.status === "running") thirdStarted.resolve();
    },
  });
  h.config.runtime.maxConcurrentTasks = 2;
  const polls: Promise<void>[] = [];
  try {
    await projectTask(h, "first");
    await projectTask(h, "second");
    polls.push(h.service.tick());
    await within(Promise.all([firstEntered.promise, secondEntered.promise]));
    thirdId = (await projectTask(h, "third")).id;
    polls.push(h.service.tick(), h.service.tick());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.service.get(actor, thirdId).chatId, undefined);
    assert.equal(blocked.length, 2);
    releaseFirst.resolve();
    await within(thirdStarted.promise);
    assert.equal(h.service.get(actor, blocked[1] ?? "").status, "starting");
    assert.equal(h.platform.groups, 3);
    assert.equal(h.herdr.starts, 2);
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await Promise.all(polls);
    h.close();
  }
});
