import assert from "node:assert/strict";
import test from "node:test";
import type { InboxRecord } from "../../src/app/inbox.js";
import type { ActorContext } from "../../src/core/types.js";
import { requestContext, requestHistory } from "../../src/tasks/user-request.js";
import { actor, discussion, setup } from "./helpers.js";

const who: ActorContext = { ...actor, source: "feishu", chatType: "private" };
function message(
  h: ReturnType<typeof setup>,
  id: string,
  text: string,
  state: "done" | "processing" = "done",
  sessionId = who.sessionId,
) {
  const bound = { ...who, messageId: id, sessionId };
  h.store.set<InboxRecord>("inbox", `message:${id}`, {
    id: `message:${id}`,
    type: "message",
    actor: bound,
    payload: {
      ...bound,
      source: "feishu",
      chatType: "private",
      text,
      eventId: `event-${id}`,
      mentionedBot: false,
    },
    lane: "owner",
    state,
    sequence: h.store.list("inbox").length + 1,
    createdAt: new Date().toISOString(),
  });
  return bound;
}

test("new workflow dispatch requirements come from user sources, not stale assistant permission policies", async () => {
  const h = setup();
  h.config.ai.enabled = true;
  try {
    message(h, "old", "旧项目只读，不修改文件");
    const raw = "创建小说阅读软件项目，请 Codex 和 Claude 讨论设计并保存文档，双方满意再通知我";
    message(h, who.messageId, raw, "processing");
    const supplied = "沿用 Bypass，普通审批不得自动批准；不执行验证";
    const task = await h.service.create(who, {
      ...discussion,
      orchestration: { mode: "workflow" },
      requirements: supplied,
    });
    assert.equal(task.requirements, raw);
    assert.deepEqual(task.requestContext, []);
    assert.equal(
      h.store.get<{ requirements: string }>("task_creation_summaries", task.id)?.requirements,
      supplied,
    );
    assert.equal(
      (
        await h.service.create(who, {
          ...discussion,
          orchestration: { mode: "workflow" },
          requirements: supplied,
        })
      ).id,
      task.id,
    );
  } finally {
    h.close();
  }
});

test("selected historical requests keep ingress chronology even when the model reverses IDs", () => {
  const h = setup();
  try {
    message(h, "first", "先讨论 EPUB 和 TXT");
    message(h, "second", "修订：本轮先只做 EPUB");
    assert.deepEqual(
      requestContext(h.store, who, ["second", "first"]).map((entry) => entry.messageId),
      ["first", "second"],
    );
  } finally {
    h.close();
  }
});

test("explicit same-session user references preserve multi-turn requirements without importing assistant summaries", async () => {
  const h = setup();
  h.config.ai.enabled = true;
  try {
    message(h, "earlier", "要支持 EPUB 和 TXT，先讨论不开发");
    message(h, "unrelated", "另一个会话的要求", "done", "elsewhere");
    message(h, who.messageId, "就按刚才的需求创建任务", "processing");
    const history = requestHistory(h.store, who);
    assert.deepEqual(
      history.map((entry) => entry.messageId),
      ["earlier"],
    );
    const task = await h.service.create(who, {
      ...discussion,
      orchestration: { mode: "workflow" },
      contextMessageIds: ["earlier"],
    });
    assert.equal(task.requestContext?.[0]?.text, "要支持 EPUB 和 TXT，先讨论不开发");
    assert.match(task.requirements, /EPUB 和 TXT/);
    assert.match(task.requirements, /就按刚才的需求/);
    for (const id of ["assistant-invented", "unrelated", who.messageId]) {
      await assert.rejects(
        h.service.create(
          { ...who, messageId: `bad-${id}` },
          {
            ...discussion,
            orchestration: { mode: "workflow" },
            contextMessageIds: [id],
          },
        ),
        { code: "request_source" },
      );
    }
  } finally {
    h.close();
  }
});
