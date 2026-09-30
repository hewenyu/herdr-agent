import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Dispatch, SettledTaskOutput } from "../../src/app/task-orchestrator.js";
import { boardDirectory } from "../../src/orchestration/board.js";
import {
  addDocumentDelivery,
  authorizeDocumentDelivery,
  validateDocumentDelivery,
  validateDocumentPaths,
} from "../../src/orchestration/document-delivery.js";
import {
  handoffDirectory,
  legacyAssignment,
  prepareHandoff,
  readHandoff,
  reportSections,
} from "../../src/orchestration/handoff.js";
import { selectWorkflowOutput } from "../../src/orchestration/output-selection.js";
import type { PiChoiceResult } from "../../src/orchestration/pi-choice.js";
import { workflowState } from "../../src/orchestration/state.js";
import { statusInstructions } from "../../src/orchestration/status-block.js";
import { templatePlan } from "../../src/orchestration/templates.js";
import { validatePlan } from "../../src/orchestration/workflow.js";
import type { InputDelivery } from "../../src/tasks/input-delivery.js";
import { participantPrompt, participantPromptCandidates } from "../../src/tasks/prompts.js";
import { Engine } from "../app/helpers.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function fixture() {
  const h = setup();
  const created = await h.service.create(actor, {
    ...discussion,
    requirements: "讨论方案，并保存为 docs/DESIGN.md。",
  });
  const task = {
    ...created,
    promptVersion: 3 as const,
    boardDirectory: boardDirectory(h.directory, created.id),
  };
  const state = workflowState(h.store, task, "user-revision");
  const node = state.plan.nodes[0];
  assert.ok(node);
  const identity = { nodeId: node.id, operationId: "dispatch-1", inputRevision: "revision-1" };
  const directory = handoffDirectory(h.directory, task.id, identity.operationId);
  const prepare = () => prepareHandoff(h.directory, task, state, node, identity, []);
  const output = `已给出初稿，请下一位重点复核重连设计。材料：[本轮意见](${join(directory, "notes.md")})`;
  const read = (text = output) => readHandoff(h.directory, task, state, node, identity, text);
  const result = {
    protocolVersion: 1,
    ...identity,
    status: "completed",
    summary: "已分析重连设计，待交叉复核",
    issues: [],
    artifactRefs: [],
    evidence: [],
    blockers: [],
  };
  const complete = async () => {
    await writeFile(join(directory, "notes.md"), "# 初稿\n\n重连须恢复服务端牌局状态。\n");
    await writeFile(join(directory, "result.json"), JSON.stringify(result));
  };
  return {
    ...h,
    stateDir: h.directory,
    task,
    state,
    node,
    identity,
    directory,
    output,
    prepare,
    read,
    result,
    complete,
  };
}

