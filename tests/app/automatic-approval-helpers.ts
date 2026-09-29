import assert from "node:assert/strict";
import { AutomaticApprovals } from "../../src/app/automatic-approvals.js";
import { createLogger } from "../../src/app/logger.js";
import type { OperationError } from "../../src/core/errors.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { ActorContext, AgentScreen, Participant, Task } from "../../src/core/types.js";
import { screenFingerprint } from "../../src/herdr/screen.js";
import { setup } from "./helpers.js";

export async function automaticApprovalFixture() {
  const h = setup();
  const created = (await h.app.dispatch("task.create", {
    kind: "development",
    title: "菜单自动选择",
    requirements: "在项目内实现并验证功能。",
    participants: [{ kind: "claude" }],
    orchestration: { mode: "manual" },
  })) as Task;
  await h.app.tasks.reconcile(created.id);
  const task = h.store.get<Task>("tasks", created.id);
  assert.ok(task);
  const participant = h.app.tasks.records.participants(task)[0] as Participant;
  assert.ok(participant.execution);
  const agent = h.herdr.agents.get(participant.execution.paneId);
  assert.ok(agent);
  agent.status = "blocked";
  agent.terminalId = "native-terminal-1";
  participant.status = "blocked";
  h.app.tasks.records.saveParticipant(participant);
  const screen: AgentScreen = {
    agent: { ...agent },
    text: "Permission dialog v999\n❯ Allow once\n  Cancel\nConfirm with Enter",
    question: "Permission dialog v999",
    source: "visible",
    truncated: false,
    options: [
      { key: "up", label: "上移" },
      { key: "down", label: "下移" },
      { key: "enter", label: "确认当前项" },
      { key: "y", label: "y（屏幕明确支持时）" },
      { key: "n", label: "n（屏幕明确支持时）" },
    ],
  };
  h.herdr.screen = async () => structuredClone(screen);
  const actor: ActorContext = {
    ownerId: task.ownerId,
    chatId: task.chatId ?? "entry",
    sessionId: "approval",
    taskId: task.id,
    messageId: "blocked",
  };
  const writes: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const logLines: string[] = [];
  const approvalLogger = createLogger((line) => logLines.push(line));
  let candidate = "option:1";
  let confidence = 0.98;
  let beforeResponse: (() => void | Promise<void>) | undefined;
  let writeFailure: OperationError | undefined;
  (h.herdr as HerdrPort).answer = async (_ref, key, guard) => {
    await guard.beforeWrite?.();
    guard.assertCurrent?.();
    assert.equal(guard?.screenFingerprint, screenFingerprint(screen.text));
    assert.equal(guard?.terminalId, "native-terminal-1");
    if (writeFailure?.outcome === "not_executed") throw writeFailure;
    writes.push(key ?? "");
    if (writeFailure) throw writeFailure;
    if (key === "down")
      screen.text = screen.text.replace("❯ Allow once\n  Cancel", "  Allow once\n❯ Cancel");
    else {
      screen.text = "Agent resumed";
      screen.agent.status = "working";
    }
  };
  h.engine.handler = async () => {
    throw new Error("pi must not run for accepted Jev choice");
  };
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    await beforeResponse?.();
    const ids = Object.keys(body.questions.action.criteria);
    const selected =
      ids.find((id) => id === candidate || id.startsWith(`${candidate}:`)) ?? candidate;
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          action: {
            type: "choice",
            choice: selected,
            confidence,
            probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0])),
          },
        },
        usage: { input_tokens: 30, output_tokens: 10 },
      }),
      { status: 200 },
    );
  };
  let enabled = true;
  const abort = new AbortController();
  const controller = () =>
    new AutomaticApprovals({
      store: h.store,
      herdr: h.herdr,
      approvals: h.app.approvals,
      engine: h.engine,
      logger: approvalLogger,
      signal: abort.signal,
      config: () => (enabled ? { apiKey: "fixture-secret" } : undefined),
      fetch: fetchImpl,
    });
  return {
    ...h,
    task,
    participant,
    screen,
    actor,
    writes,
    requests,
    logLines,
    controller,
    fetchImpl,
    disable: () => {
      enabled = false;
    },
    abort,
    choose: (value: string, probability = 0.98) => {
      candidate = value;
      confidence = probability;
    },
    before: (run: () => void | Promise<void>) => {
      beforeResponse = run;
    },
    failWrite: (error: OperationError) => {
      writeFailure = error;
    },
    handle: () => controller().handle(task, participant, structuredClone(screen), actor),
  };
}
