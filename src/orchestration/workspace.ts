import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { OperationError } from "../core/errors.js";
import type { Participant, Task } from "../core/types.js";
import type { OperationReceipt } from "../storage/operations.js";
import type { Store } from "../storage/store.js";
import { activeTaskOperation } from "../tasks/operation-scope.js";
import { WORKFLOWS, type WorkflowState } from "./workflow.js";

const execute = promisify(execFile);
const dependencies = new Set([".git", "node_modules", ".venv", "venv", "__pycache__"]);
const beneath = (path: string, parent: string): boolean =>
  path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

async function canonicalDirectory(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    const absolute = resolve(path);
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    // A removed working directory still has a stable identity under its canonical parent.
    return join(await canonicalDirectory(parent), relative(parent, absolute));
  }
}

export async function normalizedDirectories(directories: string[]): Promise<string[]> {
  return [...new Set(await Promise.all(directories.map(canonicalDirectory)))].sort();
}

/** Inputs must already be normalized; paths that merely share a string prefix do not overlap. */
export function directoriesConflict(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => beneath(a, b) || beneath(b, a)));
}

async function listFiles(root: string, authorizedRoot = root): Promise<string[]> {
  let paths: string[];
  try {
    const { stdout } = await execute(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
      {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15_000,
        env: { ...process.env, LC_ALL: "C" },
      },
    );
    paths = [...new Set(stdout.split("\0").filter(Boolean))];
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code !== "ENOENT" && !failure.stderr?.includes("not a git repository"))
      throw new OperationError("workspace_read", "无法读取工作目录文件清单。", "not_executed", {
        cause: error,
      });
    paths = (await readdir(root)).filter((name) => !dependencies.has(name));
  }
  const files: string[] = [];
  for (const path of paths.sort()) {
    if (isAbsolute(path) || path.split(sep).some((part) => part === ".." || part === ".git"))
      throw new OperationError("workspace_path", "工作目录文件清单含有越界路径。");
    if (!beneath(await canonicalDirectory(dirname(join(root, path))), authorizedRoot))
      throw new OperationError("workspace_path", "工作目录文件的父路径指向授权目录之外。");
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(join(root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files.push(path); // Deleted tracked files are part of the artifact revision.
      continue;
    }
    if (metadata.isDirectory()) {
      for (const child of await listFiles(join(root, path), authorizedRoot))
        files.push(join(path, child));
    } else files.push(path);
  }
  return files.sort();
}

async function fileFacts(path: string): Promise<string> {
  try {
    const metadata = await lstat(path, { bigint: true });
    return [
      metadata.dev,
      metadata.ino,
      metadata.mode,
      metadata.size,
      metadata.mtimeNs,
      metadata.ctimeNs,
    ].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** Hashes actual tracked + untracked source bytes; never uses HEAD as verification evidence. */
export async function workspaceRevision(
  directories: string[],
  documentPaths: string[] = [],
): Promise<string> {
  const hash = createHash("sha256");
  const main = directories[0] ? await canonicalDirectory(directories[0]) : "";
  const documents = new Set(documentPaths.map((path) => resolve(main, path)));
  for (const root of await normalizedDirectories(directories)) {
    const sourceFiles = async () =>
      (await listFiles(root)).filter((path) => !documents.has(resolve(root, path)));
    const files = await sourceFiles();
    const facts = new Map<string, string>();
    hash.update(JSON.stringify(["directory", root]));
    for (const path of files) {
      const absolute = join(root, path);
      if (!beneath(await canonicalDirectory(dirname(absolute)), root))
        throw new OperationError("workspace_path", "工作目录文件的父路径指向授权目录之外。");
      const before = await fileFacts(absolute);
      facts.set(path, before);
      hash.update(JSON.stringify(["path", path]));
      if (before === "missing") {
        hash.update("missing");
        continue;
      }
      const metadata = await lstat(absolute);
      hash.update(JSON.stringify(["mode", metadata.mode & 0o777]));
      if (metadata.isSymbolicLink()) {
        // Hash the versioned link, without reading content outside task-authorized roots.
        hash.update(JSON.stringify(["symlink", await readlink(absolute)]));
      } else if (metadata.isFile()) {
        const content = createHash("sha256");
        for await (const chunk of createReadStream(absolute)) content.update(chunk);
        hash.update(content.digest());
      } else throw new OperationError("workspace_file", "工作目录包含不可安全读取的特殊文件。");
    }
    if (JSON.stringify(files) !== JSON.stringify(await sourceFiles()))
      throw new OperationError(
        "workspace_changed",
        "读取期间工作目录文件清单改变，请重新核对产物版本。",
      );
    for (const [path, before] of facts) {
      if (before !== (await fileFacts(join(root, path))))
        throw new OperationError(
          "workspace_changed",
          "读取期间工作目录内容改变，请重新核对产物版本。",
        );
    }
  }
  return hash.digest("hex");
}

function participantAccess(
  task: Task,
  participantId: string,
  workflow?: WorkflowState,
): "read" | "write" {
  if (workflow) {
    const nodes = workflow.plan.nodes.filter(
      (node) =>
        workflow.nodes[node.id]?.participantId === participantId &&
        workflow.nodes[node.id]?.status === "dispatched",
    );
    if (nodes.length) return nodes.some((node) => node.access === "write") ? "write" : "read";
  }
  return task.kind === "discussion" || task.kind === "review" ? "read" : "write";
}

/** Caller serializes this check and dispatch registration with the existing global mutex. */
export async function workspaceAvailable(
  store: Store,
  task: Task,
  access: "read" | "write",
  verificationBlockingDirs: string[] = [],
): Promise<boolean> {
  const directories = await normalizedDirectories(task.directories);
  if (directoriesConflict(directories, await normalizedDirectories(verificationBlockingDirs)))
    return false;
  const participants = store.list<Participant>("participants");
  const operations = store
    .entries<OperationReceipt>("operations")
    .filter(([, operation]) => ["pending", "uncertain"].includes(operation.state));
  for (const other of store.list<Task>("tasks")) {
    if (other.id === task.id) continue;
    const workflow = store.get<WorkflowState>(WORKFLOWS, other.id);
    const active = participants.filter(
      (participant) =>
        participant.taskId === other.id &&
        (["working", "unknown"].includes(participant.status) ||
          !!store.get("participant_awaiting_output", participant.id)),
    );
    const unknown = operations.filter(([id, receipt]) =>
      activeTaskOperation(store, other, id, receipt),
    );
    if (!active.length && !unknown.length) continue;
    let writer = active.some(
      (participant) => participantAccess(other, participant.id, workflow) === "write",
    );
    for (const [id] of unknown) {
      const node = workflow?.plan.nodes.find(
        (candidate) => workflow.nodes[candidate.id]?.operationId === id,
      );
      if (node?.access !== "read") writer = true;
    }
    if (
      (access === "write" || writer) &&
      directoriesConflict(directories, await normalizedDirectories(other.directories))
    )
      return false;
  }
  return true;
}