test("natural handoffs keep machine receipts and detailed briefs out of conversation text", async () => {
  const h = await fixture();
  try {
    const instruction = await h.prepare();
    assert.match(instruction, /brief\.md/);
    assert.doesNotMatch(instruction, /protocolVersion|operationId|myrix-status|```/);
    const request = JSON.parse(await readFile(join(h.directory, "request.json"), "utf8"));
    assert.equal(request.operationId, h.identity.operationId);
    assert.equal(request.inputRevision, h.identity.inputRevision);
    assert.equal(request.nodeId, h.node.id);
    assert.match(await readFile(join(h.directory, "brief.md"), "utf8"), /聊天简短说明结果/);
    await h.complete();
    const block = await h.read();
    assert.equal(block.summary, h.result.summary);
    assert.equal(block.status, "completed");
    assert.equal(await h.prepare(), instruction, "recovery reuses the frozen handoff");
  } finally {
    h.close();
  }
});

test("prepared briefs cannot be silently replaced after a dispatch identity is frozen", async () => {
  const h = await fixture();
  try {
    await h.prepare();
    const before = await readFile(join(h.directory, "brief.md"), "utf8");
    await assert.rejects(
      prepareHandoff(h.stateDir, h.task, h.state, h.node, h.identity, ["新的用户要求"]),
      { code: "workflow_handoff" },
    );
    assert.equal(await readFile(join(h.directory, "brief.md"), "utf8"), before);
  } finally {
    h.close();
  }
});

test("natural outputs must cite this operation and receipts must match all three binding fields", async () => {
  const h = await fixture();
  try {
    await h.prepare();
    await h.complete();
    const previous = handoffDirectory(h.stateDir, h.task.id, "prior-dispatch");
    await assert.rejects(h.read(`详见 ${join(previous, "notes.md")}`), {
      code: "workflow_handoff",
    });
    await assert.rejects(h.read("已完成，请继续。"), { code: "workflow_handoff" });
    for (const field of ["nodeId", "operationId", "inputRevision"] as const) {
      await writeFile(
        join(h.directory, "result.json"),
        JSON.stringify({ ...h.result, [field]: "old" }),
      );
      await assert.rejects(h.read(), { code: "workflow_status" });
    }
  } finally {
    h.close();
  }
});

test("empty, missing, oversized, and linked handoff materials cannot advance a node", async () => {
  const h = await fixture();
  try {
    await h.prepare();
    await assert.rejects(h.read());
    await h.complete();
    await writeFile(join(h.directory, "notes.md"), "\n ");
    await assert.rejects(h.read(), { code: "workflow_handoff" });
    await writeFile(join(h.directory, "notes.md"), "x".repeat(1024 * 1024 + 1));
    await assert.rejects(h.read(), { code: "workflow_handoff" });
    await h.complete();
    await writeFile(join(h.directory, "result.json"), "x".repeat(1024 * 1024 + 1));
    await assert.rejects(h.read(), { code: "workflow_handoff" });
    await h.complete();
    for (const name of ["notes.md", "result.json"]) {
      const original = join(h.directory, name);
      const target = join(h.directory, `${name}.target`);
      await rename(original, target);
      await symlink(target, original);
      await assert.rejects(h.read(), { code: "workflow_handoff" });
      await rm(original);
      await rename(target, original);
    }
  } finally {
    h.close();
  }
});

test("handoff preparation rejects symlinked roots before creating external files", async () => {
  for (const component of ["board", "handoffs"] as const) {
    const h = await fixture();
    try {
      const outside = join(h.stateDir, "outside");
      await mkdir(outside, { recursive: true });
      const link =
        component === "board" ? h.task.boardDirectory : join(h.task.boardDirectory, "handoffs");
      await mkdir(dirname(link), { recursive: true });
      await symlink(outside, link);
      await assert.rejects(h.prepare(), { code: "workflow_handoff" });
      assert.deepEqual(
        await readdir(outside),
        [],
        "validation must precede mkdir/write outside state",
      );
    } finally {
      h.close();
    }
  }
});

test("frozen request and brief files cannot be replaced by symlinks during restart", async () => {
  for (const name of ["request.json", "brief.md"]) {
    const h = await fixture();
    try {
      await h.prepare();
      const original = join(h.directory, name);
      const target = join(h.directory, `${name}.target`);
      await rename(original, target);
      await symlink(target, original);
      await assert.rejects(h.prepare(), { code: "workflow_handoff" });
    } finally {
      h.close();
    }
  }
});

test("reporting reads its complete report file separately from the concise receipt", async () => {
  const h = await fixture();
  try {
    const node = h.state.plan.nodes.find((entry) => entry.phase === "reporting");
    assert.ok(node);
    const identity = { ...h.identity, nodeId: node.id };
    await prepareHandoff(h.stateDir, h.task, h.state, node, identity, []);
    await h.complete();
    await writeFile(join(h.directory, "result.json"), JSON.stringify({ ...h.result, ...identity }));
    const read = () => readHandoff(h.stateDir, h.task, h.state, node, identity, h.output);
    await assert.rejects(read(), {
      code: "workflow_handoff",
      recoverable: true,
      details: [
        { field: "report.md", reason: "missing_file", expected: join(h.directory, "report.md") },
      ],
    });
    const report = h.state.plan.deliveryRequirements
      .map((title) => `## ${title}\n真实的${title}内容。`)
      .join("\n\n");
    await writeFile(join(h.directory, "report.md"), report);
    const block = await read();
    assert.deepEqual(Object.keys(block.reportSections ?? {}), h.state.plan.deliveryRequirements);
    assert.ok(block.reportSections?.[h.state.plan.deliveryRequirements[0] ?? ""]);
    await writeFile(
      join(h.directory, "report.md"),
      `## ${h.state.plan.deliveryRequirements[0]}\n只有一个章节`,
    );
    await assert.rejects(read(), { code: "workflow_report" });
  } finally {
    h.close();
  }
});

test("report sections reject missing bodies, duplicate headings, and inherited object properties", () => {
  assert.deepEqual(
    { ...reportSections("# 交付\n\n## 结论\n正文\n\n## 待办\n下一步", ["结论", "待办"]) },
    {
      结论: "正文",
      待办: "下一步",
    },
  );
  for (const text of ["## 结论\n", "## 结论\n一\n## 结论\n二", "## 不同章节\n正文"])
    assert.throws(() => reportSections(text, ["结论"]), { code: "workflow_report" });
  assert.throws(() => reportSections("", ["toString"]), { code: "workflow_report" });
  assert.throws(() => reportSections("## __proto__\n一\n## __proto__\n二", []), {
    code: "workflow_report",
  });
});

test("discussion document delivery is path-bounded, dependency-ordered, and preserves old task scope", async () => {
  const h = await fixture();
  try {
    const plan = templatePlan(h.task);
    plan.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: h.task.requirements };
    validateDocumentDelivery(plan, h.task);
    addDocumentDelivery(plan);
    validatePlan(plan, h.task);
    const document = plan.nodes.find((entry) => entry.id === "document");
    const review = plan.nodes.find((entry) => entry.role === "reviewer");
    assert.deepEqual(document?.documentPaths, ["docs/DESIGN.md"]);
    assert.equal(document?.access, "write");
    assert.ok(review?.dependsOn.includes("document"));
    assert.ok(plan.requiredArtifacts?.includes("docs/DESIGN.md"));
    assert.ok(
      plan.nodes.filter((entry) => entry !== document).every((entry) => entry.access === "read"),
    );
    assert.throws(() => validateDocumentDelivery(plan, { ...h.task, promptVersion: 2 }), {
      code: "workflow_scope",
    });
    assert.throws(() => validateDocumentDelivery(plan, { ...h.task, kind: "development" }), {
      code: "workflow_scope",
    });
    for (const path of [
      "../outside.md",
      "/outside.md",
      "docs/../../outside.md",
      "docs//DESIGN.md",
      "docs/./DESIGN.md",
      "docs\\DESIGN.md",
      ".github/notes.md",
      "docs/.hidden.md",
      "src/index.ts",
      "package.json",
      "docs/nul\0.md",
    ]) {
      const invalid = { ...plan, documentDelivery: { ...plan.documentDelivery, paths: [path] } };
      assert.throws(
        () => validateDocumentDelivery(invalid, h.task),
        { code: "workflow_scope" },
        path,
      );
    }
  } finally {
    h.close();
  }
});

