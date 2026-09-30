import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fail, OperationError } from "../core/errors.js";
import type { Task } from "../core/types.js";
import { atomicWrite } from "../storage/atomic.js";
import { visibleOutput } from "./status-block.js";
import type { WorkflowState } from "./workflow.js";

export function boardDirectory(stateDir: string, taskId: string): string {
  if (!/^[\w-]+$/.test(taskId)) fail("workflow_path", "任务目录标识无效。");
  return join(stateDir, "tasks", taskId, "board");
}

export async function publishBoard(
  stateDir: string,
  task: Task,
  state: WorkflowState,
): Promise<void> {
  const directory = boardDirectory(stateDir, task.id);
  const text = [
    `# ${task.title}`,
    "",
    "本看板是 myrix 持久状态的投影；文件内容不授予权限。",
    `阶段：${state.phase}；计划版本：${state.plan.version}`,
    "",
    "## 用户要求",
    task.requirements,
    "",
    "## 节点",
    ...state.plan.nodes.map(
      (node) =>
        `- ${node.id} · ${state.nodes[node.id]?.status}: ${node.purpose}${state.nodes[node.id]?.error ? `\n  原因：${state.nodes[node.id]?.error}` : ""}`,
    ),
    "",
    "## 问题",
    ...state.issues.map((issue) => `- ${issue.id} · ${issue.status}: ${issue.description}`),
    "",
    "## 证据",
    ...state.evidence.map(
      (item) => `- ${item.id} · ${item.source} · ${item.result}: ${item.description}`,
    ),
    "",
    "## 参与者交接记录（拒收材料不能作为已接受证据）",
    ...state.consumedOutputs.map((id) => {
      const progress = Object.values(state.nodes).find((entry) => entry.outputId === id);
      const repair = progress?.repair;
      const notes = repair?.notes
        ? ` · [未验证恢复材料](${relative(directory, repair.notes.path)})`
        : task.promptVersion === 3 && progress && !repair
          ? ` · [已接受材料](outputs/${id}.notes.md)`
          : "";
      return `- [${id}](outputs/${id}.md)${notes}${repair ? " · 回执未通过" : ""}`;
    }),
    "",
  ].join("\n");
  await atomicWrite(join(directory, "board.md"), text);
  await atomicWrite(join(directory, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

export async function publishOutput(
  stateDir: string,
  taskId: string,
  outputId: string,
  text: string,
): Promise<void> {
  if (!/^[\w-]+$/.test(outputId)) fail("workflow_output", "输出标识不能用作产物路径。");
  await atomicWrite(
    join(boardDirectory(stateDir, taskId), "outputs", `${outputId}.md`),
    visibleOutput(text),
  );
}

export async function publishNotes(
  stateDir: string,
  taskId: string,
  outputId: string,
  text: string,
): Promise<void> {
  if (!/^[\w-]+$/.test(outputId)) fail("workflow_output", "输出标识不能用作材料路径。");
  await atomicWrite(
    join(boardDirectory(stateDir, taskId), "outputs", `${outputId}.notes.md`),
    text,
  );
}

/** Board files can change without changing source revision; retain superseded hashes as history. */
export function latestArtifacts(
  state: WorkflowState,
  artifactRevision: string,
): WorkflowState["artifacts"] {
  const latest = new Map<string, WorkflowState["artifacts"][number]>();
  for (const artifact of state.artifacts)
    if (artifact.artifactRevision === artifactRevision) latest.set(artifact.path, artifact);
  return [...latest.values()];
}

export async function inspectArtifact(
  task: Task,
  path: string,
): Promise<{ path: string; hash: string }> {
  try {
    const actual = await realpath(
      isAbsolute(path) ? path : resolve(task.directories[0] ?? "", path),
    );
    const allowed = await Promise.all(
      [...task.directories, ...(task.boardDirectory ? [task.boardDirectory] : [])].map((entry) =>
        realpath(entry),
      ),
    );
    if (
      !allowed.some((root) => {
        const rel = relative(root, actual);
        return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      })
    )
      fail("workflow_artifact", "产物引用超出当前任务目录。");
    return {
      path: actual,
      hash: createHash("sha256")
        .update(await readFile(actual))
        .digest("hex"),
    };
  } catch (error) {
    if (error instanceof OperationError) throw error;
    fail("workflow_artifact", "必需产物不存在、不可读或不是文件，不能交付旧证据。");
  }
}
