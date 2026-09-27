import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../../src/app/application.js";
import type { InboxRecord } from "../../src/app/inbox.js";
import { OperationError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/types.js";
import type { IngressRoute } from "../../src/orchestration/ingress.js";
import { logger, message, setup } from "./helpers.js";

function enable(h: ReturnType<typeof setup>): void {
  assert.ok(h.config.jev);
  h.config.jev.apiKey = "fixture-key";
  h.config.jev.ingressEnabled = true;
}

function classifier(
  intent = "development",
  confidence = 1,
  inspect?: (body: Record<string, unknown>) => void,
): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    inspect?.(body);
    const ids = Object.keys(body.questions.action.criteria);
    const choice = ids.includes("other") ? intent : ids.find((id) => id !== "unknown");
    return Response.json({
      model: "jev-1.13.0",
      answers: {
        action: {
          type: "choice",
          choice,
          confidence,
          probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
        },
      },
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  };
}

test("opt-in high confidence creates one workflow task from verbatim authenticated text", async () => {
  const h = setup();
  const original = globalThis.fetch;
  let calls = 0;
  const text = "  请在 project 中新增导出功能；不要升级依赖，也不要部署。  ";
  try {
    enable(h);
    globalThis.fetch = classifier("development", 1, (body) => {
      calls++;
      assert.deepEqual(body.state, { message: text });
      assert.equal(JSON.stringify(body).includes(h.directory), false);
      assert.equal(JSON.stringify(body).includes("fixture-key"), false);
    });
    const incoming = message("jev-create", text);
    await h.app.handlers().message(incoming);
    await h.app.inbox.drain();
    const tasks = h.store.list<Task>("tasks");
    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.ok(task);
    assert.equal(task.requirements, text);
    assert.equal(task.userRequest?.text, text);
    assert.equal(task.userRequest?.source, "feishu");
    assert.equal(task.orchestration?.mode, "workflow");
    assert.equal(task.orchestration?.template, "development");
    assert.equal(task.project, "project");
    assert.deepEqual(
      h.app.tasks.records.participants(task).map((p) => [p.kind, p.role]),
      [
        ["codex", "implementer"],
        ["claude", "reviewer"],
      ],
    );
    assert.equal(h.engine.calls.length, 0);
    assert.equal(calls, 2);
    await h.app.handlers().message({ ...incoming, eventId: "duplicate-envelope" });
    await h.app.inbox.drain();
    assert.equal(h.store.list("tasks").length, 1);
    assert.equal(calls, 2);
    assert.equal(h.platform.texts.length, 1);
    const route = h.store.list<IngressRoute>("jev_ingress_routes")[0];
    assert.equal(route?.route, "created");
    assert.ok(route?.replyId);
    assert.equal(h.app.outbox.receipt(route.replyId)?.state, "delivered");
  } finally {
    globalThis.fetch = original;
    await h.close();
  }
});

test("configured key with ingress off makes no classification calls and retains ordinary pi", async () => {
  const h = setup();
  const original = globalThis.fetch;
  try {
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-key";
    globalThis.fetch = async () => {
      throw new Error("classification must remain off");
    };
    await h.app.handlers().message(message("disabled", "给 project 加导出功能"));
    await h.app.inbox.drain();
    assert.equal(h.engine.calls.length, 1);
    assert.equal(h.store.list("tasks").length, 0);
    assert.equal(h.store.list("jev_ingress_routes").length, 0);
  } finally {
    globalThis.fetch = original;
    await h.close();
  }
});

test("low confidence and complex-request other route return unchanged text to pi", async () => {
  for (const [intent, confidence] of [
    ["development", 0.2],
    ["other", 1],
  ] as const) {
    const h = setup();
    const original = globalThis.fetch;
    try {
      enable(h);
      globalThis.fetch = classifier(intent, confidence);
      const incoming = message("ambiguous", "安排三位 Claude，接着刚才的方案继续，另建一个项目。");
      await h.app.handlers().message(incoming);
      await h.app.inbox.drain();
      assert.equal(h.engine.calls.length, 1);
      assert.equal(h.engine.calls[0]?.prompt, incoming.text);
      assert.equal(h.store.list("tasks").length, 0);
      assert.equal(h.store.list<IngressRoute>("jev_ingress_routes")[0]?.route, "pi");
    } finally {
      globalThis.fetch = original;
      await h.close();
    }
  }
});

test("references, unsupported resources, groups, commands and unauthorized senders bypass classification", async () => {
  const h = setup();
  const original = globalThis.fetch;
  let calls = 0;
  try {
    enable(h);
    globalThis.fetch = async () => {
      calls++;
      throw new Error("unexpected classification");
    };
    for (const incoming of [
      { ...message("quote", "照这个做"), replyToMessageId: "previous" },
      { ...message("image", "处理图片"), unsupportedType: "image" },
      {
        ...message("group", "开始讨论", "unknown-group"),
        chatType: "group" as const,
        mentionedBot: true,
      },
      message("command", "/projects"),
      { ...message("forbidden", "创建项目"), ownerId: "unauthorized" },
      message("clear", "/clear"),
    ])
      await h.app.handlers().message(incoming);
    await h.app.inbox.drain();
    assert.equal(calls, 0);
    assert.equal(h.store.list("tasks").length, 0);
    assert.ok(h.platform.texts.some((entry) => entry.text === "CLEAR_NEW_SESSION_OK"));
  } finally {
    globalThis.fetch = original;
    await h.close();
  }
});

test("bugfix selection uses development task kind and explicit bugfix workflow template", async () => {
  const h = setup();
  const original = globalThis.fetch;
  try {
    enable(h);
    globalThis.fetch = classifier("bugfix");
    await h.app.handlers().message(message("bugfix", "修复 project 中点击保存会报错的问题"));
    await h.app.inbox.drain();
    const task = h.store.list<Task>("tasks")[0];
    assert.equal(task?.kind, "development");
    assert.equal(task?.orchestration?.template, "bugfix");
  } finally {
    globalThis.fetch = original;
    await h.close();
  }
});

for (const outcome of ["not_executed", "unknown"] as const)
  test(`ingress notification ${outcome} survives restart without creating a second task`, async () => {
    const h = setup();
    const original = globalThis.fetch;
    let restarted: Application | undefined;
    let attempts = 0;
    let classifications = 0;
    try {
      enable(h);
      globalThis.fetch = classifier("development", 1, () => {
        classifications++;
      });
      const sendText = h.platform.sendText.bind(h.platform);
      h.platform.sendText = async (chat = "", text = "", key = "") => {
        if (text.startsWith("任务已登记：")) {
          attempts++;
          if (attempts === 1)
            throw new OperationError("platform_unavailable", "notification failed", outcome);
        }
        return sendText(chat, text, key);
      };
      await h.app.handlers().message(message("recover-ingress", "请在 project 中新增按钮"));
      await h.app.inbox.drain();
      assert.equal(h.store.list("tasks").length, 1);
      const record = h.store.get<InboxRecord>("inbox", "message:recover-ingress");
      assert.ok(record);
      h.store.set("inbox", record.id, { ...record, nextAttemptAt: 0 });
      await h.app.shutdown();
      restarted = new Application({
        config: h.config,
        store: h.store,
        engine: h.engine,
        herdr: h.herdr,
        platform: h.platform,
        logger,
      });
      await restarted.inbox.drain();
      assert.equal(h.store.list("tasks").length, 1);
      assert.equal(classifications, 2);
      assert.equal(attempts, outcome === "not_executed" ? 2 : 1);
      assert.equal(
        h.platform.texts.filter((entry) => entry.text.startsWith("任务已登记：")).length,
        outcome === "not_executed" ? 1 : 0,
      );
    } finally {
      globalThis.fetch = original;
      await restarted?.shutdown();
      await h.close();
    }
  });