test("document authority cannot be derived from an omitted negation or an agent-originated quote", async () => {
  const h = await fixture();
  try {
    const task = {
      ...h.task,
      userRequest: undefined,
      requirements: "只讨论方案，不要修改任何文件。",
    };
    const plan = templatePlan(task);
    plan.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: "讨论方案" };
    assert.throws(() => validateDocumentDelivery(plan, task), { code: "workflow_scope" });
    plan.documentDelivery.userRequest = "我建议写入 docs/DESIGN.md。";
    assert.throws(() => validateDocumentDelivery(plan, task), { code: "workflow_scope" });
    const revision = "现在请把方案保存到 docs/DESIGN.md。";
    plan.documentDelivery.userRequest = revision;
    validateDocumentDelivery(plan, task, [revision]);
  } finally {
    h.close();
  }
});

test("v3 initial prompts are natural while retaining exact historical readback candidates", async () => {
  const h = await fixture();
  try {
    const participant = h.service.records.participants(h.task)[0];
    assert.ok(participant);
    const v3 = participantPrompt(h.task, participant);
    assert.match(v3, /直接回应上一位参与者/);
    assert.match(v3, /聊天中不输出 JSON、状态块/);
    assert.doesNotMatch(v3, /myrix-status JSON 状态块|正文遵守用户要求.*末尾另附/s);
    const v2 = participantPrompt({ ...h.task, promptVersion: 2 }, participant);
    const historical = participantPrompt({ ...h.task, promptVersion: undefined }, participant);
    const candidates = participantPromptCandidates(h.task, participant);
    assert.ok(candidates.includes(v2));
    assert.ok(candidates.includes(historical));
    assert.equal(candidates[0], v3);
    assert.match(v2, /工作流协议版本：2/);
    assert.doesNotMatch(historical, /工作流协议版本/);
    const legacy = legacyAssignment(h.task, h.state, h.node, h.identity, ["用户修订"]);
    const expected = [
      "本次工作流任务书（原始要求和后续修订优先）：",
      h.task.requirements,
      "用户修订",
      `节点：${h.node.id}；阶段：${h.node.phase}`,
      h.node.instruction,
      "必需交付文件：[]。相关节点须在 artifactRefs 中引用准确路径；报告不能以文字替代缺失文件。",
      `共享看板：${h.task.boardDirectory}。完整参与者原文位于 outputs/，请阅读与本节点相关的输入，不能仅依据摘要。`,
      `当前问题与已完成节点：${JSON.stringify({ issues: h.state.issues, nodes: h.state.nodes })}`,
      statusInstructions(h.identity),
    ].join("\n\n");
    assert.equal(legacy, expected);
  } finally {
    h.close();
  }
});

