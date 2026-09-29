import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fail } from "../core/errors.js";
import { stableId } from "../core/ids.js";
import type { Task } from "../core/types.js";
import { atomicWrite } from "../storage/atomic.js";
import { boardDirectory } from "./board.js";
import { consensusDocuments, responseOutputs } from "./consensus.js";
import { parseStatusBlock, type StatusBlock, statusInstructions } from "./status-block.js";
import type { WorkflowNode, WorkflowState } from "./workflow.js";

export interface HandoffIdentity {
  nodeId: string;
  operationId: string;
  inputRevision: string;
}

export function handoffDirectory(stateDir: string, taskId: string, operationId: string): string {
  return join(boardDirectory(stateDir, taskId), "handoffs", stableId(operationId));
}

async function checkedDirectory(
  stateDir: string,
  directory: string,
  create = false,
): Promise<void> {
  const root = await realpath(stateDir);
  const path = relative(resolve(stateDir), resolve(directory));
  if (path.startsWith("..") || isAbsolute(path)) fail("workflow_handoff", "交接目录越界。");
  let current = root;
  for (const part of path.split(sep)) {
    current = join(current, part);
    if (create)
      await mkdir(current, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      fail("workflow_handoff", "交接目录不能包含符号链接。");
  }
}

/** Protocol data stays in operation-specific files, never in conversation prose. */
export async function prepareHandoff(
  stateDir: string,
  task: Task,
  state: WorkflowState,
  node: WorkflowNode,
  identity: HandoffIdentity,
  userMessages: string[],
): Promise<string> {
  const directory = handoffDirectory(stateDir, task.id, identity.operationId);
  await checkedDirectory(stateDir, directory, true);
  const request = {
    protocolVersion: 1,
    ...identity,
    status: "completed",
    summary: "替换为本轮简短真实结论",
    issues: [],
    artifactRefs: [],
    evidence: [],
    blockers: [],
    ...(state.plan.consensus
      ? { responses: responseOutputs(state, node).map((outputId) => ({ outputId, comment: "" })) }
      : {}),
    ...(node.consensus
      ? { consensus: { approved: false, documents: await consensusDocuments(task, state) } }
      : {}),
  };
  const brief = [
    `# ${task.title} · ${node.purpose}`,
    "## 用户要求（原文和后续修订优先）",
    task.userRequest?.text ?? task.requirements,
    "## 任务说明",
    task.requirements,
    ...userMessages,
    "## 本轮工作",
    node.instruction,
    `必需交付文件：${state.plan.requiredArtifacts?.join("、") || "本轮材料及最终报告"}。只引用实际存在的文件。`,
    ...(node.documentPaths?.length
      ? [`仅允许修改这些项目文档：${node.documentPaths.join("、")}。其他项目文件保持不变。`]
      : node.access === "read"
        ? ["本轮读取项目并分析，不修改项目文件。任务材料和回执写入本轮交接目录。"]
        : []),
    ...(state.plan.validation?.mode === "not_run"
      ? [`用户禁止运行验证：${state.plan.validation.userConstraint}。记录未运行的原因。`]
      : []),
    "## 讨论和交接",
    `先读取 ${join(boardDirectory(stateDir, task.id), "board.md")} 及相关 outputs 材料。outputs/<输出编号>.notes.md 是已采集的完整材料快照，优先于原交接路径；逐项回应上一位参与者，保留实际分歧。`,
    `将本轮详细分析写入 ${join(directory, "notes.md")}。聊天简短说明结果、需要对方回应的事项，并附该 notes.md 的完整路径或 Markdown 链接，供程序绑定本轮输出。不要在聊天粘贴全文、JSON、协议或重复任务书。`,
    "## 独立回执（只写文件，不粘贴到对话）",
    `读取 ${join(directory, "request.json")}，复制为 ${join(directory, "result.json")} 并填写真实结果；保留三个归属字段。只在全部工作结束后保存回执，再发自然语言交接。`,
    "status 只用 completed/needs_work/blocked；summary 写简短结论；artifactRefs 列出实际交付文件；issues 每项填写 id、description、status(open/resolved/deferred)、blocking(布尔)、evidenceRefs(字符串数组)。保留稳定问题编号，不得遗漏未决分歧。",
    "evidence 每项包含 description、result(passed/failed/not_run)，实际运行命令才填 command。问题引用 evidenceRefs 只用看板已有 outputId、evidence.id 或 artifactRefs 中的路径。blockers 仅列真实阻塞。",
    ...(state.plan.consensus
      ? [
          "responses 逐项填写 request.json 所列前序 outputId 与你的具体回应 comment，必须读取对应 outputs/<outputId>.notes.md；不能只声明轮到自己。",
        ]
      : []),
    ...(node.consensus
      ? [
          "共同认可：读取最终项目文档并核对 request.json 的文件哈希。认可全部结论时将 consensus.approved 设为 true；有异议时保留 false，status=needs_work，填写具体 issues。该确认只代表你本人意见，不等于用户验收。",
        ]
      : []),
    ...(node.phase === "reporting"
      ? [
          `另写 ${join(directory, "report.md")}，用下列精确二级标题覆盖各交付项：\n${state.plan.deliveryRequirements.map((title) => `## ${title}`).join("\n")}\n报告写完整内容，result.json 不重复报告正文。实际文档未落盘或对方未复核时，不能标记完成。`,
        ]
      : []),
  ].join("\n\n");
  // Existing dispatches keep their frozen brief/request across restarts.
  for (const [name, content] of [
    ["request.json", `${JSON.stringify(request, null, 2)}\n`],
    ["brief.md", brief],
  ]) {
    const path = join(directory, name as string);
    try {
      const existing = await readHandoffFile(stateDir, directory, name as string);
      if (existing !== content)
        fail("workflow_handoff", "已冻结的任务书发生变化，不能复用原委派。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWrite(path, content as string);
    }
  }
  return `请读取本轮任务书 ${join(directory, "brief.md")}，按顺序回应上一位参与者并完成本轮工作。详细内容留在材料文件；聊天只给简短反馈及本轮 notes.md 的完整位置。回执按任务书写入独立文件，不在对话输出机器协议。`;
}

async function readHandoffFile(stateDir: string, directory: string, name: string): Promise<string> {
  await checkedDirectory(stateDir, directory);
  const path = join(directory, name);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024)
    fail("workflow_handoff", "交接文件不是普通文件或超过读取上限。");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (before.ino !== metadata.ino || before.dev !== metadata.dev)
      fail("workflow_handoff", "交接文件读取期间发生变化。");
    const content = await file.readFile("utf8");
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      content.length > 1024 * 1024
    )
      fail("workflow_handoff", "交接文件读取期间发生变化。");
    return content;
  } finally {
    await file.close();
  }
}

