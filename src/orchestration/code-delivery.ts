import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { fail } from "../core/errors.js";
import type { Task } from "../core/types.js";
import type { WorkflowState } from "./workflow.js";

const execute = promisify(execFile);
export interface CodeDeliveryEvidence {
  observedAt: string;
  repositories: Array<{
    directory: string;
    branch?: string;
    commit?: string;
    dirty?: boolean;
    statusRevision?: string;
    indexRevision?: string;
    upstream?: string;
    pr?: { url: string; headCommit: string };
    error?: string;
  }>;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Stable across timestamps and JSON persistence; includes facts not visible in report prose. */
export function codeDeliveryRevision(evidence: CodeDeliveryEvidence): string {
  return hash(
    JSON.stringify(
      evidence.repositories.map((entry) => [
        entry.directory,
        entry.branch ?? null,
        entry.commit ?? null,
        entry.dirty ?? null,
        entry.statusRevision ?? null,
        entry.indexRevision ?? null,
        entry.upstream ?? null,
        entry.pr?.url ?? null,
        entry.pr?.headCommit ?? null,
        entry.error ?? null,
      ]),
    ),
  );
}

/** Never attach today's coordinates to an already frozen report. */
export async function assertCodeDelivery(task: Task, state: WorkflowState): Promise<void> {
  if (task.promptVersion !== 3 || task.kind !== "development") return;
  const revision = state.report?.deliveryRevision;
  if (
    !revision ||
    !state.deliveryEvidence ||
    codeDeliveryRevision(state.deliveryEvidence) !== revision
  )
    fail("workflow_report", "报告缺少匹配的冻结 Git 交付证据，请重新生成报告。");
  if (codeDeliveryRevision(await codeDeliveryEvidence(task)) !== revision)
    fail("workflow_report", "Git 分支、提交、索引或交付位置已变化，请重新生成报告。");
}

/** Read actual Git facts. A model-reported branch or URL is not a delivery receipt. */
export async function codeDeliveryEvidence(task: Task): Promise<CodeDeliveryEvidence> {
  const repositories: CodeDeliveryEvidence["repositories"] = [];
  for (const directory of task.directories) {
    const git = async (...args: string[]) =>
      (
        await execute("git", ["-C", directory, ...args], {
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    const snapshot = async () => {
      const commit = (await git("rev-parse", "HEAD")).trim();
      const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD")
        .then((value) => value.trim())
        .catch(() => "detached HEAD");
      // Do not trim porcelain: leading spaces distinguish unstaged and staged changes.
      const status = await git("status", "--porcelain=v1", "-z", "--untracked-files=normal");
      const index = await git("ls-files", "--stage", "-z");
      const upstream = await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
        .then((value) => value.trim())
        .catch(() => undefined);
      return {
        commit,
        branch,
        dirty: !!status,
        statusRevision: hash(status),
        indexRevision: hash(index),
        upstream,
      };
    };
    const entry: CodeDeliveryEvidence["repositories"][number] = { directory };
    try {
      const before = await snapshot();
      Object.assign(entry, before);
      try {
        const { stdout } = await execute(
          "gh",
          ["pr", "view", "--json", "url,headRefOid,headRefName"],
          {
            cwd: directory,
            timeout: 10_000,
            maxBuffer: 16 * 1024,
          },
        );
        const pr = JSON.parse(stdout);
        if (
          pr.headRefOid === before.commit &&
          pr.headRefName === entry.branch &&
          typeof pr.url === "string" &&
          /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pr.url)
        )
          entry.pr = { url: pr.url, headCommit: before.commit };
      } catch {
        /* A missing/unavailable PR is explicitly not certified. */
      }
      const after = await snapshot();
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        entry.error =
          before.commit !== after.commit
            ? "采集期间提交发生变化，交付位置未确认"
            : "采集期间 Git 分支、索引或工作区状态发生变化，交付位置未确认";
        entry.pr = undefined;
      }
    } catch {
      entry.error = "当前目录没有可核验的 Git 提交，分支及提交状态未确认";
    }
    repositories.push(entry);
  }
  return { observedAt: new Date().toISOString(), repositories };
}

export function codeDeliveryText(evidence: CodeDeliveryEvidence): string[] {
  return evidence.repositories.flatMap((entry) => [
    `- 目录：${entry.directory}`,
    `  分支：${entry.branch ?? "未确认"}；提交：${entry.commit ?? "未确认"}`,
    `  工作区：${entry.dirty === undefined ? "未确认" : entry.dirty ? "仍有未提交修改" : "干净"}；跟踪分支：${entry.upstream ?? "未设置/未确认"}`,
    `  PR：${entry.pr?.url ?? "未取得当前提交对应的 PR 证据"}`,
    ...(entry.error ? [`  ${entry.error}`] : []),
  ]);
}