test("only an accepted restricted pi authorization can admit the exact proposed document scope", async () => {
  const h = await fixture();
  try {
    const plan = templatePlan(h.task);
    plan.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: h.task.requirements };
    const revision = "只保存设计，不开发代码。";
    const decisions: PiChoiceResult[] = [];
    let requests = 0;
    const engine = new Engine();
    const authorize = (choice: string) => {
      engine.handler = async (input) => {
        requests++;
        const request = JSON.parse(input.prompt);
        assert.deepEqual(request.state, {
          original: h.task.requirements,
          revisions: [revision],
          proposed: plan.documentDelivery,
        });
        assert.deepEqual(
          request.candidates.map((candidate: { id: string }) => candidate.id),
          ["authorized", "forbidden", "unclear"],
        );
        await input.tools[0]?.execute({ candidateId: choice }, input.actor);
        return { text: "", messages: [] };
      };
      return authorizeDocumentDelivery({
        task: h.task,
        plan,
        userMessages: [revision],
        engine,
        actor,
        assertCurrent() {},
        onDecision(result) {
          decisions.push(result);
        },
      });
    };
    await authorize("authorized");
    for (const choice of ["forbidden", "unclear", "illegal"])
      await assert.rejects(authorize(choice), { code: "workflow_document_authorization" });
    assert.equal(requests, 4);
    assert.equal(decisions.length, 4);
    assert.equal(decisions.at(-1)?.status, "invalid");
    assert.ok(
      plan.nodes.every((node) => node.access === "read"),
      "authorization never dispatches work",
    );
  } finally {
    h.close();
  }
});

test("document authorization is fail-closed on empty choices, provider failure, and stale state", async () => {
  const h = await fixture();
  try {
    const plan = templatePlan(h.task);
    plan.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: h.task.requirements };
    const decisions: PiChoiceResult[] = [];
    const engine = new Engine();
    const input = {
      task: h.task,
      plan,
      userMessages: [],
      engine,
      actor,
      assertCurrent() {},
      onDecision(result: PiChoiceResult) {
        decisions.push(result);
      },
    };
    engine.handler = async () => ({ text: "authorized", messages: [] });
    await assert.rejects(authorizeDocumentDelivery(input), {
      code: "workflow_document_authorization",
    });
    assert.equal(decisions.at(-1)?.reason, "empty_selection");
    engine.handler = async () => {
      throw new Error("private provider detail");
    };
    await assert.rejects(authorizeDocumentDelivery(input), {
      code: "workflow_document_authorization",
    });
    assert.equal(decisions.at(-1)?.status, "error");
    assert.doesNotMatch(JSON.stringify(decisions), /private provider detail/);
    let current = true;
    engine.handler = async () => {
      current = false;
      return { text: "", messages: [] };
    };
    await assert.rejects(
      authorizeDocumentDelivery({
        ...input,
        assertCurrent() {
          if (!current) throw new Error("superseded");
        },
      }),
      /superseded/,
    );
  } finally {
    h.close();
  }
});

