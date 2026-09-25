import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DirectoryTrust } from "../../src/app/directory-trust.js";
import { OperationError } from "../../src/core/errors.js";
import { stableId } from "../../src/core/ids.js";
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

for (const aliasState of ["same_directory", "retargeted", "missing"] as const) {
  test(`startup scope verifies canonical directory aliases: ${aliasState}`, async () => {
    const h = await fixture();
    try {
      const target = join(h.directory, "bound-project");
      const other = join(h.directory, "unrelated-project");
      const alias = join(h.directory, "configured-alias");
      await mkdir(target);
      await mkdir(other);
      await symlink(target, alias, "dir");
      const canonical = await realpath(target);
      h.task.directories = [alias];
      h.app.tasks.records.save(h.task);
      const workspace = h.herdr.createWorkspace.bind(h.herdr);
      h.herdr.createWorkspace = async (cwd) => workspace(await realpath(cwd));
      const start = h.herdr.startAgent.bind(h.herdr);
      h.herdr.startAgent = async (...args) => {
        const agent = await start(...args);
        agent.cwd = canonical;
        h.herdr.agents.set(agent.paneId, agent);
        if (aliasState !== "same_directory") {
          await unlink(alias);
          if (aliasState === "retargeted") await symlink(other, alias, "dir");
        }
        return agent;
      };
      let confirms = 0;
      (h.herdr as HerdrPort).trustDirectory = async (ref, directory) => {
        assert.equal(directory, canonical);
        assert.equal(ref.cwd, canonical);
        const agent = h.herdr.agents.get(ref.paneId);
        assert.ok(agent);
        confirms++;
        agent.status = "idle";
        agent.stateSeq = "2";
      };
      chooseTrust(h);
      await h.app.tasks.reconcile(h.task.id);
      if (aliasState === "same_directory") {
        assert.equal(confirms, 1);
        assert.equal(h.platform.cards.length, 0);
        await h.app.tasks.reconcile(h.task.id);
        await h.app.tasks.reconcile(h.task.id);
        assert.equal(h.herdr.sends.length, 1);
        assert.equal(h.app.tasks.records.participants(h.task)[0]?.initialSent, true);
      } else {
        assert.equal(confirms, 0, "Changed or unresolvable authorization cannot reach terminal");
        assert.equal(h.herdr.sends.length, 0);
        assert.equal(h.platform.cards.length, 1);
      }
    } finally {
      await h.close();
    }
  });
}

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
    assert.equal(
      h.engine.calls.find((turn) => turn.sessionId.startsWith("directory-trust:"))?.requireToolCall,
      false,
      "ordinary menu must not force a confirmation tool",
    );
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

test("startup state change retries a rejected preflight at fresh guard, without replaying an attempted key", async () => {
  const h = await fixture();
  try {
    let calls = 0;
    let writes = 0;
    (h.herdr as HerdrPort).trustDirectory = async (ref) => {
      calls++;
      const agent = h.herdr.agents.get(ref.paneId);
      assert.ok(agent);
      if (calls === 1) {
        agent.stateSeq = "2";
        throw new OperationError("stale_guard", "启动状态已更新，未按键");
      }
      writes++;
      agent.status = "idle";
      agent.stateSeq = "3";
    };
    chooseTrust(h);
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(calls, 2);
    assert.equal(writes, 1);
    assert.equal(h.platform.cards.length, 0);
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.herdr.sends.length, 1);
    assert.equal(writes, 1);
  } finally {
    await h.close();
  }
});

test("a previous non-trust startup menu does not suppress pi at a later directory prompt", async () => {
  const h = await fixture();
  try {
    let calls = 0;
    (h.herdr as HerdrPort).trustDirectory = async (ref) => {
      calls++;
      if (calls === 1) throw new OperationError("directory_trust_required", "其他菜单不能自动确认");
      const agent = h.herdr.agents.get(ref.paneId);
      assert.ok(agent);
      agent.status = "idle";
      agent.stateSeq = "3";
    };
    chooseTrust(h);
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.platform.cards.length, 1);
    assert.equal(h.herdr.sends.length, 0);
    const participant = h.app.tasks.records.participants(h.task)[0];
    const agent = h.herdr.agents.get(participant?.execution?.paneId ?? "");
    assert.ok(agent);
    agent.stateSeq = "2"; // User handled the previous menu; a distinct trust prompt appears.
    await h.app.tasks.reconcile(h.task.id);
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(calls, 2);
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    await h.close();
  }
});

