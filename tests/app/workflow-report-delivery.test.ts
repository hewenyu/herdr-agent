import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { OrchestrationEvent } from "../../src/app/task-orchestrator.js";
import { OperationError } from "../../src/core/errors.js";
import type { Participant, StoredMessage, Task, TranscriptEntry } from "../../src/core/types.js";
import { inspectArtifact } from "../../src/orchestration/board.js";
import { assertCodeDelivery } from "../../src/orchestration/code-delivery.js";
import { addDocumentDelivery } from "../../src/orchestration/document-delivery.js";
import { prepareDocumentSource } from "../../src/orchestration/document-source.js";
import { publishReport, reportText } from "../../src/orchestration/report.js";
import { workflowState } from "../../src/orchestration/state.js";
import { WORKFLOWS } from "../../src/orchestration/workflow.js";
import { workspaceRevision } from "../../src/orchestration/workspace.js";
import { fixture as gitFixture } from "../orchestration/code-delivery-fixture.js";
import { setup } from "./helpers.js";

interface DeliveryCallbacks {
  orchestrationReply(task: Task, text: string, eventId: string): Promise<void>;
  output(task: Task, participant: Participant, entry: TranscriptEntry): Promise<void>;
}

async function workflowReport(kind: Task["kind"] = "development", dirty = false) {
  const h = setup();
  const source = await gitFixture();
  await source.initialize();
  const git = source.git;
  const repo = source.directory;
  await git("branch", "-m", "report-source");
  if (dirty) await writeFile(join(repo, "index.mjs"), "export const answer = 43;\n");
  await h.app.projects.save({ name: "delivery", directories: [repo], agent: "codex" });
  const task = await h.app.tasks.create(
    { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "code-report" },
    {
      kind,
      title: "代码交付报告",
      requirements: kind === "discussion" ? "讨论并保存 DESIGN.md" : "交付当前代码与实际位置",
      project: "delivery",
      participants: [{ kind: "codex" }, { kind: "claude" }],
      orchestration: { mode: "workflow" },
      createGroup: false,
      createRemoteTask: false,
    },
  );
  task.promptVersion = 3;
  h.app.tasks.records.save(task);
  const internals = h.app as unknown as DeliveryCallbacks & {
    taskOrchestrator: { revision(task: Task, includeWorkflow?: boolean): string };
  };
  const state = workflowState(h.store, task, internals.taskOrchestrator.revision(task, false));
  state.phase = "reporting";
  state.planning = "ready";
  if (kind === "discussion") {
    state.plan.documentDelivery = { paths: ["DESIGN.md"], userRequest: task.requirements };
    addDocumentDelivery(state.plan);
    await writeFile(join(repo, "DESIGN.md"), `# 讨论方案\n${"最终正文。".repeat(3000)}`);
    state.documentSource = await prepareDocumentSource(h.store, task, state);
  }
  const artifactRevision = await workspaceRevision(task.directories);
  state.implementationParticipants = [task.participantIds[0] as string];
  for (const node of state.plan.nodes)
    state.nodes[node.id] = {
      status: "completed",
      attempt: 1,
      artifactRevision,
      participantId: task.participantIds[node.role === "reviewer" ? 1 : 0],
      outputId: `${node.id}-output`,
    };
  if (kind === "discussion")
    state.artifacts.push({
      ...(await inspectArtifact(task, "DESIGN.md")),
      reference: "DESIGN.md",
      outputId: "document-output",
      artifactRevision,
    });
  else
    state.evidence.push({
      id: "independent-check",
      source: "agent_review",
      result: "passed",
      command: "node --check index.mjs",
      description: "独立重跑",
      participantId: task.participantIds[1],
      outputId: "validate-output",
      artifactRevision,
    });
  await publishReport(
    h.directory,
    task,
    state,
    {
      protocolVersion: 1,
      nodeId: "report",
      operationId: "report-op",
      inputRevision: "revision",
      status: "completed",
      summary: "当前代码已整理",
      issues: [],
      artifactRefs: [],
      evidence: [],
      blockers: [],
      reportSections: Object.fromEntries(
        state.plan.deliveryRequirements.map((name) => [name, "结论"]),
      ),
    },
    "report-output",
    artifactRevision,
  );
  h.store.set(WORKFLOWS, task.id, state);
  const event: OrchestrationEvent = {
    id: "code-report-event",
    taskId: task.id,
    trigger: "output",
    outputIds: ["report-output"],
    userRevision: internals.taskOrchestrator.revision(task),
    state: "done",
    attempts: 1,
    dispatches: [],
    decision: { action: "deliver", reason: "交付", reportId: state.report?.id },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  h.store.set("task_orchestration_events", event.id, event);
  const text = await reportText(state);
  const send = () => internals.orchestrationReply(task, text, event.id);
  return {
    ...h,
    repo,
    task,
    state,
    event,
    text,
    artifactRevision,
    git,
    send,
    gitResponse: source.respond,
    async close() {
      await h.close();
      await source.close();
    },
  };
}

test("application sends complete workflow report and summary under event receipts, preserving raw outputs", async () => {
  const h = setup();
  try {
    assert.ok(h.config.jev);
    h.config.jev.apiKey = "fixture-key";
    const task = await h.app.tasks.create(
      { ownerId: "owner", chatId: "entry", sessionId: "entry", messageId: "report-task" },
      {
        kind: "discussion",
        title: "报告交付",
        requirements: "讨论并整理结论",
        project: "project",
        participants: [{ kind: "codex" }, { kind: "claude" }],
        orchestration: { mode: "workflow" },
      },
    );
    task.promptVersion = 2; // This fixture exercises legacy report recovery.
    h.app.tasks.records.save(task);
    const participant = h.app.tasks.records.participants(task)[0];
    assert.ok(participant);
    const callbacks = h.app as unknown as DeliveryCallbacks;
    const entry: TranscriptEntry = {
      id: "native-final",
      role: "assistant",
      final: true,
      text: '可见分析\n```myrix-status\n{"internal":"state"}\n```',
    };
    await callbacks.output(task, participant, entry);
    assert.equal(h.platform.texts[0]?.text.includes("myrix-status"), false);
    assert.equal(entry.text.includes("myrix-status"), true);
    const text = "# 完整报告\n\n讨论结论、证据与保留事项。";
    const state = workflowState(h.store, task, "revision");
    state.report = {
      id: "report-1",
      path: "/not-read-by-delivery-callback",
      hash: createHash("sha256").update(text).digest("hex"),
      outputId: entry.id,
      artifactRevision: "artifact-1",
    };
    h.store.set(WORKFLOWS, task.id, state);
    const event: OrchestrationEvent = {
      id: "report-event",
      taskId: task.id,
      trigger: "output",
      outputIds: [entry.id],
      userRevision: "revision",
      state: "done",
      attempts: 1,
      dispatches: [],
      decision: {
        action: "deliver",
        reason: "合同已满足",
        outputId: entry.id,
        participantId: participant.id,
        reportId: state.report.id,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    h.store.set("task_orchestration_events", event.id, event);
    let cards = 0;
    h.platform.cardHook = async () => {
      cards++;
      if (cards === 1) throw new OperationError("platform_unavailable", "not sent");
    };
    await assert.rejects(callbacks.orchestrationReply(task, text, event.id));
    assert.equal(h.platform.texts.length, 2, "report body is independent of native output receipt");
    await callbacks.orchestrationReply(task, text, event.id);
    assert.equal(h.platform.texts.length, 2, "delivered body is never repeated");
    assert.equal(cards, 2);
    const history = h.store.list<StoredMessage>("messages");
    assert.equal(
      history.some((message) => message.source === "workflow_report" && message.text === text),
      true,
    );
    assert.equal(
      history.some((message) => message.source === "workflow_report_summary"),
      true,
    );
    assert.equal(
      h.app.outbox.receipt(`output:${task.id}:${participant.id}:${entry.id}`)?.state,
      "delivered",
    );
    assert.equal(
      h.app.outbox.receipt(`workflow-report:${task.id}:${event.id}:${state.report.id}:body`)?.state,
      "delivered",
    );
  } finally {
    await h.close();
  }
});

test("v3 delivers a report attachment and one compact summary with an owner-bound frozen download", async () => {
  const h = await workflowReport("discussion");
  try {
    const { task, text } = h;
    let uploaded = "";
    let sent = 0;
    const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
    platform.uploadFile = async (_name, content) => {
      uploaded = content;
      return "key";
    };
    platform.sendFile = async () => {
      sent++;
      return "file-message";
    };
    await h.send();
    assert.equal(uploaded, text);
    assert.equal(sent, 1);
    assert.equal(h.platform.texts.length, 0);
    assert.equal(h.platform.cards.length, 1);
    const messages = h.store.list<StoredMessage>("messages");
    assert.equal(messages.length, 1);
    const summary = messages[0];
    assert.ok(summary);
    assert.equal(summary.source, "workflow_report_summary");
    assert.ok(summary.text.length < 2000);
    assert.equal(h.app.reportDownload("owner", summary.id).content, text);
    assert.throws(
      () =>
        h.app.acknowledgeReport({
          ownerId: "owner",
          sessionId: summary.sessionId,
          taskId: task.id,
          messageId: summary.id,
        }),
      { code: "receipt_scope" },
      "platform report receipts cannot be confirmed through the Web rendering endpoint",
    );
    h.config.feishu.allowedOpenIds.push("other-owner");
    assert.throws(() => h.app.reportDownload("other-owner", summary.id));
    assert.throws(() => h.app.reportDownload("owner", "/etc/passwd"));
    const record = h.store.get<Record<string, unknown>>("workflow_report_deliveries", h.event.id);
    h.store.set("workflow_report_deliveries", h.event.id, { ...record, text: "modified" });
    assert.throws(() => h.app.reportDownload("owner", summary.id));
  } finally {
    await h.close();
  }
});

for (const boundary of ["before upload", "after upload", "after file"] as const)
  test(`application rejects unchanged-source Git drift ${boundary} without replaying sent report stages`, async () => {
    const h = await workflowReport();
    const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
    const calls = { uploads: 0, files: 0, cards: 0 };
    let changed = false;
    const changeBranch = async () => {
      if (changed) return;
      changed = true;
      await h.git("checkout", "--quiet", "-b", "changed-delivery-branch");
    };
    platform.uploadFile = async () => {
      calls.uploads++;
      if (boundary === "after upload") await changeBranch();
      return "file-key";
    };
    platform.sendFile = async () => {
      calls.files++;
      if (boundary === "after file") await changeBranch();
      return "file-message";
    };
    platform.sendCard = async () => {
      calls.cards++;
      return "card-message";
    };
    try {
      if (boundary === "before upload") await changeBranch();
      await assert.rejects(h.send(), { code: "workflow_report", message: /Git/ });
      assert.equal(await workspaceRevision(h.task.directories), h.artifactRevision);
      const expected = {
        uploads: boundary === "before upload" ? 0 : 1,
        files: boundary === "after file" ? 1 : 0,
        cards: 0,
      };
      assert.deepEqual(calls, expected);
      await assert.rejects(h.send(), { code: "workflow_report" });
      assert.deepEqual(calls, expected, "retry does not reuse its previous freshness check");
      assert.equal(await reportText(h.state), h.text, "the old frozen report remains immutable");
      await h.git("checkout", "--quiet", "report-source");
      await h.send();
      assert.deepEqual(calls, { uploads: 1, files: 1, cards: 1 });
      await h.send();
      assert.deepEqual(calls, { uploads: 1, files: 1, cards: 1 });
    } finally {
      await h.close();
    }
  });

for (const change of ["report", "directory", "requirements"] as const)
  test(`application rechecks ${change} identity after attachment upload before sending`, async () => {
    const h = await workflowReport();
    const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
    let files = 0;
    let cards = 0;
    platform.uploadFile = async () => {
      if (change === "report") {
        assert.ok(h.state.report);
        h.store.set(WORKFLOWS, h.task.id, {
          ...h.state,
          report: { ...h.state.report, id: "replacement-report" },
        });
      } else
        h.app.tasks.records.save({
          ...h.task,
          ...(change === "directory"
            ? { directories: [h.directory] }
            : { requirements: "用户更新了要求" }),
        });
      return "uploaded-key";
    };
    platform.sendFile = async () => {
      files++;
      return "file-message";
    };
    platform.sendCard = async () => {
      cards++;
      return "card-message";
    };
    try {
      await assert.rejects(h.send(), {
        code: change === "requirements" ? "orchestration_superseded" : "workflow_report",
      });
      assert.equal(files, 0);
      assert.equal(cards, 0);
      const record = h.store.get<Record<string, unknown>>("workflow_report_deliveries", h.event.id);
      assert.equal(record?.fileKey, "uploaded-key");
      assert.equal(record?.fileMessageId, undefined);
      assert.equal(record?.text, h.text);
    } finally {
      await h.close();
    }
  });

for (const boundary of ["upload", "Git lookup"] as const)
  test(`dirty source changes during ${boundary} are rejected even when Git metadata is unchanged`, async () => {
    const h = await workflowReport("development", true);
    const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
    let uploads = 0;
    let files = 0;
    let cards = 0;
    platform.uploadFile = async () => {
      uploads++;
      if (boundary === "upload")
        await writeFile(join(h.repo, "index.mjs"), "export const answer = 44;\n");
      return "uploaded-key";
    };
    platform.sendFile = async () => {
      files++;
      return "file-message";
    };
    platform.sendCard = async () => {
      cards++;
      return "card-message";
    };
    try {
      if (boundary === "Git lookup") {
        const patch = join(h.directory, "source.patch");
        await writeFile(
          patch,
          [
            "diff --git a/index.mjs b/index.mjs",
            "--- a/index.mjs",
            "+++ b/index.mjs",
            "@@ -1 +1 @@",
            "-export const answer = 43;",
            "+export const answer = 44;",
            "",
          ].join("\n"),
        );
        // The fake gh changes only working bytes between the collector's Git snapshots.
        await h.gitResponse({ gitArgs: ["apply", patch], pr: null });
      }
      await assert.rejects(h.send(), { code: "workflow_report", message: /文件版本已变化/ });
      assert.equal(uploads, boundary === "upload" ? 1 : 0);
      assert.equal(files, 0);
      assert.equal(cards, 0);
      assert.notEqual(await workspaceRevision(h.task.directories), h.artifactRevision);
      await h.gitResponse({ unavailable: true });
      await assertCodeDelivery(h.task, h.state);
      assert.equal(await reportText(h.state), h.text);
      await assert.rejects(h.send(), { code: "workflow_report", message: /文件版本已变化/ });
      assert.equal(uploads, boundary === "upload" ? 1 : 0, "no upload is repeated on retry");
    } finally {
      await h.close();
    }
  });

for (const kind of ["discussion", "review", "test"] as const)
  for (const boundary of ["upload", "file"] as const)
    test(`v3 ${kind} rechecks its report after ${boundary} before the next delivery stage`, async () => {
      const h = await workflowReport(kind);
      const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
      const calls = { uploads: 0, files: 0, cards: 0 };
      const originalDocument =
        kind === "discussion" ? await readFile(join(h.repo, "DESIGN.md"), "utf8") : undefined;
      let changed = false;
      const mutate = async () => {
        if (changed) return;
        changed = true;
        if (kind === "discussion")
          await writeFile(join(h.repo, "DESIGN.md"), "授权文档在报告冻结后发生变化。\n");
        else
          h.app.tasks.records.save({
            ...h.task,
            ...(kind === "review"
              ? { directories: [h.directory] }
              : { requirements: "用户补充了新的验证要求" }),
          });
      };
      platform.uploadFile = async () => {
        calls.uploads++;
        if (boundary === "upload") await mutate();
        return "file-key";
      };
      platform.sendFile = async () => {
        calls.files++;
        if (boundary === "file") await mutate();
        return "file-message";
      };
      platform.sendCard = async () => {
        calls.cards++;
        return "card-message";
      };
      try {
        const failure = { code: kind === "test" ? "orchestration_superseded" : "workflow_report" };
        await assert.rejects(h.send(), failure);
        const expected = { uploads: 1, files: boundary === "file" ? 1 : 0, cards: 0 };
        assert.deepEqual(calls, expected);
        await assert.rejects(h.send(), failure);
        assert.deepEqual(calls, expected);
        assert.equal(await reportText(h.state), h.text);
        assert.equal(
          h.state.deliveryEvidence,
          undefined,
          "non-development reports need no Git contract",
        );
        h.app.tasks.records.save(h.task);
        if (originalDocument !== undefined)
          await writeFile(join(h.repo, "DESIGN.md"), originalDocument);
        await h.send();
        assert.deepEqual(calls, { uploads: 1, files: 1, cards: 1 });
        await h.send();
        assert.deepEqual(calls, { uploads: 1, files: 1, cards: 1 });
      } finally {
        await h.close();
      }
    });

for (const kind of ["discussion", "review", "test"] as const)
  test(`v3 ${kind} checks the full report contract after upload, even with unchanged files`, async () => {
    const h = await workflowReport(kind);
    const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
    let uploads = 0;
    let files = 0;
    let cards = 0;
    platform.uploadFile = async () => {
      uploads++;
      h.state.issues.push({
        id: "new-blocker",
        description: "新的独立复核发现尚未解决。",
        status: "open",
        blocking: true,
        evidenceRefs: [],
        raisedBy: h.task.participantIds[1] as string,
        responses: [],
      });
      h.store.set(WORKFLOWS, h.task.id, h.state);
      return "file-key";
    };
    platform.sendFile = async () => {
      files++;
      return "file-message";
    };
    platform.sendCard = async () => {
      cards++;
      return "card-message";
    };
    try {
      await assert.rejects(h.send(), { code: "workflow_report", message: /仍有未处理阻塞问题/ });
      assert.equal(await workspaceRevision(h.task.directories), h.artifactRevision);
      assert.equal(uploads, 1);
      assert.equal(files, 0);
      assert.equal(cards, 0);
      await assert.rejects(h.send(), { code: "workflow_report" });
      assert.equal(uploads, 1);
      assert.equal(files, 0);
      assert.equal(cards, 0);
    } finally {
      await h.close();
    }
  });