test("late natural outputs from prior dispatched turns cannot replace the current handoff", async () => {
  const h = await fixture();
  try {
    const current: InputDelivery = {
      taskId: h.task.id,
      participantId: h.task.participantIds[0] ?? "p1",
      operationId: h.identity.operationId,
      fingerprint: "fingerprint",
      execution: { workspaceId: "w1", paneId: "p1", kind: "claude", cwd: h.stateDir },
      prompt: "current",
      receipt: "receipt",
      initial: false,
      discussionWasPaused: false,
      outputSequence: 10,
    };
    const prior: InputDelivery = { ...current, operationId: "prior-dispatch", outputSequence: 5 };
    h.store.set("input_deliveries", prior.operationId, prior);
    const dispatches: Dispatch[] = [current, prior].map((entry) => ({
      operationId: entry.operationId,
      participantId: entry.participantId,
      state: "sent",
      nodeId: h.node.id,
      inputRevision: "revision-1",
    }));
    const oldPath = join(handoffDirectory(h.stateDir, h.task.id, prior.operationId), "notes.md");
    const output = (id: string, text: string): SettledTaskOutput => ({
      taskId: h.task.id,
      participantId: current.participantId,
      entry: { id, text, role: "assistant", final: true },
      observedAt: new Date().toISOString(),
      sequence: 11,
    });
    const fresh = output("current", h.output);
    const late = output("late-prior", `之前的意见：${oldPath}`);
    const context = { stateDir: h.stateDir, taskId: h.task.id };
    assert.equal(
      selectWorkflowOutput([fresh, late], current, dispatches, h.store, context)?.entry.id,
      "current",
    );
    assert.equal(selectWorkflowOutput([late], current, dispatches, h.store, context), undefined);
    const malformed = output("malformed", "已经完成，但没写回执材料。");
    assert.equal(
      selectWorkflowOutput([late, malformed], current, dispatches, h.store, context)?.entry.id,
      "malformed",
      "unbound output must reach protocol failure instead of silently stalling",
    );
  } finally {
    h.close();
  }
});

test("document path preflight permits absent ordinary files without creating them", async () => {
  const h = await fixture();
  try {
    await validateDocumentPaths(h.task, ["docs/new/DESIGN.md"]);
    assert.equal((await readdir(h.task.directories[0] as string)).includes("docs"), false);
    await mkdir(join(h.task.directories[0] as string, "docs"));
    await writeFile(
      join(h.task.directories[0] as string, "docs", "DESIGN.md"),
      "existing document",
    );
    await validateDocumentPaths(h.task, ["docs/DESIGN.md"]);
    assert.equal(
      await readFile(join(h.task.directories[0] as string, "docs", "DESIGN.md"), "utf8"),
      "existing document",
    );
    for (const path of ["../escape.md", "/escape.md", "docs/../escape.md", "docs//escape.md"])
      await assert.rejects(validateDocumentPaths(h.task, [path]), { code: "workflow_scope" });
    await mkdir(join(h.task.directories[0] as string, "directory.md"));
    await assert.rejects(validateDocumentPaths(h.task, ["directory.md"]), {
      code: "workflow_scope",
    });
    await assert.rejects(validateDocumentPaths(h.task, ["docs/DESIGN.md/child.md"]), {
      code: "workflow_scope",
    });
  } finally {
    h.close();
  }
});

test("document path preflight rejects both parent and leaf symlinks", async () => {
  for (const parent of [true, false]) {
    const h = await fixture();
    try {
      const target = join(h.task.directories[0] as string, "elsewhere");
      await mkdir(target);
      await writeFile(join(target, "DESIGN.md"), "untouched");
      if (parent) await symlink(target, join(h.task.directories[0] as string, "docs"));
      else {
        await mkdir(join(h.task.directories[0] as string, "docs"));
        await symlink(
          join(target, "DESIGN.md"),
          join(h.task.directories[0] as string, "docs", "DESIGN.md"),
        );
      }
      await assert.rejects(validateDocumentPaths(h.task, ["docs/DESIGN.md"]), {
        code: "workflow_scope",
      });
      assert.equal(await readFile(join(target, "DESIGN.md"), "utf8"), "untouched");
    } finally {
      h.close();
    }
  }
});

test("cancelled document authorization records cancellation without granting write scope", async () => {
  const h = await fixture();
  try {
    const plan = templatePlan(h.task);
    plan.documentDelivery = { paths: ["docs/DESIGN.md"], userRequest: h.task.requirements };
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const engine = new Engine();
    engine.handler = async () => {
      calls++;
      throw new Error("unexpected pi request");
    };
    const decisions: PiChoiceResult[] = [];
    await assert.rejects(
      authorizeDocumentDelivery({
        task: h.task,
        plan,
        userMessages: [],
        engine,
        actor,
        signal: controller.signal,
        assertCurrent: () => {},
        onDecision: (result) => {
          decisions.push(result);
        },
      }),
    );
    assert.equal(calls, 0);
    assert.equal(decisions[0]?.status, "cancelled");
    assert.ok(plan.nodes.every((node) => node.access === "read"));
  } finally {
    h.close();
  }
});
