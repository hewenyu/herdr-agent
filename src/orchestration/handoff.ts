import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fail } from "../core/errors.js";
import { stableId } from "../core/ids.js";
import type { Task } from "../core/types.js";
import { atomicWrite } from "../storage/atomic.js";
import { parentHandoffPrompt } from "../tasks/parent-handoff.js";
import { boardDirectory } from "./board.js";
import { consensusDocuments, responseOutputs } from "./consensus.js";
import { rejectReceipt } from "./receipt-diagnostics.js";
import { receiptRepairRevision, type WorkflowRepair } from "./receipt-recovery.js";
import { parseStatusBlock, type StatusBlock, statusInstructions } from "./status-block.js";
import type { WorkflowNode, WorkflowState } from "./workflow.js";
import { workspaceRevision } from "./workspace.js";

export interface HandoffIdentity {
  nodeId: string;
  operationId: string;
  inputRevision: string;
}

export function handoffDirectory(stateDir: string, taskId: string, operationId: string): string {
  return join(boardDirectory(stateDir, taskId), "handoffs", stableId(operationId));
}

export async function checkedHandoffDirectory(
  stateDir: string,
  directory: string,
  create = false,
): Promise<void> {
  const root = await realpath(stateDir);
  const path = relative(resolve(stateDir), resolve(directory));
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    fail("workflow_handoff", "交接目录越界。");
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
  repair?: WorkflowRepair,
): Promise<string> {
  const directory = handoffDirectory(stateDir, task.id, identity.operationId);
  await checkedHandoffDirectory(stateDir, directory, true);
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
  const legacyBrief = [
    `# ${task.title} · ${node.purpose}`,
    "## 用户要求（原文和后续修订优先）",
    task.userRequest?.text ?? task.requirements,
    "## 任务说明",
    task.requirements,
    ...userMessages,
    ...(parentHandoffPrompt(task.parentContext)
      ? ["## 父讨论方案快照", parentHandoffPrompt(task.parentContext)]
      : []),
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
  const repairCurrent =
    repair?.recoverable &&
    repair.inputRevision === identity.inputRevision &&
    repair.planVersion === state.plan.version &&
    receiptRepairRevision(repair) === (await workspaceRevision(task.directories));
  let priorNotes: string | undefined;
  if (repairCurrent && repair.notes) {
    const expected = join(boardDirectory(stateDir, task.id), "recovery", repair.snapshotId);
    if (repair.notes.path === join(expected, "notes.md")) {
      const captured = await readHandoffFile(stateDir, expected, "notes.md");
      if (createHash("sha256").update(captured).digest("hex") !== repair.notes.hash)
        rejectReceipt(
          "workflow_handoff",
          "恢复材料快照变化，不能复用。",
          [{ field: "repair.notes", reason: "snapshot_changed" }],
          false,
        );
      priorNotes = captured;
    }
  }
  const example = {
    ...request,
    summary: "本轮实际结论；下列议题和证据仅为字段示例，请替换为真实内容",
    artifactRefs: [join(directory, "notes.md")],
    issues: [
      {
        id: "D-EXAMPLE",
        description: "具体待回应意见",
        status: "open",
        blocking: false,
        evidenceRefs: ["E-1"],
      },
    ],
    evidence: [{ id: "E-1", description: "已阅读本轮材料；未执行原型或测试", result: "not_run" }],
  };
  const brief = [
    legacyBrief,
    "## 回执字段示例（不是实际结果，不要复制示例议题）",
    `\`\`\`json\n${JSON.stringify(example, null, 2)}\n\`\`\``,
    "evidence 可选择填写本轮唯一别名 id（E-1、E-2 等），本回执的问题可以引用该别名；程序将其转换为稳定证据编号。已有证据使用看板 state.json 的 evidence.id；不能自造外部任务、输出或证据编号。未运行不能写 passed。",
    ...(repairCurrent
      ? [
          "## 本次仅修复交接与回执",
          "上一轮内容尚未通过协议校验，不代表意见被否定。本次只补全下列交接/回执错误，保留已有设计和真实分歧，不重做整轮设计，也不把未验证材料视为已经通过的结论。使用本轮 request.json 的归属字段。",
          ...repair.details.map(
            (detail) =>
              `${detail.field}: ${detail.reason}${detail.expected ? `；要求 ${detail.expected}` : ""}${detail.actual ? `；收到 ${detail.actual}` : ""}`,
          ),
          ...(priorNotes
            ? [
                `已保留上一轮未验证材料的受控副本 ${join(directory, "prior-notes.md")}。读取核对后可复制为本轮 ${join(directory, "notes.md")}，修正回执并在聊天引用本轮 notes.md 完整路径；不要再次生成同一份设计。`,
              ]
            : ["没有可安全复用的本轮材料快照；只补充缺失材料，不假定之前的内容已获接受。"]),
        ]
      : []),
  ].join("\n\n");
  // Existing dispatches keep their frozen brief/request across restarts.
  for (const [name, content] of [
    ["request.json", `${JSON.stringify(request, null, 2)}\n`],
    ["brief.md", brief],
    ...(priorNotes ? [["prior-notes.md", priorNotes]] : []),
  ]) {
    const path = join(directory, name as string);
    try {
      const existing = await readHandoffFile(stateDir, directory, name as string);
      if (existing !== content && !(name === "brief.md" && existing === legacyBrief))
        fail("workflow_handoff", "已冻结的任务书发生变化，不能复用原委派。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWrite(path, content as string);
    }
  }
  return `请读取本轮任务书 ${join(directory, "brief.md")}，按顺序回应上一位参与者并完成本轮工作。详细内容留在材料文件；聊天只给简短反馈及本轮 notes.md 的完整位置。回执按任务书写入独立文件，不在对话输出机器协议。`;
}

export async function readHandoffFile(
  stateDir: string,
  directory: string,
  name: string,
): Promise<string> {
  await checkedHandoffDirectory(stateDir, directory);
  const path = join(directory, name);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024)
    rejectReceipt(
      "workflow_handoff",
      "交接文件不是普通文件或超过读取上限。",
      [{ field: name, reason: metadata.size > 1024 * 1024 ? "oversized_file" : "unsafe_file" }],
      false,
    );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (before.ino !== metadata.ino || before.dev !== metadata.dev)
      rejectReceipt(
        "workflow_handoff",
        "交接文件读取期间发生变化。",
        [{ field: name, reason: "changed_during_read" }],
        false,
      );
    const content = await file.readFile("utf8");
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      content.length > 1024 * 1024
    )
      rejectReceipt(
        "workflow_handoff",
        "交接文件读取期间发生变化。",
        [{ field: name, reason: "changed_during_read" }],
        false,
      );
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
    rejectReceipt("workflow_handoff", "参与者交接缺少本轮材料位置，不能将无归属输出视为完成。", [
      {
        field: "output.notesPath",
        reason: "missing_current_path",
        expected: join(directory, "notes.md"),
      },
    ]);
  const required = async (name: string) => {
    try {
      return await readHandoffFile(stateDir, directory, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      rejectReceipt("workflow_handoff", `本轮交接缺少 ${name}。`, [
        { field: name, reason: "missing_file", expected: join(directory, name) },
      ]);
    }
  };
  const notes = await required("notes.md");
  if (!notes.trim())
    rejectReceipt("workflow_handoff", "本轮材料为空，不能推进任务。", [
      { field: "notes.md", reason: "empty_material" },
    ]);
  const raw = await required("result.json");
  const block = parseStatusBlock(`\`\`\`myrix-status\n${raw.trim()}\n\`\`\``, identity, {
    localEvidenceAliases: true,
  });
  if (node.phase === "reporting" && block.status === "completed") {
    const report = await required("report.md");
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
    if (Object.hasOwn(sections, title))
      rejectReceipt("workflow_report", "报告章节重复。", [
        {
          field: `report.md.sections[${JSON.stringify(title)}]`,
          reason: "duplicate_heading",
          expected: `仅保留一个 ## ${title} 章节，并合并真实内容。`,
        },
      ]);
    sections[title] = text
      .slice((match.index ?? 0) + match[0].length, headings[index + 1]?.index ?? text.length)
      .trim();
  }
  const missing = required.filter((title) => !sections[title]);
  if (missing.length)
    rejectReceipt(
      "workflow_report",
      "报告文件缺少必需章节正文。",
      missing.map((title) => ({
        field: `report.md.sections[${JSON.stringify(title)}]`,
        reason: Object.hasOwn(sections, title) ? "empty_section" : "missing_heading",
        expected: `## ${title} 下填写真实交付内容，未完成项明确说明；不能省略必需章节。`,
      })),
    );
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
