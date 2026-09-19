import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { canonical, stableId } from "../../src/core/ids.js";
import type { Task } from "../../src/core/types.js";
import { actor, discussion, setup } from "./helpers.js";

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

test("reconciling a blocked initial participant does not expose starting", async () => {
  const entered = deferred();
  const release = deferred();
  const h = setup();
  const originalGet = h.herdr.get.bind(h.herdr);
  let hold = false;
  h.herdr.get = async (paneId) => {
    const agent = await originalGet(paneId);
    if (hold && agent.status === "blocked") {
      entered.resolve();
      await release.promise;
    }
    return agent;
  };
  try {
    const task = await h.service.create(actor, {
      ...discussion,
      discussion: { mode: "manual", maxRounds: 1, maxMinutes: 30 },
      createGroup: false,
      createRemoteTask: false,
    });
    const first = task.participantIds[0];
    assert.ok(first);
    await h.service.tick();
    const participant = h.store.get<{ execution?: { paneId: string } }>("participants", first);
    const paneId = participant?.execution?.paneId;
    assert.ok(paneId);
    const agent = h.herdr.agents.get(paneId);
    assert.ok(agent);
    agent.status = "blocked";
    agent.stateSeq = "2";
    h.herdr.agents.set(paneId, agent);
    h.store.set("participants", first, {
      ...h.store.get<Record<string, unknown>>("participants", first),
      status: "blocked",
      initialSent: false,
    });
    const blockedTask = h.store.get<Task>("tasks", task.id);
    assert.ok(blockedTask);
    blockedTask.status = "blocked";
    h.store.set("tasks", task.id, blockedTask);
    assert.equal(h.service.get(actor, task.id).status, "blocked");

    hold = true;
    const running = h.service.tick();
    await within(entered.promise);
    assert.equal(h.store.get<Task>("tasks", task.id)?.status, "blocked");
    release.resolve();
    await running;
    assert.equal(h.service.get(actor, task.id).status, "blocked");
  } finally {
    release.resolve();
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

test("parallel pi sessions keep task identities isolated when request ids repeat", async () => {
  const h = setup();
  h.config.runtime.maxConcurrentTasks = 2;
  try {
    const projects = ["session-project-a", "session-project-b"];
    for (const name of projects) {
      const directory = join(h.directory, name);
      await mkdir(directory);
      await h.catalog.save({ name, directories: [directory], agent: "codex" });
    }
    const [first, second] = await Promise.all(
      projects.map((project, index) =>
        h.service.create(
          { ...actor, sessionId: `pi-session-${index + 1}`, messageId: "reused-request" },
          {
            kind: "development",
            project,
            title: project,
            requirements: `只修改项目 ${project}`,
            participants: [{ kind: "codex" }],
            createRemoteTask: false,
          },
        ),
      ),
    );
    if (!first || !second) throw new Error("parallel tasks were not created");
    assert.notEqual(first.id, second.id);
    assert.equal(first.sessionId, "pi-session-1");
    assert.equal(second.sessionId, "pi-session-2");
    await h.service.tick();
    assert.equal(h.herdr.starts, 2);
    assert.equal(
      h.service.get({ ...actor, sessionId: first.sessionId }, first.id).project,
      projects[0],
    );
    assert.equal(
      h.service.get({ ...actor, sessionId: second.sessionId }, second.id).project,
      projects[1],
    );
  } finally {
    h.close();
  }
});

test("parallel pi sessions do not serialize creation on a reused request id", async () => {
  const entered = deferred();
  const release = deferred();
  const h = setup();
  const originalCreate = h.catalog.create.bind(h.catalog);
  h.catalog.create = async (name, agent) => {
    if (name === "slow-registration") {
      entered.resolve();
      await release.promise;
    }
    return originalCreate(name, agent);
  };
  const input = {
    kind: "development" as const,
    project: "slow-registration",
    newProject: true,
    title: "slow registration",
    requirements: "跨 session 创建应独立推进",
    participants: [{ kind: "codex" as const }],
    createRemoteTask: false,
  };
  let firstPromise: Promise<Task> | undefined;
  let secondPromise: Promise<Task> | undefined;
  try {
    firstPromise = h.service.create(
      { ...actor, sessionId: "pi-session-slow", messageId: "reused-request" },
      input,
    );
    await within(entered.promise);
    secondPromise = h.service.create(
      { ...actor, sessionId: "pi-session-fast", messageId: "reused-request" },
      { ...input, kind: "discussion", project: undefined, newProject: false },
    );
    await within(secondPromise);
    release.resolve();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(second.sessionId, "pi-session-fast");
    assert.notEqual(first.id, second.id);
  } finally {
    release.resolve();
    if (firstPromise) await firstPromise;
    h.close();
  }
});

test("a pre-session task key remains idempotent for the same pi session after upgrade", async () => {
  const h = setup();
  const input = {
    kind: "development" as const,
    title: "legacy retry",
    requirements: "继续旧任务",
    participants: [{ kind: "codex" as const }],
    createRemoteTask: false,
  };
  const source = { ...actor, sessionId: "pi-session-legacy", messageId: "legacy-request" };
  try {
    const current = await h.service.create(source, input);
    const legacyId = `task_${stableId(source.ownerId, source.messageId, canonical(input))}`;
    const legacy = { ...current, id: legacyId };
    h.store.delete("tasks", current.id);
    h.store.set("tasks", legacyId, legacy);
    const retried = await h.service.create(source, input);
    assert.equal(retried.id, legacyId);
  } finally {
    h.close();
  }
});
