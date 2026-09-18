import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/types.js";
import { setup } from "./helpers.js";

const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "create" };
const silent = { text: '{"notify":false,"text":""}', messages: [] };

async function readyTask() {
  const h = setup();
  h.engine.handler = async () => silent;
  const task = await h.app.tasks.create(actor, {
    kind: "discussion",
    title: "清理通知",
    requirements: "仅验证资源收尾",
    participants: [{ kind: "codex" }],
    keepGroup: false,
  });
  await h.app.tasks.reconcile(task.id);
  assert.equal(h.herdr.agents.size, 1);
  return { ...h, task: h.app.tasks.get(actor, task.id) };
}

function unavailable(h: Awaited<ReturnType<typeof readyTask>>, kind: string) {
  return h.store.get<{ outcome: { status: string; reason: string; errorCode: string } }>(
    kind === "before_close" ? "task_close_notice" : "task_group_delete_notice",
    h.task.id,
  )?.outcome;
}

for (const failure of ["model", "format"] as const) {
  test(`${failure} generation failure records unavailable and continues authorized cleanup once`, async () => {
    const h = await readyTask();
    const calls: string[] = [];
    const order: string[] = [];
    h.engine.handler = async (input) => {
      const kind = JSON.parse(input.prompt).event as string;
      calls.push(kind);
      order.push(kind);
      if (failure === "model") throw new OperationError("model_failed", "quota", "unknown");
      return { text: "not JSON", messages: [] };
    };
    const close = h.herdr.close.bind(h.herdr);
    h.herdr.close = async (ref) => {
      order.push("pane.close");
      await close(ref);
    };
    h.platform.deleteGroup = async () => {
      order.push("group.delete");
      h.platform.deletions++;
    };
    try {
      await h.app.tasks.action({ ...actor, messageId: "complete" }, h.task.id, "complete");
      await h.app.tasks.reconcile(h.task.id);
      await h.app.tasks.reconcile(h.task.id);
      assert.equal(h.app.tasks.get(actor, h.task.id).status, "destroyed");
      assert.equal(h.herdr.closes, 1);
      assert.equal(h.platform.deletions, 1);
      assert.deepEqual(calls, ["before_close", "before_group_delete"]);
      assert.deepEqual(order, [
        "before_close",
        "pane.close",
        "before_group_delete",
        "group.delete",
      ]);
      for (const kind of calls) {
        assert.deepEqual(unavailable(h, kind), {
          status: "unavailable",
          reason: "generation_failed",
          errorCode: failure === "model" ? "model_failed" : "internal_error",
        });
      }
      assert.equal(h.platform.texts.length, 0, "no fixed substitute notice is sent");
      assert.equal(h.store.list("outbox").length, 0);
      assert.equal(h.store.list("messages").length, 0, "unavailable is not recorded as visible");
    } finally {
      await h.close();
    }
  });
}

for (const failedKind of ["before_close", "before_group_delete"]) {
  test(`unknown ${failedKind} send is not downgraded to generation failure or replayed`, async () => {
    const h = await readyTask();
    let attempts = 0;
    h.engine.handler = async (input) =>
      JSON.parse(input.prompt).event === failedKind
        ? { text: '{"notify":true,"text":"收尾通知"}', messages: [] }
        : silent;
    h.platform.sendText = async () => {
      attempts++;
      throw new OperationError("delivery_uncertain", "lost response", "unknown");
    };
    try {
      await h.app.tasks.action({ ...actor, messageId: "close" }, h.task.id, "close");
      await h.app.tasks.reconcile(h.task.id);
      await h.app.tasks.reconcile(h.task.id);
      assert.equal(attempts, 1);
      assert.equal(h.herdr.closes, failedKind === "before_close" ? 0 : 1);
      assert.equal(h.platform.deletions, 0);
      assert.equal(h.app.tasks.get(actor, h.task.id).status, "destroying");
      assert.equal(unavailable(h, failedKind), undefined);
      assert.equal(h.store.list<{ state: string }>("outbox")[0]?.state, "uncertain");
      assert.equal(h.store.list("messages").length, 0);
    } finally {
      await h.close();
    }
  });
}