export async function handoffNotes(
  stateDir: string,
  taskId: string,
  operationId: string,
): Promise<string> {
  return readHandoffFile(stateDir, handoffDirectory(stateDir, taskId, operationId), "notes.md");
}

export async function readHandoff(
  stateDir: string,
  task: Task,
  state: WorkflowState,
  node: WorkflowNode,
  identity: HandoffIdentity,
  output: string,
): Promise<StatusBlock & { capturedNotes: { text: string; hash: string } }> {
  const directory = handoffDirectory(stateDir, task.id, identity.operationId);
  if (!output.includes(join(directory, "notes.md")))
    fail("workflow_handoff", "参与者交接缺少本轮材料位置，不能将无归属输出视为完成。");
  const notes = await readHandoffFile(stateDir, directory, "notes.md");
  if (!notes.trim()) fail("workflow_handoff", "本轮材料为空，不能推进任务。");
  const raw = await readHandoffFile(stateDir, directory, "result.json");
  const block = parseStatusBlock(`\`\`\`myrix-status\n${raw.trim()}\n\`\`\``, identity);
  if (node.phase === "reporting" && block.status === "completed") {
    const report = await readHandoffFile(stateDir, directory, "report.md");
    block.reportSections = reportSections(report, state.plan.deliveryRequirements);
  }
  return Object.assign(block, {
    capturedNotes: { text: notes, hash: createHash("sha256").update(notes).digest("hex") },
  });
}

export function reportSections(text: string, required: string[]): Record<string, string> {
  const sections: Record<string, string> = Object.create(null);
  const headings = [...text.matchAll(/^## ([^\n]+)\r?$/gm)];
  for (const [index, match] of headings.entries()) {
    const title = match[1]?.trim() ?? "";
    if (Object.hasOwn(sections, title)) fail("workflow_report", "报告章节重复。");
    sections[title] = text
      .slice((match.index ?? 0) + match[0].length, headings[index + 1]?.index ?? text.length)
      .trim();
  }
  if (required.some((title) => !sections[title]))
    fail("workflow_report", "报告文件缺少必需章节正文。");
  return sections;
}

export function legacyAssignment(
  task: Task,
  state: WorkflowState,
  node: WorkflowNode,
  identity: HandoffIdentity,
  userMessages: string[],
): string {
  return [
    "本次工作流任务书（原始要求和后续修订优先）：",
    task.requirements,
    ...userMessages,
    `节点：${node.id}；阶段：${node.phase}`,
    node.instruction,
    `必需交付文件：${JSON.stringify(state.plan.requiredArtifacts ?? [])}。相关节点须在 artifactRefs 中引用准确路径；报告不能以文字替代缺失文件。`,
    ...(state.plan.validation?.mode === "not_run"
      ? [
          `用户已明确限制验证：${state.plan.validation.userConstraint}。不得执行验证命令；实现节点仍按授权实现，评审节点只作只读复核并将验证证据标记 not_run、说明原因。`,
        ]
      : []),
    `共享看板：${task.boardDirectory}。完整参与者原文位于 outputs/，请阅读与本节点相关的输入，不能仅依据摘要。`,
    `当前问题与已完成节点：${JSON.stringify({ issues: state.issues, nodes: state.nodes })}`,
    ...(node.phase === "reporting"
      ? [`报告必需章节：${JSON.stringify(state.plan.deliveryRequirements)}`]
      : []),
    statusInstructions(identity),
  ].join("\n\n");
}
