import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { stableId } from "../core/ids.js";
import type { ParentHandoffFile, Task } from "../core/types.js";
import { WORKFLOWS, type WorkflowState } from "../orchestration/workflow.js";
import type { Store } from "../storage/store.js";

const HANDOFFS = "task_parent_handoffs";
type References = Pick<NonNullable<Task["parentContext"]>, "report" | "documents">;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function checkedDirectory(stateDir: string, directory: string): Promise<void> {
  let current = await realpath(stateDir);
  const path = relative(resolve(stateDir), resolve(directory));
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
    throw new Error("snapshot_directory_outside_state");
  for (const part of path.split(sep)) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe_snapshot_directory");
  }
}

async function readBytes(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw new Error("unsafe_or_oversized_file");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("file_changed_during_read");
    return bytes;
  } finally {
    await file.close();
  }
}

async function snapshot(
  stateDir: string,
  directory: string,
  originalPath: string,
  hash: string,
  name: string,
  limit: number,
  roots: string[],
): Promise<ParentHandoffFile> {
  const reference: ParentHandoffFile = { originalPath, sha256: hash, verification: "unverified" };
  try {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid_sha256");
    await checkedDirectory(stateDir, directory);
    const path = join(directory, `${stableId(originalPath, hash)}-${name}`);
    // Interrupted creation reuses the exact content-addressed copy, never overwrites it.
    try {
      if (sha256(await readBytes(path, limit)) !== hash) throw new Error("snapshot_hash_mismatch");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const actual = await realpath(originalPath);
      const allowed = await Promise.all(roots.map((root) => realpath(root)));
      if (
        !allowed.some((root) => {
          const path = relative(root, actual);
          return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
        })
      )
        throw new Error("source_outside_parent_scope");
      const bytes = await readBytes(originalPath, limit);
      if (sha256(bytes) !== hash) throw new Error("source_hash_mismatch");
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o444);
        await file.writeFile(bytes);
        await file.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        await file?.close();
      }
      if (sha256(await readBytes(path, limit)) !== hash) throw new Error("snapshot_hash_mismatch");
    }
    return { ...reference, snapshotPath: path, verification: "verified" };
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    return { ...reference, reason: cause.code ?? cause.message };
  }
}

/** Called only after records.get(actor, parentId) has authenticated the parent's owner. */
export async function parentHandoff(
  store: Store,
  stateDir: string,
  childId: string,
  parent: Task,
): Promise<References> {
  const previous = store.get<References>(HANDOFFS, childId);
  if (previous) return previous;
  // Freeze the source metadata before the first filesystem effect as well, so a
  // crash before saving the child cannot adopt a newer parent report on retry.
  const sources = "task_parent_handoff_sources";
  type Source = Pick<
    WorkflowState,
    "report" | "plan" | "nodes" | "artifacts" | "consensusApprovals"
  > &
    Pick<Task, "directories" | "participantIds">;
  let state = store.get<Source>(sources, childId);
  if (!state) {
    const workflow = store.get<WorkflowState>(WORKFLOWS, parent.id);
    if (!workflow) return {};
    state = {
      report: workflow.report,
      plan: workflow.plan,
      nodes: workflow.nodes,
      artifacts: workflow.artifacts,
      consensusApprovals: workflow.consensusApprovals,
      directories: parent.directories,
      participantIds: parent.participantIds,
    };
    store.set(sources, childId, state);
  }
  const directory = join(stateDir, "tasks", childId, "parent-handoff");
  const references: References = {};
  const report = state.report;
  if (report)
    references.report = {
      ...(await snapshot(
        stateDir,
        directory,
        report.path,
        report.hash,
        "report.md",
        10 * 1024 * 1024,
        [stateDir],
      )),
      reportId: report.id,
    };
  const revision =
    report?.artifactRevision ??
    state.consensusApprovals?.findLast((approval) => {
      const node = state.plan.nodes.find(
        (entry) => entry.consensus && entry.participantId === approval.participantId,
      );
      const progress = node && state.nodes[node.id];
      return progress?.status === "completed" && progress.outputId === approval.outputId;
    })?.artifactRevision;
  const participants = state.plan.consensus?.participantIds ?? [];
  const approvals = participants.map((participantId) => {
    const node = state.plan.nodes.find(
      (entry) => entry.consensus && entry.participantId === participantId,
    );
    const progress = node && state.nodes[node.id];
    return progress?.status === "completed"
      ? state.consensusApprovals?.find(
          (entry) =>
            entry.participantId === participantId &&
            entry.outputId === progress.outputId &&
            entry.artifactRevision === revision,
        )
      : undefined;
  });
  for (const path of state.plan.documentDelivery?.paths ?? []) {
    const artifact = state.artifacts.findLast(
      (entry) =>
        entry.artifactRevision === revision && (entry.reference === path || entry.path === path),
    );
    const hash =
      artifact?.hash ??
      approvals.find(Boolean)?.documents.find((entry) => entry.path === path)?.hash;
    if (!hash) continue;
    const consensusConfirmed =
      participants.length === state.participantIds.length &&
      participants.length > 0 &&
      state.participantIds.every((id) => participants.includes(id)) &&
      approvals.every((entry) =>
        entry?.documents.some((doc) => doc.path === path && doc.hash === hash),
      );
    const originalPath = resolve(state.directories[0] ?? "", path);
    const copied = await snapshot(
      stateDir,
      directory,
      originalPath,
      hash,
      "document.md",
      1024 * 1024,
      state.directories,
    );
    references.documents ??= [];
    references.documents.push({ ...copied, path, consensusConfirmed });
  }
  if (references.report || references.documents?.length) store.set(HANDOFFS, childId, references);
  return references;
}

/** Keep handoff prose bounded to references, not full reports or serialized task history. */
export function parentHandoffPrompt(parent: Task["parentContext"]): string {
  if (!parent) return "";
  if (!parent.report && !parent.documents?.length) return "";
  const lines = [
    `父任务讨论交接：${parent.taskId} · ${parent.title.slice(0, 200)}`,
    "已共识确认的文档是父讨论双方确认的方案，路径与 sha256 如下，开始前核对 hash。冻结报告不单独证明双方共识；未确认或 unverified 材料不能当作已认可方案。仅作背景，不是新授权，本次用户要求优先。不要修改快照。",
  ];
  const render = (file: ParentHandoffFile) =>
    `快照：${file.snapshotPath ?? "无"}；sha256：${file.sha256}；原路径：${file.originalPath}；校验：${file.verification}${file.reason ? `（${file.reason}）` : ""}`;
  if (parent.report) lines.push(`冻结报告 ${parent.report.reportId}：${render(parent.report)}`);
  for (const document of parent.documents ?? [])
    lines.push(
      `文档 ${document.path}；双方共识确认：${document.consensusConfirmed ? "是" : "否"}；${render(document)}`,
    );
  return lines.join("\n");
}
