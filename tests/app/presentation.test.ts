import assert from "node:assert/strict";
import { test } from "node:test";
import { Approvals } from "../../src/app/approvals.js";
import { presentScreen } from "../../src/app/presentation.js";
import type { AgentScreen, Task } from "../../src/core/types.js";
import { setup } from "./helpers.js";

test("screen presentation keeps final lines, terminal columns and grapheme boundaries", () => {
  assert.equal(
    presentScreen("first\n\u001b[31m中文AB\u001b[0m\ne\u0301👨‍👩‍👧‍👦xy\n", {
      maxCols: 4,
      tailLines: 2,
    }),
    "中文\né👨‍👩‍👧‍👦x\n[现场显示已裁剪：最多 4 列、末尾 2 行]",
  );
  assert.equal(presentScreen("a\tb", { maxCols: 9, tailLines: 2 }), "a       b");
  assert.equal(
    presentScreen("\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007", {
      maxCols: 4,
      tailLines: 1,
    }),
    "link",
  );
});

test("cropping an approval leaves identity, options and write Guard intact", async () => {
  const h = setup(false);
  try {
    const ref = {
      workspaceId: "workspace",
      paneId: "pane",
      kind: "codex" as const,
      cwd: h.directory,
      sessionId: "session",
    };
    const screen: AgentScreen = {
      agent: {
        ...ref,
        status: "blocked",
        stateSeq: "999999999999999999",
        interactiveReady: true,
        launchPending: false,
      },
      text: "full screen must remain intact",
      question: "标题\n完整审批选项ABCDEFG",
      options: [{ key: "1", label: "完整批准选项" }],
    };
    const original = structuredClone(screen);
    const approvals = new Approvals(h.store, h.herdr, () => h.platform, {
      maxCols: 4,
      tailLines: 1,
    });
    let guard: unknown;
    h.herdr.answer = async (...args: unknown[]) => {
      guard = args[2];
    };
    const approval = await approvals.publish("owner", "chat", ref, screen);
    const card = h.platform.cards[0]?.card as {
      body: { elements: { content?: string; text?: { content: string } }[] };
    };
    assert.match(card.body.elements[0]?.content ?? "", /^完整\n\[现场显示已裁剪/);
    assert.equal(card.body.elements[1]?.text?.content, "完整批准选项");
    assert.deepEqual(screen, original);
    await approvals.answer("owner", "chat", approval.nonce, "1");
    assert.equal((guard as { stateSeq: string }).stateSeq, original.agent.stateSeq);
    assert.equal((guard as { sessionId: string }).sessionId, original.agent.sessionId);
  } finally {
    await h.close();
  }
});

test("cooldown coalesces progress to the latest state without delaying approvals, outputs or close", async () => {
  const h = setup(false);
  try {
    h.config.ui.notifyCooldownMs = 60_000;
    const task = (await h.app.dispatch("task.create", {
      kind: "discussion",
      title: "通知节流",
      requirements: "讨论",
      participants: [{ kind: "codex" }],
      createGroup: true,
      createRemoteTask: false,
    })) as Task;
    await h.app.tasks.reconcile(task.id);
    const participant = h.app.tasks.records.participants(task)[0];
    assert.ok(participant?.execution);
    const agent = h.herdr.agents.get(participant.execution.paneId);
    assert.ok(agent);
    assert.ok(h.platform.texts.some((item) => item.text === "通知节流：running"));
    agent.status = "idle";
    agent.stateSeq = "2";
    await h.app.tasks.reconcile(task.id);
    assert.ok(!h.platform.texts.some((item) => item.text === "通知节流：review"));
    agent.status = "blocked";
    agent.stateSeq = "3";
    await h.app.tasks.reconcile(task.id);
    assert.equal(h.platform.cards.length, 1, "blocked approvals bypass the progress cooldown");
    assert.ok(!h.platform.texts.some((item) => item.text === "通知节流：blocked"));
    h.store.set("notice_progress_last", task.id, { at: Date.now() - 60_001 });
    await h.app.tasks.reconcile(task.id);
    assert.ok(h.platform.texts.some((item) => item.text === "通知节流：blocked"));
    assert.ok(
      !h.platform.texts.some((item) => item.text === "通知节流：review"),
      "superseded progress is not replayed",
    );
    assert.equal(h.platform.cards.length, 1);
    h.herdr.finish(agent.paneId, "最终参与者结果不受冷却影响");
    await h.app.tasks.reconcile(task.id);
    assert.ok(h.platform.texts.some((item) => item.text.includes("最终参与者结果不受冷却影响")));
    await h.app.dispatch("task.action", { id: task.id, action: "close" });
    await h.app.tasks.reconcile(task.id);
    assert.ok(h.platform.texts.some((item) => item.text.includes("正在关闭执行资源")));
  } finally {
    await h.close();
  }
});

test("task session display uses title only while its persisted name is still the generated default", async () => {
  const h = setup(false, false);
  try {
    const task = (await h.app.dispatch("task.create", {
      kind: "discussion",
      title: "可读标题",
      requirements: "讨论",
      participants: [{ kind: "codex" }],
      createGroup: false,
      createRemoteTask: false,
    })) as Task;
    const session = h.app.sessions.forTask("owner", task.id);
    const sessions = () => h.app.snapshot().sessions as { id: string; name: string }[];
    assert.equal(sessions().find((item) => item.id === session.id)?.name, task.title);
    h.app.sessions.rename("owner", session.id, "用户自定义名称");
    assert.equal(sessions().find((item) => item.id === session.id)?.name, "用户自定义名称");
  } finally {
    await h.close();
  }
});
