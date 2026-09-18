import assert from "node:assert/strict";
import { test } from "node:test";
import { DirectoryTrust } from "../../src/app/directory-trust.js";
import { OperationError } from "../../src/core/errors.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { AgentScreen, Participant, Task } from "../../src/core/types.js";
import { logger, setup } from "./helpers.js";

async function fixture() {
  const h = setup();
  const task = (await h.app.dispatch("task.create", {
    kind: "development",
    title: "启动信任验收",
    requirements: "专用目录内创建页面",
    participants: [{ kind: "codex" }],
  })) as Task;
  const start = h.herdr.startAgent.bind(h.herdr);
  h.herdr.startAgent = async (...args) => {
    const agent = await start(...args);
    agent.status = "blocked";
    h.herdr.agents.set(agent.paneId, agent);
    return agent;
  };
  h.herdr.screen = async (ref) => ({
    agent: await h.herdr.get(ref.paneId),
    text: "Native startup screen",
    question: "Native startup screen",
    options: [{ key: "1", label: "确认" }],
  });
  return { ...h, task };
}

function chooseTrust(h: Awaited<ReturnType<typeof fixture>>) {
  h.engine.handler = async (turn) => {
    if (turn.sessionId.startsWith("directory-trust:")) {
      assert.deepEqual(
        turn.tools.map((tool) => tool.name),
        ["directory_trust_confirm"],
      );
      await turn.tools[0]?.execute({}, turn.actor);
      return { text: "已核对并确认目录信任", messages: [] };
    }
    return { text: '{"notify":true,"text":"状态通知"}', messages: [] };
  };
}

test("pi confirms startup directory through scoped tool then normal provisioning sends once", async () => {
  const h = await fixture();
  try {
    let confirms = 0;
    (h.herdr as HerdrPort).trustDirectory = async (ref, directory) => {
      assert.equal(directory, h.directory);
      const agent = h.herdr.agents.get(ref.paneId);
      assert.ok(agent);
      agent.status = "idle";
      agent.stateSeq = "2";
      confirms++;
    };
    chooseTrust(h);
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(confirms, 1);
    assert.equal(h.herdr.sends.length, 0);
    assert.equal(h.platform.cards.length, 0);
    await h.app.tasks.reconcile(h.task.id);
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(confirms, 1);
    assert.equal(h.app.tasks.records.participants(h.task)[0]?.initialSent, true);
  } finally {
    await h.close();
  }
});

test("ordinary confirmation reaches group and requires user's guarded card choice", async () => {
  const h = await fixture();
  try {
    let answers = 0;
    let automatic = 0;
    (h.herdr as HerdrPort).trustDirectory = async () => {
      automatic++;
      throw new OperationError("not_directory_trust", "不是原生目录信任菜单");
    };
    h.herdr.answer = async () => {
      answers++;
    };
    chooseTrust(h); // Even a mistaken model decision cannot confirm an ordinary menu.
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(automatic, 1);
    assert.equal(answers, 0);
    assert.equal(h.herdr.sends.length, 0);
    assert.equal(h.platform.cards.length, 1);
    const card = h.platform.cards[0];
    assert.ok(card);
    assert.equal(
      card.chat,
      h.app.tasks.records.get({ ownerId: "owner", chatId: "entry" }, h.task.id).chatId,
    );
    await h.app.approvals.answer("owner", card.chat, card.key, "1");
    assert.equal(answers, 1);
  } finally {
    await h.close();
  }
});

test("unknown trust effect stays frozen after restart and changed state sequence", async () => {
  const h = await fixture();
  try {
    let writes = 0;
    (h.herdr as HerdrPort).trustDirectory = async () => {
      writes++;
      throw new OperationError("input_unconfirmed", "未知", "unknown");
    };
    chooseTrust(h);
    await h.app.tasks.reconcile(h.task.id);
    const participant = h.app.tasks.records.participants(h.task)[0] as Participant;
    const ref = participant.execution;
    assert.ok(ref);
    const agent = h.herdr.agents.get(ref.paneId);
    assert.ok(agent);
    agent.stateSeq = "99";
    const restored = new DirectoryTrust(h.store, h.herdr, h.engine, logger, h.app.signal);
    const screen = await h.herdr.screen(ref);
    assert.equal(
      await restored.handle(h.task, participant, screen, {
        ownerId: "owner",
        chatId: "entry",
        sessionId: "s",
        taskId: h.task.id,
        messageId: "retry",
      }),
      false,
    );
    assert.equal(writes, 1);
  } finally {
    await h.close();
  }
});

test("model text cannot count as confirmation; foreign directory never reaches terminal", async () => {
  const h = await fixture();
  try {
    let writes = 0;
    (h.herdr as HerdrPort).trustDirectory = async () => {
      writes++;
    };
    await h.app.tasks.reconcile(h.task.id); // Engine claims/answers text but invokes no tool.
    assert.equal(writes, 0);
    assert.equal(h.platform.cards.length, 1);
    const participant = h.app.tasks.records.participants(h.task)[0] as Participant;
    assert.ok(participant.execution);
    participant.execution.cwd = "/outside-task";
    h.store.set("participants", participant.id, participant);
    chooseTrust(h);
    const screen: AgentScreen = {
      ...(await h.herdr.screen(participant.execution)),
      agent: {
        ...(await h.herdr.get(participant.execution.paneId)),
        stateSeq: "new",
      },
    };
    const controller = new DirectoryTrust(h.store, h.herdr, h.engine, logger, h.app.signal);
    assert.equal(
      await controller.handle(h.task, participant, screen, {
        ownerId: "owner",
        chatId: "entry",
        sessionId: "s",
        taskId: h.task.id,
        messageId: "retry",
      }),
      false,
    );
    assert.equal(writes, 0);
  } finally {
    await h.close();
  }
});
