import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { canonical, stableId } from "../core/ids.js";
import type { Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import type { Store } from "../storage/store.js";

const execute = promisify(execFile);
async function git(directory: string, args: string[]): Promise<string> {
  return (
    await execute("git", ["-C", directory, ...args], { timeout: 5_000, maxBuffer: 1_048_576 })
  ).stdout.trimEnd();
}

/** Inspect only Git metadata. A linked worktree must still belong to its task branch. */
export async function taskWorktreeRoot(
  directory: string,
  taskId: string,
): Promise<string | undefined> {
  try {
    if (!/^task_[A-Za-z0-9_-]+$/.test(taskId)) return;
    const path = await realpath(directory);
    if ((await realpath(await git(directory, ["rev-parse", "--show-toplevel"]))) !== path) return;
    const records = (await git(directory, ["worktree", "list", "--porcelain", "-z"]))
      .split("\0\0")
      .map((record) => record.split("\0"));
    const root = records[0]?.find((field) => field.startsWith("worktree "))?.slice(9);
    if (!root || (await realpath(root)) === path) return;
    const match = records.find((record) => record.includes(`worktree ${path}`));
    if (!match?.includes(`branch refs/heads/herdr/${taskId}`)) return;
    if (
      (await git(directory, ["symbolic-ref", "--quiet", "HEAD"])) !== `refs/heads/herdr/${taskId}`
    )
      return;
    const common = await realpath(
      await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    const rootCommon = await realpath(
      await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    if (
      common !== rootCommon ||
      (await realpath(await git(root, ["rev-parse", "--show-toplevel"]))) !== (await realpath(root))
    )
      return;
    return await realpath(root);
  } catch {
    return;
  }
}

/** Original creation receipt proves authorization; mutable project catalog is never consulted. */
export async function authorizedWorktreeRoot(
  store: Store,
  task: Task,
): Promise<string | undefined> {
  const directory = task.directories[0];
  if (
    task.directoryMode !== "worktree" ||
    !task.worktreeReady ||
    !directory ||
    resolve(directory) !== resolve(dirname(store.path), "worktrees", task.id)
  )
    return;
  const receipt = store.get<OperationReceipt>("operations", `${task.id}:worktree`);
  if (receipt?.state !== "done" || canonical(receipt.result) !== canonical(task.directories))
    return;
  const root = await taskWorktreeRoot(directory, task.id);
  if (!root) return;
  const sources = task.sourceDirectories ?? [root, ...task.directories.slice(1)];
  if (receipt.fingerprint !== stableId(canonical({ directories: sources }))) return;
  try {
    if (
      !sources[0] ||
      (await realpath(sources[0])) !== root ||
      canonical(sources.slice(1)) !== canonical(task.directories.slice(1))
    )
      return;
  } catch {
    return;
  }
  return root;
}
