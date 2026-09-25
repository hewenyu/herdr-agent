import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import type { Task } from "../../src/core/types.js";
import { setup } from "./helpers.js";

test("one task autonomously plans, revises the same agent, hands off and delivers native synthesis", async () => {
  const fixture = setup();
  let stage = 0;
  fixture.engine.handler = async (input) => {
    if (!input.sessionId.startsWith("orchestration:"))
      return { text: '{"notify":false,"text":""}', messages: [] };
    const state = JSON.parse(input.prompt) as {
      participants: Array<{ id: string }>;
      authoritativeOutputs: Array<{ entry: { id: string; text: string } }>;
    };
    const send = input.tools.find((tool) => tool.name === "participant_send");
    const decide = input.tools.find((tool) => tool.name === "orchestration_decide");
    assert.ok(send && decide);
    if (stage < 4) {
      const index = [1, 1, 0, 1][stage] as number;
      await send.execute(
        {
          participantId: state.participants[index]?.id,
          text: [
            "先核对需求并给出执行计划，不测试。",
            "修订计划中遗漏的兼容约束，不测试。",
            "按已修订方案实现，不测试，保留用户文件。",
            "依据实际产出形成完整交付说明，列明未验证项，不测试。",
          ][stage],
        },
        input.actor,
      );
      await decide.execute(
        { action: "continue", reason: "已分派授权范围内的下一步。" },
        input.actor,
      );
    } else {
      const final = state.authoritativeOutputs.find(
        (output) => output.entry.text === "完整交付物及未验证事项",
      );
      assert.ok(final);
      await decide.execute(
        { action: "deliver", reason: "已收到完整的参与者交付。", outputId: final.entry.id },
        input.actor,
      );
    }
    stage++;
    return { text: "", messages: [] };
  };
  try {
    const session = fixture.app.sessions.current("owner", "entry");
    const task = await fixture.app.tasks.create(
      {
        source: "feishu",
        ownerId: "owner",
        chatId: "entry",
        sessionId: session.id,
        messageId: "goal",
      },
      {
        kind: "development",
        title: "完整交付",
        requirements: "讨论并实现功能，修订遗漏，最后汇总交付；不要测试。",
        project: "project",
        createGroup: false,
        createRemoteTask: false,
        participants: [
          { kind: "codex", name: "执行者" },
          { kind: "claude", name: "规划与汇总" },
        ],
        orchestration: { mode: "model" },
      },
    );
    await fixture.app.tick();
    assert.equal(
      stage,
      1,
      JSON.stringify({
        task: fixture.store.get("tasks", task.id),
        events: fixture.store.list("task_orchestration_events"),
        calls: fixture.engine.calls.map((c) => c.sessionId),
      }),
    );
    assert.equal(fixture.herdr.sends.length, 1);
    const secondPane = fixture.herdr.sends[0]?.pane as string;
    fixture.herdr.finish(secondPane, "初版计划");
    await fixture.app.tick();
    assert.equal(stage, 2);
    assert.equal(
      fixture.herdr.sends[1]?.pane,
      secondPane,
      "AI can revise same agent rather than round-robin",
    );
    fixture.herdr.finish(secondPane, "修订后计划");
    await fixture.app.tick();
    assert.equal(stage, 3);
    const firstPane = fixture.herdr.sends[2]?.pane as string;
    assert.notEqual(firstPane, secondPane);
    fixture.herdr.finish(firstPane, "实现产出");
    await fixture.app.tick();
    assert.equal(stage, 4);
    fixture.herdr.finish(secondPane, "完整交付物及未验证事项");
    await fixture.app.tick();
    assert.equal(stage, 5);
    await fixture.app.tick();
    assert.equal(fixture.herdr.sends.length, 4, "settled output is consumed only once");
    const decisions = fixture.store.list<OrchestrationEvent>("task_orchestration_events");
    assert.equal(decisions.filter((event) => event.decision?.action === "deliver").length, 1);
    assert.ok(
      fixture.platform.texts.some(
        (message) => message.chat === "entry" && message.text.includes("完整交付物及未验证事项"),
      ),
    );
    const persisted = fixture.store.get<Task>("tasks", task.id);
    assert.equal(persisted?.status, "review");
    assert.equal(persisted?.completedAt, undefined);
    assert.equal(fixture.herdr.closes, 0, "delivery never impersonates user acceptance");
    assert.equal(fixture.platform.deletions, 0);
  } finally {
    await fixture.close();
  }
});
