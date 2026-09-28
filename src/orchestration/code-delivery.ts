import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task } from "../core/types.js";

const execute = promisify(execFile);
export interface CodeDeliveryEvidence {
  observedAt: string;
  repositories: Array<{
    directory: string;
    branch?: string;
    commit?: string;
    dirty?: boolean;
    upstream?: string;
    pr?: { url: string; headCommit: string };
    error?: string;
  }>;
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
      ).stdout.trim();
    const entry: CodeDeliveryEvidence["repositories"][number] = { directory };
    try {
      const before = await git("rev-parse", "HEAD");
      entry.commit = before;
      entry.branch = await git("symbolic-ref", "--quiet", "--short", "HEAD").catch(
        () => "detached HEAD",
      );
      entry.dirty = !!(await git("status", "--porcelain", "--untracked-files=normal"));
      entry.upstream = await git(
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ).catch(() => undefined);
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
          pr.headRefOid === before &&
          pr.headRefName === entry.branch &&
          typeof pr.url === "string" &&
          /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pr.url)
        )
          entry.pr = { url: pr.url, headCommit: before };
      } catch {
        /* A missing/unavailable PR is explicitly not certified. */
      }
      if ((await git("rev-parse", "HEAD")) !== before) {
        entry.error = "采集期间提交发生变化，交付位置未确认";
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
