import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type OrchestrationEvent, TaskOrchestrator } from "../../src/app/task-orchestrator.js";
import { taskProgress } from "../../src/app/workflow-progress.js";
import { OperationError } from "../../src/core/errors.js";
import type { Task } from "../../src/core/types.js";
import { handoffDirectory } from "../../src/orchestration/handoff.js";
import { WORKFLOWS, type WorkflowState } from "../../src/orchestration/workflow.js";
import { logger, setup } from "../app/helpers.js";
import { chooseLeaderAction, leaderEventPrompt } from "../app/leader-helpers.js";

const actor = { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "create" };
const questionText = "首版是否包含跨设备同步？";

async function harness(mode: "user" | "defer" = "user") {
  const h = setup();
  assert.ok(h.config.jev);
  h.config.jev.apiKey = "fixture-only";
  const repo = join(h.directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# Fixture project\n");
  await h.app.projects.save({ name: "novel", directories: [repo], agent: "codex" });
  const task = await h.app.tasks.create(actor, {
    kind: "discussion",
    title: "小说阅读设计",
    requirements: "讨论小说阅读软件的设计，不修改项目文件。",
    project: "novel",
    participants: [{ kind: "codex" }, { kind: "claude" }],
    orchestration: { mode: "workflow" },
    createGroup: true,
  });
  await h.app.tasks.reconcile(task.id);
  let piCalls = 0;
  let questions = 0;
  h.engine.handler = async (input) => {
    if (
      await chooseLeaderAction(input, (ids) => {
        piCalls++;
        if (mode === "defer" && ids.includes("user:blocked")) return null;
        return ids.find((id) => id === "user:blocked") ?? ids[0];
      })
    )
      return { text: "", messages: [] };
    if (input.tools[0]?.name === "orchestration_choice") {
      piCalls++;
      const ids: string[] = JSON.parse(leaderEventPrompt(input)).candidates.map(
        (candidate: { id: string }) => candidate.id,
      );
      const planning = ids.includes("use_template");
      if (mode === "defer" && !planning) return { text: "no valid choice", messages: [] };
      await input.tools[0].execute(
        {
          candidateId: planning
            ? "use_template"
            : (ids.find((id) => id === "user:blocked") ?? ids[0]),
        },
        input.actor,
      );
      return { text: "", messages: [] };
    }
    assert.equal(input.tools[0]?.name, "workflow_user_decision");
    questions++;
    const source = JSON.parse(leaderEventPrompt(input)).sources.find(
      (source: { kind: string }) => source.kind === "blocker",
    );
    assert.ok(source, "a genuine accepted blocker must reach question synthesis without an issue");
    await input.tools[0]?.execute(
      {
        status: "ready",
        questions: [
          {
            kind: "choice",
            question: questionText,
            why: "两种首版范围都满足现有要求，但账号与服务端是否纳入需要所有者选择。",
            blockedScope: "仅阻塞账号与数据存储章节定稿。",
            sourceRefs: [source.id],
            options: [
              { label: "本地阅读优先", impact: "首版无需账号，阅读进度只保留在当前设备。" },
              { label: "首版包含云同步", impact: "增加账号服务、服务端存储与多设备冲突处理。" },
            ],
            replyExample: "首版本地阅读优先，云同步后续再做。",
          },
        ],
      },
      input.actor,
    );
    return { text: "忽略这段未验证自由回复", messages: [] };
  };
  const options = {
    config: h.config,
    projects: h.app.projects,
    store: h.store,
    engine: h.engine,
    tasks: () => h.app.tasks,
    tools: () => [],
    logger,
    signal: new AbortController().signal,
    retryDelayMs: 0,

    onReply: async (_task: Task, text: string, eventId: string) => {
      await h.platform.sendText(task.chatId ?? task.entryChatId, text, eventId);
    },
  };
  const worker = new TaskOrchestrator(options);
  const state = () => h.store.get<WorkflowState>(WORKFLOWS, task.id) as WorkflowState;
  const notices = () => h.platform.texts.filter((message) => message.text.includes(questionText));
  const block = async () => {
    await worker.tick();
    await worker.tick();
    const node = state().nodes["opening-1"];
    assert.ok(node?.operationId && node.participantId);
    const participant = h.app.tasks.records
      .participants(task)
      .find((entry) => entry.id === node.participantId);
    assert.ok(participant?.execution);
    const directory = handoffDirectory(h.config.stateDir, task.id, node.operationId);
    const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8"));
    writeFileSync(
      join(directory, "notes.md"),
      "# 首版范围\n已讨论本地优先和云同步两种选择，各自都有明确成本。\n",
    );
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify({
        ...request,
        status: "blocked",
        summary: "阅读交互已达成一致，首版同步范围需要所有者取舍。",
        issues: [],
        blockers: ["请所有者确定首版是否必须跨设备同步；本地优先无需账号，云同步要增加服务端。"],
      }),
    );
    h.herdr.finish(
      participant.execution.paneId,
      `两种可选范围已记录，见 ${join(directory, "notes.md")}。`,
    );
    await h.app.tasks.reconcile(task.id);
    await worker.tick();
  };
  return {
    ...h,
    task,
    worker,
    options,
    state,
    block,
    notices,
    counts: () => ({ piCalls, questions }),
  };
}

