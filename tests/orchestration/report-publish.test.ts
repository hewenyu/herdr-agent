import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { REPORT_ATTACHMENT_MAX_BYTES } from "../../src/core/report-limits.js";
import { boardDirectory } from "../../src/orchestration/board.js";
import { publishReport, reportText } from "../../src/orchestration/report.js";
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
