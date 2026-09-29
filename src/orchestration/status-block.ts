import { stableId } from "../core/ids.js";
import { type ReceiptDiagnostic, rejectReceipt } from "./receipt-diagnostics.js";
import type { WorkflowEvidence, WorkflowState } from "./workflow.js";

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
  evidence: Array<{
    id?: string;
    description: string;
    command?: string;
    result: WorkflowEvidence["result"];
  }>;
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
  options: { localEvidenceAliases?: boolean } = {},
): StatusBlock {
  const matches = [...text.matchAll(blockPattern)];
  if (matches.length !== 1)
    rejectReceipt("workflow_status", "参与者输出需要一个完整的 myrix-status 状态块。", [
      { field: "$", reason: "block_count", expected: "1", actual: String(matches.length) },
    ]);
  let value: StatusBlock;
  try {
    value = JSON.parse(matches[0]?.[1] ?? "") as StatusBlock;
  } catch {
    rejectReceipt("workflow_status", "状态块不是有效 JSON，原文已保留。", [
      { field: "$", reason: "invalid_json" },
    ]);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    rejectReceipt("workflow_status", "回执必须是 JSON 对象。", [
      { field: "$", reason: "expected_object" },
    ]);
  const details: ReceiptDiagnostic[] = [];
  const check = (ok: boolean, field: string, expected: string, actual: unknown) => {
    if (!ok)
      details.push({
        field,
        reason: "invalid_field",
        expected,
        actual: actual === undefined ? "missing" : JSON.stringify(actual).slice(0, 240),
      });
  };
  for (const field of ["nodeId", "operationId", "inputRevision"] as const)
    check(value[field] === expected[field], field, expected[field], value[field]);
  if (details.length)
    rejectReceipt(
      "workflow_status",
      "状态块回执归属不匹配，不能作为当前委派的结果。",
      details,
      false,
    );
  const hasText = (item: unknown): item is string => typeof item === "string" && !!item.trim();
  const strings = (items: unknown): items is string[] =>
    Array.isArray(items) && items.every((item) => typeof item === "string");
  check(value.protocolVersion === 1, "protocolVersion", "1", value.protocolVersion);
  check(
    ["completed", "needs_work", "blocked"].includes(value.status),
    "status",
    "completed/needs_work/blocked",
    value.status,
  );
  check(hasText(value.summary), "summary", "非空字符串", value.summary);
  check(Array.isArray(value.issues), "issues", "数组", value.issues);
  check(strings(value.artifactRefs), "artifactRefs", "字符串数组", value.artifactRefs);
  check(Array.isArray(value.evidence), "evidence", "数组", value.evidence);
  check(strings(value.blockers), "blockers", "字符串数组", value.blockers);
  const ids = new Set<string>();
  for (const [index, issue] of (Array.isArray(value.issues) ? value.issues : []).entries()) {
    const field = `issues[${index}]`;
    if (!issue || typeof issue !== "object") {
      check(false, field, "问题对象", issue);
      continue;
    }
    check(
      typeof issue.id === "string" && /^[\w.-]{1,100}$/.test(issue.id) && !ids.has(issue.id),
      `${field}.id`,
      "唯一稳定问题编号",
      issue.id,
    );
    ids.add(issue.id);
    check(
      hasText(issue.description),
      `${field}.description`,
      "非空字符串；不使用 summary",
      issue.description,
    );
    check(
      ["open", "resolved", "deferred"].includes(issue.status),
      `${field}.status`,
      "open/resolved/deferred",
      issue.status,
    );
    check(typeof issue.blocking === "boolean", `${field}.blocking`, "布尔值", issue.blocking);
    check(strings(issue.evidenceRefs), `${field}.evidenceRefs`, "字符串数组", issue.evidenceRefs);
  }
  const aliases = new Set<string>();
  for (const [index, evidence] of (Array.isArray(value.evidence) ? value.evidence : []).entries()) {
    const field = `evidence[${index}]`;
    if (!evidence || typeof evidence !== "object") {
      check(false, field, "证据对象", evidence);
      continue;
    }
    if (options.localEvidenceAliases && evidence.id !== undefined) {
      check(
        typeof evidence.id === "string" &&
          /^E-[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/.test(evidence.id) &&
          !aliases.has(evidence.id),
        `${field}.id`,
        "唯一的本轮别名 E-1、E-2 等；不能使用外部输出或证据编号",
        evidence.id,
      );
      aliases.add(evidence.id);
    }
    check(
      hasText(evidence.description),
      `${field}.description`,
      "非空字符串；不使用 summary",
      evidence.description,
    );
    check(
      evidence.command === undefined || hasText(evidence.command),
      `${field}.command`,
      "实际命令或省略字段",
      evidence.command,
    );
    check(
      ["passed", "failed", "not_run"].includes(evidence.result),
      `${field}.result`,
      "passed/failed/not_run；不使用 status",
      evidence.result,
    );
  }
  if (details.length)
    rejectReceipt(
      "workflow_status",
      `回执字段不完整或格式无效：${details.map((item) => item.field).join("、")}`,
      details,
    );
  if (value.responses !== undefined) {
    check(Array.isArray(value.responses), "responses", "数组", value.responses);
    for (const [index, response] of (Array.isArray(value.responses)
      ? value.responses
      : []
    ).entries()) {
      check(
        !!response && hasText(response.outputId),
        `responses[${index}].outputId`,
        "实际前序输出编号",
        response?.outputId,
      );
      check(
        !!response && hasText(response.comment),
        `responses[${index}].comment`,
        "具体回应意见",
        response?.comment,
      );
    }
    if (details.length)
      rejectReceipt("workflow_response", "回应须填写实际前序输出编号和具体意见。", details);
  }
  if (
    value.consensus !== undefined &&
    (!value.consensus ||
      typeof value.consensus.approved !== "boolean" ||
      !Array.isArray(value.consensus.documents) ||
      value.consensus.documents.some(
        (entry) =>
          !entry ||
          !hasText(entry.path) ||
          typeof entry.hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.hash),
      ))
  )
    rejectReceipt(
      "workflow_consensus",
      "共同认可记录须包含批准结论和实际文件哈希。",
      [{ field: "consensus", reason: "invalid_confirmation" }],
      false,
    );
  if (
    value.reportSections !== undefined &&
    (!value.reportSections ||
      Array.isArray(value.reportSections) ||
      typeof value.reportSections !== "object" ||
      Object.values(value.reportSections).some((entry) => typeof entry !== "string"))
  )
    rejectReceipt("workflow_status", "报告章节无效。", [
      { field: "reportSections", reason: "expected_string_map" },
    ]);
  return value;
}

/** Resolve only local aliases declared in this exact, schema-validated receipt. */
export function bindEvidenceReferences(
  state: WorkflowState,
  block: StatusBlock,
  outputId: string,
  options: { localEvidenceAliases?: boolean } = {},
): void {
  const valid = new Set([
    ...state.consumedOutputs,
    outputId,
    ...state.evidence.map((entry) => entry.id),
    ...state.artifacts.map((entry) => entry.path),
    ...block.artifactRefs,
  ]);
  const aliases = new Map<string, string>();
  for (const [index, entry] of block.evidence.entries()) {
    if (!options.localEvidenceAliases || entry.id === undefined) continue;
    if (
      !/^E-[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/.test(entry.id) ||
      aliases.has(entry.id) ||
      valid.has(entry.id)
    )
      rejectReceipt("workflow_evidence", "本轮证据别名重复或与已登记引用冲突。", [
        { field: `evidence[${index}].id`, reason: "ambiguous_alias", actual: entry.id },
      ]);
    aliases.set(entry.id, stableId(outputId, String(index)));
  }
  const invalid: ReceiptDiagnostic[] = [];
  for (const [index, issue] of block.issues.entries())
    for (const reference of issue.evidenceRefs)
      if (!valid.has(reference) && !aliases.has(reference))
        invalid.push({
          field: `issues[${index}].evidenceRefs`,
          reason: "unknown_reference",
          actual: reference,
        });
  if (invalid.length)
    rejectReceipt(
      "workflow_evidence",
      `问题引用了不存在或不属于本任务的证据：${invalid.map((item) => item.actual).join("、")}`,
      invalid,
    );
  for (const issue of block.issues)
    issue.evidenceRefs = issue.evidenceRefs.map((reference) => aliases.get(reference) ?? reference);
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
