import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fail } from "../core/errors.js";
import { stableId } from "../core/ids.js";
import type { Task } from "../core/types.js";
import { atomicWrite } from "../storage/atomic.js";
import { independentReviewer } from "./authorship.js";
import { boardDirectory, inspectArtifact } from "./board.js";
import { codeDeliveryEvidence, codeDeliveryText } from "./code-delivery.js";
import type { StatusBlock } from "./status-block.js";
import type { WorkflowState } from "./workflow.js";

export const evidenceLabels = {
  self_report: "参与者自述",
  agent_review: "agent 复核",
  configured_command: "myrix 配置命令验证",
  not_run: "未运行",
};

export function reportContract(
  state: WorkflowState,
  artifactRevision: string,
  requiredCommands: string[],
  configRevision?: string,
): string[] {
  const missing: string[] = [];
  if (state.stall.awaitingUser) missing.push("僵局需要用户裁决");
  if (state.issues.some((issue) => issue.status === "open" && issue.blocking))
    missing.push("仍有未处理阻塞问题");
  if (state.plan.nodes.some((node) => state.nodes[node.id]?.status !== "completed"))
    missing.push("计划节点尚未完成");
  if (
    state.plan.nodes.some(
      (node) =>
        node.role === "reviewer" &&
        !independentReviewer(state, state.nodes[node.id]?.participantId),
    )
  )
    missing.push("评审必须由未参与本任务实现的独立参与者完成");
  for (const required of state.plan.requiredArtifacts ?? [])
    if (
      !state.artifacts.some(
        (artifact) =>
          artifact.artifactRevision === artifactRevision &&
          (artifact.reference === required || artifact.path === required),
      )
    )
      missing.push(`必需产物缺少本版本文件证据：${required}`);
  if (state.plan.template !== "discussion") {
    const current = state.evidence.filter((item) => item.artifactRevision === artifactRevision);
    const notRun = state.plan.validation?.mode === "not_run";
    for (const command of notRun ? [] : requiredCommands)
      if (
        !current.some(
          (item) =>
            item.source === "configured_command" &&
            item.command === command &&
            item.result === "passed" &&
            (!configRevision || item.configRevision === configRevision),
        )
      )
        missing.push(`配置命令缺少本版本成功证据：${command}`);
    if (
      !notRun &&
      !requiredCommands.length &&
      !current.some(
        (item) =>
          item.source === "agent_review" &&
          item.command &&
          item.result === "passed" &&
          independentReviewer(state, item.participantId),
      )
    )
      missing.push("缺少独立 agent 实际重跑的本版本证据");
    if (
      notRun &&
      !current.some(
        (item) =>
          item.source === "not_run" &&
          independentReviewer(state, item.participantId) &&
          state.plan.nodes.some(
            (node) =>
              node.phase === "validating" && state.nodes[node.id]?.outputId === item.outputId,
          ),
      )
    )
      missing.push("缺少独立复核者对未运行验证的说明");
    if (
      state.plan.nodes
        .filter((node) => node.role === "reviewer")
        .some((node) => state.nodes[node.id]?.artifactRevision !== artifactRevision)
    )
      missing.push("评审所对应的代码版本已变化");
  }
  if (!state.report || state.report.artifactRevision !== artifactRevision)
    missing.push("缺少本版本报告");
  return missing;
}

export async function publishReport(
  stateDir: string,
  task: Task,
  state: WorkflowState,
  block: StatusBlock,
  outputId: string,
  artifactRevision: string,
): Promise<void> {
  const sections = block.reportSections;
  if (!sections || state.plan.deliveryRequirements.some((name) => !sections[name]?.trim()))
    fail("workflow_report", "报告没有覆盖全部必需章节与验收项。");
  if (task.promptVersion === 3 && task.kind === "development")
    state.deliveryEvidence = await codeDeliveryEvidence(task);
  const documents: string[] = [];
  for (const path of state.plan.documentDelivery?.paths ?? []) {
    const artifact = await inspectArtifact(task, path);
    const text = await readFile(artifact.path, "utf8");
    if (
      Buffer.byteLength(text) > 1024 * 1024 ||
      createHash("sha256").update(text).digest("hex") !== artifact.hash
    )
      fail("workflow_report", "交付文档过大或读取期间变化，不能冻结报告。");
    const fence = "`".repeat(
      Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)),
    );
    documents.push(
      `## 交付文档：${path}`,
      `SHA-256：${artifact.hash}`,
      "",
      `${fence}markdown\n${text}\n${fence}`,
      "",
    );
  }
  const evidence = state.evidence.map(
    (entry) =>
      `- ${evidenceLabels[entry.source]} · ${entry.result}${entry.artifactRevision !== artifactRevision ? "（对应旧版本，当前无效）" : ""}：${entry.description}${entry.command ? `；命令：${entry.command}` : ""}`,
  );
  const text = [
    `# ${task.title}`,
    "",
    ...state.plan.deliveryRequirements.flatMap((name) => [
      `## ${name}`,
      "",
      sections[name] ?? "",
      "",
    ]),
    ...(state.deliveryEvidence
      ? ["## 代码交付位置", "", ...codeDeliveryText(state.deliveryEvidence), ""]
      : []),
    "## 验证来源与记录",
    "",
    ...(state.plan.validation?.mode === "not_run"
      ? [
          `验证未运行：${state.plan.validation.reason}。用户约束：${state.plan.validation.userConstraint}`,
          "",
        ]
      : []),
    ...(evidence.length ? evidence : ["本任务没有命令验证记录。"]),
    "",
    "## 保留问题",
    "",
    ...state.issues.map((issue) => `- ${issue.id} · ${issue.status}：${issue.description}`),
    "",
    ...documents,
    "报告交付不等于用户验收。",
    "",
  ].join("\n");
  const hash = createHash("sha256").update(text).digest("hex");
  const id = stableId(task.id, String(state.plan.version), artifactRevision, outputId, hash);
  const directory = boardDirectory(stateDir, task.id);
  const path = join(directory, "reports", id, "report.md");
  await atomicWrite(path, text);
  await atomicWrite(join(directory, "report.md"), text);
  state.report = { id, path, hash, outputId, artifactRevision };
}

export async function reportText(state: WorkflowState): Promise<string> {
  if (!state.report) fail("workflow_report", "缺少报告。");
  const text = await readFile(state.report.path, "utf8");
  if (createHash("sha256").update(text).digest("hex") !== state.report.hash)
    fail("workflow_report", "报告文件已变化，不能使用旧交付证据。");
  return text;
}

export function reportCard(task: Task, state: WorkflowState): Record<string, unknown> {
  const open = state.issues.filter((issue) => issue.status === "open");
  const summary = state.plan.nodes
    .filter((node) => node.phase === "reporting")
    .map((node) => state.nodes[node.id]?.summary)
    .filter(Boolean)
    .join("\n");
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: `${task.title} · 等待验收` } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            summary,
            `验收项：${state.plan.deliveryRequirements.join("、")}`,
            `验证来源：${[...new Set(state.evidence.map((item) => evidenceLabels[item.source]))].join("、") || "无命令验证"}`,
            `未决事项：${open.map((issue) => issue.description).join("；") || "无"}`,
            "完整报告已在本会话正文中发送。交付不代表已验收。",
          ].join("\n\n"),
        },
      ],
    },
  };
}
