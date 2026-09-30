import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { REPORT_ATTACHMENT_MAX_BYTES } from "../../src/core/report-limits.js";
import { boardDirectory } from "../../src/orchestration/board.js";
import {
  publishReport,
  reportCard,
  reportContract,
  reportText,
} from "../../src/orchestration/report.js";
import { reportSummaryText } from "../../src/orchestration/report-delivery.js";
import { workflowState } from "../../src/orchestration/state.js";
import type { StatusBlock } from "../../src/orchestration/status-block.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function fixture(promptVersion: 2 | 3 = 3) {
  const h = setup();
  const created = await h.service.create(actor, discussion);
  const board = boardDirectory(h.directory, created.id);
  await mkdir(board, { recursive: true });
  const task = {
    ...created,
    directories: [h.directory],
    boardDirectory: board,
    promptVersion,
  };
  const state = workflowState(h.store, task, "revision");
  state.plan.deliveryRequirements = ["结论"];
  const block: StatusBlock = {
    protocolVersion: 1,
    nodeId: "report",
    operationId: "dispatch-report",
    inputRevision: "revision",
    status: "completed",
    summary: "总结报告",
    issues: [],
    artifactRefs: [],
    evidence: [],
    blockers: [],
    reportSections: { 结论: "结论" },
  };
  return {
    ...h,
    task,
    state,
    block,
    board,
    publish: () => publishReport(h.directory, task, state, block, "report-output", "revision"),
  };
}

test("report summary describes body, attachment and local Web delivery without implying acceptance", async () => {
  const h = await fixture();
  try {
    const body = reportSummaryText(reportCard(h.task, h.state));
    const attachment = reportSummaryText(reportCard(h.task, h.state, "attachment"));
    const web = reportSummaryText(reportCard(h.task, h.state, "web"));
    assert.match(body, /本会话正文中发送/);
    assert.match(attachment, /report\.md 附件发送/);
    assert.match(attachment, /本机 Web 下载/);
    assert.match(web, /本机 Web 下载（report\.md）/);
    for (const summary of [attachment, web]) assert.doesNotMatch(summary, /正文中发送/);
    assert.doesNotMatch(web, /附件发送/);
    for (const summary of [body, attachment, web]) assert.match(summary, /交付不代表已验收/);
  } finally {
    h.close();
  }
});

