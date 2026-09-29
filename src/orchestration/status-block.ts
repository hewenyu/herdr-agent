import { fail } from "../core/errors.js";
import type { WorkflowEvidence } from "./workflow.js";

export interface StatusBlock {
  protocolVersion: 1;
  nodeId: string;
  operationId: string;
  inputRevision: string;
  status: "completed" | "needs_work" | "blocked";
  summary: string;
  issues: Array<{
    id: string;
    description: string;
    status: "open" | "resolved" | "deferred";
    blocking: boolean;
    evidenceRefs: string[];
  }>;
  artifactRefs: string[];
  evidence: Array<{ description: string; command?: string; result: WorkflowEvidence["result"] }>;
  blockers: string[];
  reportSections?: Record<string, string>;
  responses?: Array<{ outputId: string; comment: string }>;
  consensus?: { approved: boolean; documents: Array<{ path: string; hash: string }> };
}

const blockPattern = /```myrix-status\s*\n([\s\S]*?)\n```/g;
export function visibleOutput(text: string): string {
  return text.replace(blockPattern, "").trim();
}

/** Routing hint only; a matching identifier still requires full validation. */
export function statusOperationId(text: string): string | undefined {
  const matches = [...text.matchAll(blockPattern)];
  if (matches.length !== 1) return;
  try {
    const value = JSON.parse(matches[0]?.[1] ?? "");
    return typeof value?.operationId === "string" ? value.operationId : undefined;
  } catch {
    return;
  }
}

export function parseStatusBlock(
  text: string,
  expected: { nodeId: string; operationId: string; inputRevision: string },
): StatusBlock {
  const matches = [...text.matchAll(blockPattern)];
  if (matches.length !== 1)
    fail("workflow_status", "参与者输出需要一个完整的 myrix-status 状态块。");
  let value: StatusBlock;
  try {
    value = JSON.parse(matches[0]?.[1] ?? "") as StatusBlock;
  } catch {
    fail("workflow_status", "状态块不是有效 JSON，原文已保留。");
  }
  const strings = (items: unknown): items is string[] =>
    Array.isArray(items) && items.every((item) => typeof item === "string");
  if (
    !value ||
    value.protocolVersion !== 1 ||
    value.nodeId !== expected.nodeId ||
    value.operationId !== expected.operationId ||
    value.inputRevision !== expected.inputRevision ||
    !["completed", "needs_work", "blocked"].includes(value.status) ||
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    !Array.isArray(value.issues) ||
    !strings(value.artifactRefs) ||
    !Array.isArray(value.evidence) ||
    !strings(value.blockers)
  )
    fail("workflow_status", "状态块版本、委派归属或字段无效，不能据此推进任务。");
  const ids = new Set<string>();
  if (
    value.responses !== undefined &&
    (!Array.isArray(value.responses) ||
      value.responses.some(
        (entry) =>
          !entry ||
          typeof entry.outputId !== "string" ||
          !entry.outputId ||
          typeof entry.comment !== "string" ||
          !entry.comment.trim(),
      ))
  )
    fail("workflow_response", "回应须填写实际前序输出编号和具体意见。");
  if (
    value.consensus !== undefined &&
    (!value.consensus ||
      typeof value.consensus.approved !== "boolean" ||
      !Array.isArray(value.consensus.documents) ||
      value.consensus.documents.some(
        (entry) =>
          !entry ||
          typeof entry.path !== "string" ||
          !entry.path ||
          typeof entry.hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.hash),
      ))
  )
    fail("workflow_consensus", "共同认可记录须包含批准结论和实际文件哈希。");
  for (const issue of value.issues) {
    if (
      !issue ||
      typeof issue.id !== "string" ||
      !/^[\w.-]{1,100}$/.test(issue.id) ||
      ids.has(issue.id) ||
      typeof issue.description !== "string" ||
      !issue.description.trim() ||
      !["open", "resolved", "deferred"].includes(issue.status) ||
      typeof issue.blocking !== "boolean" ||
      !strings(issue.evidenceRefs)
    )
      fail("workflow_status", "问题记录不完整或重复。");
    ids.add(issue.id);
  }
  for (const evidence of value.evidence) {
    if (
      !evidence ||
      typeof evidence.description !== "string" ||
      !evidence.description.trim() ||
      (evidence.command !== undefined &&
        (typeof evidence.command !== "string" || !evidence.command.trim())) ||
      !["passed", "failed", "not_run"].includes(evidence.result)
    )
      fail("workflow_status", "验证记录无效。");
  }
  if (
    value.reportSections !== undefined &&
    (!value.reportSections ||
      Array.isArray(value.reportSections) ||
      typeof value.reportSections !== "object" ||
      Object.values(value.reportSections).some((entry) => typeof entry !== "string"))
  )
    fail("workflow_status", "报告章节无效。");
  return value;
}

export function statusInstructions(expected: {
  nodeId: string;
  operationId: string;
  inputRevision: string;
}): string {
  return [
    "正文遵守用户要求的篇幅与格式。在末尾另附一个供 myrix 解析的状态块（不会当正文展示）：",
    "```myrix-status",
    JSON.stringify(
      {
        protocolVersion: 1,
        ...expected,
        status: "completed",
        summary: "本轮真实结果",
        issues: [],
        artifactRefs: [],
        evidence: [],
        blockers: [],
      },
      null,
      2,
    ),
    "```",
    "nodeId、operationId、inputRevision 必须逐字复制本轮模板中的值，不得从其他节点或历史回复拼接。",
    "issues 使用稳定 id、description、status(open/resolved/deferred)、blocking、evidenceRefs；回应已有问题保留其 id，不得仅改名。",
    "evidenceRefs 只填看板中已有的 outputId、evidence.id 或已登记产物 path；新产物路径须同时列入 artifactRefs 供实际采集。outputs/<id>.md 文件路径不等于 outputId。没有已登记引用时填 []，依据可写入 description。",
    "evidence 每项填写 description、实际 command（若运行）、result(passed/failed/not_run)。未运行不能写 passed。",
    '未执行命令时省略 command 字段，不要填写空字符串；例如未运行记录为 {"description":"用户要求只读讨论","result":"not_run"}。',
    "artifactRefs 仅填写实际产物文件路径。需要返工用 needs_work；只能由用户决定/授权的阻塞用 blocked 并填 blockers。",
    "报告节点额外填 reportSections，键为任务书给出的全部必需章节名，值为对应报告正文。状态块不是验收或新授权。",
  ].join("\n");
}