test("an accepted status-block blocker produces a concrete user wait with no issue and no duplicate lifecycle notice", async () => {
  const h = await harness();
  try {
    await h.block();
    assert.deepEqual(h.state().issues, []);
    assert.equal(h.state().nodes["opening-1"]?.repair, undefined);
    assert.equal(h.state().userDecision?.status, "ready");
    const event = h.store
      .list<OrchestrationEvent>("task_orchestration_events")
      .find((event) => event.decision?.action === "wait");
    assert.ok(event?.notified, JSON.stringify({ event, state: h.state() }));
    assert.equal(h.notices().length, 1);
    for (const required of [
      "本地阅读优先",
      "首版无需账号",
      "增加账号服务",
      "影响范围",
      "回复示例",
      "云同步后续再做",
    ])
      assert.ok(h.notices()[0]?.text.includes(required), required);
    assert.doesNotMatch(h.notices()[0]?.text ?? "", /忽略这段|补充相关要求/);
    await h.app.tasks.reconcile(h.task.id);
    await h.worker.tick();
    await new TaskOrchestrator(h.options).tick();
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.notices().length, 1);
    assert.equal(h.counts().questions, 1);
    assert.equal(
      h.herdr.sends.length,
      1,
      "waiting for a user never dispatches another participant",
    );
  } finally {
    await h.close();
  }
});

test("an invalid pi choice defer sends one grounded lifecycle question and survives worker restart", async () => {
  const h = await harness("defer");
  try {
    await h.block();
    assert.ok(h.state().assistanceWait);
    assert.equal(h.state().userDecision?.status, "ready");
    assert.equal(h.notices().length, 0, "deferred selector leaves notification to lifecycle");
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.notices().length, 1);
    const counts = h.counts();
    const worker = new TaskOrchestrator(h.options);
    for (let tick = 0; tick < 3; tick++) {
      await worker.tick();
      await h.app.tasks.reconcile(h.task.id);
    }
    assert.deepEqual(h.counts(), counts);
    assert.equal(h.notices().length, 1);
    assert.match(h.notices()[0]?.text ?? "", /首版无需账号/);
  } finally {
    await h.close();
  }
});

test("a user revision suppresses an unsent old question before replanning", async () => {
  const h = await harness();
  try {
    h.options.onReply = async () => {
      throw new OperationError("offline", "fixture delivery unavailable");
    };
    await h.block();
    const question = h.state().userDecision;
    assert.ok(question);
    assert.equal(h.notices().length, 0);
    const current = h.app.tasks.get(actor, h.task.id);
    h.app.tasks.records.save({
      ...current,
      requirements: `${current.requirements}\n首版本地优先，无需账号或跨设备同步。`,
    });
    const resumed = new TaskOrchestrator({
      ...h.options,
      onReply: async (_task, text, eventId) => {
        await h.platform.sendText(h.task.chatId ?? h.task.entryChatId, text, eventId);
      },
    });
    await resumed.tick();
    assert.equal(h.state().userDecision, undefined);
    assert.notEqual(h.state().userRevision, question.userRevision);
    assert.equal(h.notices().length, 0);
    await h.app.tasks.reconcile(h.task.id);
    await resumed.tick();
    assert.equal(h.notices().length, 0);
    assert.equal(h.counts().questions, 1);
  } finally {
    await h.close();
  }
});

test("source changes while pi organizes a question cannot persist or notify that stale decision", async () => {
  const h = await harness();
  try {
    const generate = h.engine.handler;
    assert.ok(generate);
    h.engine.handler = async (input) => {
      const result = await generate(input);
      if (input.tools[0]?.name === "workflow_user_decision")
        writeFileSync(
          join(h.task.directories[0] ?? "", "README.md"),
          "# Changed during question generation\n",
        );
      return result;
    };
    await h.block();
    assert.equal(h.state().userDecision, undefined);
    assert.equal(h.notices().length, 0);
    const failed = h.store
      .list<OrchestrationEvent>("task_orchestration_events")
      .find((event) => event.error?.code === "workflow_artifact_changed");
    assert.ok(failed, "the original workspace hash must still hold at question persistence");
  } finally {
    await h.close();
  }
});