test("model transport failure can retry at the same screen after backoff", async () => {
  const h = await fixture();
  try {
    (h.herdr as HerdrPort).trustDirectory = async () => {
      assert.fail("failed model must not reach terminal");
    };
    h.engine.handler = async (turn) => {
      if (turn.sessionId.startsWith("directory-trust:")) throw new Error("temporary model outage");
      return { text: '{"notify":false}', messages: [] };
    };
    await h.app.tasks.reconcile(h.task.id);
    const [key, decision] =
      h.store.entries<Record<string, unknown>>("directory_trust_decisions")[0] ?? [];
    assert.ok(key && decision?.retryAt);
    h.store.set("directory_trust_decisions", key, {
      ...decision,
      retryAt: new Date(0).toISOString(),
    });
    let confirms = 0;
    (h.herdr as HerdrPort).trustDirectory = async (ref) => {
      confirms++;
      const agent = h.herdr.agents.get(ref.paneId);
      assert.ok(agent);
      agent.status = "idle";
    };
    chooseTrust(h);
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(confirms, 1);
  } finally {
    await h.close();
  }
});

for (const priorState of ["no_tool", "failed", "pending", "uncertain", "done"] as const) {
  test(`recognition upgrade re-evaluates unchanged screens only after no effect: ${priorState}`, async () => {
    const h = await fixture();
    try {
      await h.app.tasks.reconcile(h.task.id);
      const participant = h.app.tasks.records.participants(h.task)[0] as Participant;
      const ref = participant.execution;
      assert.ok(ref);
      const screen = await h.herdr.screen(ref);
      for (const [id] of h.store.entries("directory_trust_decisions"))
        h.store.delete("directory_trust_decisions", id);
      const oldDecision = stableId(participant.id, ref.paneId, screen.agent.stateSeq);
      h.store.set("directory_trust_decisions", oldDecision, {
        confirmed: priorState === "done",
        text: "旧识别版本已处理",
      });
      if (priorState !== "no_tool") {
        const id = `${participant.id}:directory-trust:${screen.agent.stateSeq}`;
        h.store.set("operations", id, {
          id,
          fingerprint: "old-version",
          state: priorState,
          ...(priorState === "failed"
            ? { error: { code: "directory_trust_required", message: "not executed" } }
            : {}),
        });
      }
      let confirms = 0;
      (h.herdr as HerdrPort).trustDirectory = async () => {
        confirms++;
      };
      chooseTrust(h);
      const restored = new DirectoryTrust(h.store, h.herdr, h.engine, logger, h.app.signal);
      const actor = {
        ownerId: "owner",
        chatId: "entry",
        sessionId: "s",
        taskId: h.task.id,
        messageId: "upgrade",
      };
      const canRetry = priorState === "no_tool" || priorState === "failed";
      assert.equal(await restored.handle(h.task, participant, screen, actor), canRetry);
      assert.equal(confirms, canRetry ? 1 : 0);
      assert.ok(h.store.get("directory_trust_decisions", oldDecision), "old evidence retained");
      assert.equal(await restored.handle(h.task, participant, screen, actor), false);
      assert.equal(confirms, canRetry ? 1 : 0, "no second key effect at same screen");
    } finally {
      await h.close();
    }
  });
}

test("pi receives strict native-menu and real-directory observations for clipped Codex startup", async () => {
  const h = await fixture();
  try {
    const raw = await readFile(
      new URL("../fixtures/native/codex-e38-directory-trust.txt", import.meta.url),
      "utf8",
    );
    const target = join(h.directory, "myrix-e38-project-b-with-long-name");
    await mkdir(target);
    h.task.directories = [target];
    h.app.tasks.records.save(h.task);
    const nativeScreen = raw.replace(
      "> You are in /Users/yueban/herder-agent-code/myrix-e38",
      `> You are in ${target.slice(0, 41)}`,
    );
    h.herdr.screen = async (ref) => ({
      agent: await h.herdr.get(ref.paneId),
      text: nativeScreen,
      question: nativeScreen,
      options: [],
    });
    let confirms = 0;
    (h.herdr as HerdrPort).trustDirectory = async (ref) => {
      confirms++;
      const agent = h.herdr.agents.get(ref.paneId);
      assert.ok(agent);
      agent.status = "idle";
    };
    h.engine.handler = async (turn) => {
      if (!turn.sessionId.startsWith("directory-trust:"))
        return { text: '{"notify":false}', messages: [] };
      const input = JSON.parse(turn.prompt);
      assert.deepEqual(input.startupTrust, {
        nativeMenuRecognized: true,
        directoryAuthorized: true,
        expectedDirectory: target,
        headingClipped: true,
        repositoryRootNotice: false,
        trustTargetDirectory: target,
      });
      assert.equal(input.authorizedWorktreeRoot, undefined);
      assert.equal(turn.requireToolCall, true);
      assert.match(turn.systemPrompt, /不要把截断标题推测成另一个目录/);
      await turn.tools[0]?.execute({}, turn.actor);
      return { text: "已确认", messages: [] };
    };
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(confirms, 1);
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.herdr.sends.length, 1);
  } finally {
    await h.close();
  }
});