test("unavailable notices do not bypass pending inbound or existing outgoing delivery barriers", async () => {
  const h = await readyTask();
  const calls: string[] = [];
  h.engine.handler = async (input) => {
    calls.push(JSON.parse(input.prompt).event);
    throw new OperationError("model_failed", "quota", "unknown");
  };
  try {
    h.store.set("inbox", "accepted-turn", {
      payload: { chatId: h.task.chatId },
      state: "processing",
    });
    h.store.set("outbox", "existing-reply", { chatId: h.task.chatId, state: "uncertain" });
    await h.app.tasks.action({ ...actor, messageId: "complete" }, h.task.id, "complete");
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.herdr.closes, 1);
    assert.equal(h.platform.deletions, 0);
    assert.deepEqual(calls, ["before_close"]);
    h.store.set("inbox", "accepted-turn", { payload: { chatId: h.task.chatId }, state: "done" });
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.platform.deletions, 0);
    h.store.set("outbox", "existing-reply", { chatId: h.task.chatId, state: "delivered" });
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.platform.deletions, 1);
    assert.deepEqual(calls, ["before_close", "before_group_delete"]);
    assert.equal(h.herdr.closes, 1);
  } finally {
    await h.close();
  }
});

test("undelivered final native output blocks pane closure before notification generation", async () => {
  const h = await readyTask();
  let notices = 0;
  let attempts = 0;
  h.engine.handler = async () => {
    notices++;
    throw new OperationError("model_failed", "quota", "unknown");
  };
  h.platform.sendText = async () => {
    attempts++;
    throw new OperationError("delivery_uncertain", "lost output response", "unknown");
  };
  try {
    const participant = h.app.tasks.records.participants(h.task)[0];
    assert.ok(participant?.execution);
    h.herdr.finish(participant.execution.paneId, "最后的原生结果");
    await h.app.tasks.action({ ...actor, messageId: "complete" }, h.task.id, "complete");
    await h.app.tasks.reconcile(h.task.id);
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(notices, 0);
    assert.equal(attempts, 1);
    assert.equal(h.herdr.closes, 0);
    assert.equal(h.platform.deletions, 0);
    assert.equal(h.store.list("pending_outputs").length, 1);
    assert.equal(h.store.list<{ state: string }>("outbox")[0]?.state, "uncertain");
    assert.match(h.app.tasks.get(actor, h.task.id).result ?? "", /最后的原生结果/);
  } finally {
    await h.close();
  }
});

for (const keepExecution of [false, true]) {
  test(`notification outage preserves explicit keepGroup and keepExecution=${keepExecution}`, async () => {
    const h = await readyTask();
    h.engine.handler = async () => {
      throw new OperationError("model_failed", "quota", "unknown");
    };
    try {
      await h.app.tasks.action({ ...actor, messageId: "retain" }, h.task.id, "complete", {
        keepGroup: true,
        keepExecution,
      });
      await h.app.tasks.reconcile(h.task.id);
      const task = h.store.get<Task>("tasks", h.task.id);
      assert.equal(task?.status, keepExecution ? "completed" : "destroyed");
      assert.equal(h.herdr.closes, keepExecution ? 0 : 1);
      assert.equal(h.platform.deletions, 0);
      assert.equal(task?.groupDeleted, false);
      assert.equal(unavailable(h, "before_group_delete"), undefined);
    } finally {
      await h.close();
    }
  });
}

for (const kind of ["before_close", "before_group_delete"]) {
  for (const throws of [false, true]) {
    test(`abort during ${kind} generation does not continue cleanup (model throws=${throws})`, async () => {
      const h = await readyTask();
      h.engine.handler = async (input) => {
        if (JSON.parse(input.prompt).event !== kind) return silent;
        await h.app.shutdown();
        if (throws) throw new OperationError("model_failed", "aborted", "unknown");
        return { text: '{"notify":true,"text":"不得发送"}', messages: [] };
      };
      try {
        await h.app.tasks.action({ ...actor, messageId: "complete" }, h.task.id, "complete");
        await h.app.tasks.reconcile(h.task.id);
        assert.equal(h.herdr.closes, kind === "before_close" ? 0 : 1);
        assert.equal(h.platform.deletions, 0);
        assert.equal(h.platform.texts.length, 0);
        assert.equal(unavailable(h, kind), undefined);
      } finally {
        await h.close();
      }
    });
  }
}