test("stale open issues do not block delivery and are separated in the report and summary", async () => {
  const h = await fixture();
  try {
    h.state.plan.consensus = { participantIds: h.task.participantIds };
    h.state.issues.push({
      id: "stale-blocker",
      description: "旧版本阻塞问题",
      status: "open",
      blocking: true,
      needsRevalidation: true,
      evidenceRefs: [],
      raisedBy: "old-output",
      responses: [],
    });
    const gates = ["共同认可仍有未处理分歧", "仍有未处理阻塞问题"];
    for (const gate of gates) assert.ok(!reportContract(h.state, "revision", []).includes(gate));

    // Publishing itself need not exercise the independent consensus-document contract.
    delete h.state.plan.consensus;
    await h.publish();
    const text = await reportText(h.state);
    assert.match(text, /## 保留问题\n\n\n## 旧版本遗留问题（待重新验证）/);
    assert.match(text, /## 旧版本遗留问题（待重新验证）\n\n- stale-blocker · open：旧版本阻塞问题/);
    const summary = reportSummaryText(reportCard(h.task, h.state));
    assert.match(summary, /未决事项：无/);
    assert.match(summary, /旧版本遗留问题（待重新验证）：旧版本阻塞问题/);

    const issue = h.state.issues[0];
    assert.ok(issue);
    delete issue.needsRevalidation;
    h.state.plan.consensus = { participantIds: h.task.participantIds };
    for (const gate of gates) assert.ok(reportContract(h.state, "revision", []).includes(gate));
    const currentSummary = reportSummaryText(reportCard(h.task, h.state));
    assert.match(currentSummary, /未决事项：旧版本阻塞问题/);
    assert.doesNotMatch(currentSummary, /旧版本遗留问题（待重新验证）/);
  } finally {
    h.close();
  }
});

test("aggregate UTF-8 document and section bytes are rejected before freezing and can be corrected", async () => {
  const h = await fixture();
  try {
    const paths = Array.from({ length: 10 }, (_, index) => `docs/design-${index}.md`);
    const document = "文".repeat(349_000);
    assert.ok(Buffer.byteLength(document) < 1_048_576);
    await mkdir(join(h.directory, "docs"));
    await Promise.all(paths.map((path) => writeFile(join(h.directory, path), document)));
    h.state.plan.documentDelivery = { paths, userRequest: "交付设计文档" };
    const summary = "报告".repeat(4_000);
    h.block.reportSections = { 结论: summary };
    assert.ok(
      paths.length * document.length + summary.length < REPORT_ATTACHMENT_MAX_BYTES,
      "a JavaScript character limit would miss the UTF-8 overflow",
    );
    await assert.rejects(h.publish(), { code: "workflow_report", message: /UTF-8.*10 MiB/ });
    assert.equal(h.state.report?.id, undefined);
    await assert.rejects(readFile(join(h.board, "report.md")), { code: "ENOENT" });
    await assert.rejects(readdir(join(h.board, "reports")), { code: "ENOENT" });

    h.block.reportSections = { 结论: "精简后的完整结论" };
    await h.publish();
    const text = await reportText(h.state);
    assert.ok(Buffer.byteLength(text) <= REPORT_ATTACHMENT_MAX_BYTES);
    assert.equal(text.split(document).length - 1, paths.length, "every document remains whole");
    for (const path of paths) {
      assert.ok(text.includes(`## 交付文档：${path}`));
      assert.equal(await readFile(join(h.directory, path), "utf8"), document);
    }
  } finally {
    h.close();
  }
});

test("the exact attachment byte boundary is accepted and an oversized replacement cannot overwrite it", async () => {
  const h = await fixture();
  try {
    await h.publish();
    const baseline = await reportText(h.state);
    const padding = REPORT_ATTACHMENT_MAX_BYTES - Buffer.byteLength(baseline);
    h.block.reportSections = {
      结论: `结论${"界".repeat(Math.floor(padding / 3))}${"x".repeat(padding % 3)}`,
    };
    await h.publish();
    const accepted = await reportText(h.state);
    const frozen = structuredClone(h.state.report);
    const reports = await readdir(join(h.board, "reports"));
    assert.equal(Buffer.byteLength(accepted), REPORT_ATTACHMENT_MAX_BYTES);

    h.block.reportSections.结论 += "x";
    await assert.rejects(h.publish(), { code: "workflow_report" });
    assert.deepEqual(h.state.report, frozen);
    assert.deepEqual(await readdir(join(h.board, "reports")), reports);
    assert.equal(await readFile(join(h.board, "report.md"), "utf8"), accepted);
    assert.equal(await reportText(h.state), accepted);
  } finally {
    h.close();
  }
});

test("the existing per-document UTF-8 limit still rejects oversized source documents", async () => {
  const h = await fixture();
  try {
    const document = "文".repeat(Math.floor(1_048_576 / 3) + 1);
    const path = join(h.directory, "design.md");
    await writeFile(path, document);
    h.state.plan.documentDelivery = { paths: ["design.md"], userRequest: "交付设计文档" };
    await assert.rejects(h.publish(), { code: "workflow_report", message: /交付文档过大/ });
    assert.equal(h.state.report?.id, undefined);
    assert.equal(await readFile(path, "utf8"), document);
    await assert.rejects(readdir(join(h.board, "reports")), { code: "ENOENT" });
  } finally {
    h.close();
  }
});

test("legacy text reports retain their publishing behavior without the new attachment limit", async () => {
  const h = await fixture(2);
  try {
    h.block.reportSections = { 结论: "x".repeat(REPORT_ATTACHMENT_MAX_BYTES) };
    await h.publish();
    assert.ok(Buffer.byteLength(await reportText(h.state)) > REPORT_ATTACHMENT_MAX_BYTES);
  } finally {
    h.close();
  }
});