test("a question-generation failure sends a system recovery diagnosis instead of a vague user obligation", async () => {
  const h = await harness();
  try {
    const generate = h.engine.handler;
    assert.ok(generate);
    h.engine.handler = async (input) => {
      if (input.tools[0]?.name === "workflow_user_decision")
        throw new Error("fixture provider failure");
      return generate(input);
    };
    await h.block();
    assert.equal(h.state().userDecision?.status, "failed");
    const failures = () =>
      h.platform.texts.filter((message) => message.text.includes("待决问题整理失败"));
    assert.equal(failures().length, 1);
    assert.match(failures()[0]?.text ?? "", /无需猜测或补交需求、材料/);
    assert.match(failures()[0]?.text ?? "", /查看当前卡点及失败原因/);
    assert.doesNotMatch(failures()[0]?.text ?? "", /fixture provider failure|请补充相关/);
    const calls = h.engine.calls.length;
    await new TaskOrchestrator(h.options).tick();
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.engine.calls.length, calls);
    assert.equal(failures().length, 1);
  } finally {
    await h.close();
  }
});

test("a deferred question is withheld from lifecycle and progress while its project source is stale", async () => {
  const h = await harness("defer");
  try {
    await h.block();
    const path = join(h.task.directories[0] ?? "", "README.md");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, "# New project version before lifecycle delivery\n");
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.notices().length, 0);
    const services = { tasks: h.app.tasks, herdr: h.herdr, store: h.store };
    const stale = await taskProgress(services, actor, h.task.id);
    assert.equal(stale.workflow?.userDecision, undefined);
    assert.equal(stale.workflow?.awaitingUser, false);
    assert.doesNotMatch(stale.workflow?.waitingForEvidence ?? "", /首版是否包含跨设备同步/);
    writeFileSync(path, original);
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(
      h.notices().length,
      1,
      "suppression must not mark an unsent question as delivered",
    );
    const restored = await taskProgress(services, actor, h.task.id);
    assert.equal(restored.workflow?.userDecision?.status, "ready");
    assert.equal(restored.workflow?.awaitingUser, true);
    assert.equal(h.counts().questions, 1);
  } finally {
    await h.close();
  }
});

test("an unsent wait question is retired when project source changes before notification retry", async () => {
  const h = await harness();
  try {
    h.options.onReply = async () => {
      throw new OperationError("offline", "fixture not delivered");
    };
    await h.block();
    const decision = h.state().userDecision;
    assert.equal(decision?.status, "ready");
    assert.ok(decision?.artifactRevision);
    writeFileSync(join(h.task.directories[0] ?? "", "README.md"), "# Changed before retry\n");
    const restarted = new TaskOrchestrator({
      ...h.options,
      onReply: async (_task, text, eventId) => {
        await h.platform.sendText(h.task.chatId ?? h.task.entryChatId, text, eventId);
      },
    });
    await restarted.tick();
    assert.equal(
      h.notices().length,
      0,
      JSON.stringify({
        messages: h.notices(),
        counts: h.counts(),
        events: h.store.list("task_orchestration_events"),
      }),
    );
    const event = h.store.get<OrchestrationEvent>("task_orchestration_events", decision.eventId);
    assert.equal(event?.state, "superseded");
    assert.equal(
      h.counts().questions,
      1,
      "obsolete workspace evidence must not be rephrased into a new obligation",
    );
  } finally {
    await h.close();
  }
});

test("new user requirements immediately suppress a deferred old question before the runner updates state", async () => {
  const h = await harness("defer");
  try {
    await h.block();
    assert.equal(h.state().userDecision?.status, "ready");
    const current = h.app.tasks.get(actor, h.task.id);
    h.app.tasks.records.save({
      ...current,
      requirements: `${current.requirements}\n首版只做本地阅读，不引入账号或云同步。`,
    });
    await h.app.tasks.reconcile(h.task.id);
    assert.equal(h.notices().length, 0);
    const progress = await taskProgress(
      { tasks: h.app.tasks, herdr: h.herdr, store: h.store },
      actor,
      h.task.id,
    );
    assert.equal(progress.workflow?.userDecision, undefined);
    assert.equal(progress.workflow?.awaitingUser, false);
    assert.doesNotMatch(progress.workflow?.waitingForEvidence ?? "", /首版是否包含跨设备同步/);
    assert.equal(h.counts().questions, 1);
  } finally {
    await h.close();
  }
});
