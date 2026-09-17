import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expandPath } from "../config/load.js";
import { fail, OperationError } from "../core/errors.js";
import type { AgentKind, Catalog, Project } from "../core/types.js";
import type { Store } from "../storage/store.js";

const execute = promisify(execFile);

export function projectName(name: string): void {
  if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(name))
    fail("project_name", "项目名称只能包含文字、数字、下划线或连字符。");
}

export class ProjectCatalog {
  constructor(
    private readonly store: Store,
    initial: Catalog,
    private readonly home = homedir(),
  ) {
    if (!store.get("catalog", "current")) store.set("catalog", "current", initial);
  }

  snapshot(): Catalog {
    return this.store.get<Catalog>("catalog", "current") as Catalog;
  }

  get(name?: string): Project {
    const catalog = this.snapshot();
    const project = catalog.projects.find(
      (entry) => entry.name === (name || catalog.defaultProject),
    );
    if (!project) fail("project_missing", "项目未配置，请选择已有项目或明确创建新项目。");
    return project;
  }

  async save(input: Project, makeDefault = false): Promise<Project> {
    projectName(input.name);
    if (input.agent !== "codex" && input.agent !== "claude")
      fail("project_agent", "agent 必须是 codex 或 claude。");
    if (!input.directories.length) fail("project_directory", "至少需要一个项目目录。");
    const directories = [...new Set(input.directories.map((path) => expandPath(path, this.home)))];
    await this.verifyDirectories(directories);
    await this.ensureGit(directories[0] as string);
    const project = { ...input, directories };
    this.store.transaction(() => {
      const catalog = this.snapshot();
      catalog.projects = [
        ...catalog.projects.filter((entry) => entry.name !== input.name),
        project,
      ];
      if (makeDefault || !catalog.defaultProject) catalog.defaultProject = input.name;
      this.store.set("catalog", "current", catalog);
    });
    return project;
  }

  async create(name: string, agent: AgentKind = "codex"): Promise<Project> {
    projectName(name);
    if (this.snapshot().projects.some((entry) => entry.name === name))
      fail("project_exists", "同名项目已存在。");
    const root = join(this.home, "herder-agent-code");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = join(root, name);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch {
      fail("project_directory_exists", "新项目目录已存在或无法创建，请选择其他名称。");
    }
    // Never delete a created directory after an uncertain registration failure.
    return this.save({ name, agent, directories: [directory] });
  }

  remove(name: string): void {
    this.get(name);
    const catalog = this.snapshot();
    catalog.projects = catalog.projects.filter((entry) => entry.name !== name);
    if (catalog.defaultProject === name) {
      catalog.defaultProject =
        [...catalog.projects].sort((a, b) => a.name.localeCompare(b.name))[0]?.name ?? "";
    }
    this.store.set("catalog", "current", catalog);
  }

  settings(input: { defaultProject?: string; bypass?: boolean }): Catalog {
    const catalog = this.snapshot();
    if (input.defaultProject !== undefined) {
      if (input.defaultProject) this.get(input.defaultProject);
      else if (catalog.projects.length) fail("default_project", "有项目时必须选择默认项目。");
      catalog.defaultProject = input.defaultProject;
    }
    if (input.bypass !== undefined) catalog.bypass = input.bypass;
    this.store.set("catalog", "current", catalog);
    return catalog;
  }

  async verifyDirectories(directories: string[]): Promise<void> {
    for (const directory of directories) {
      try {
        if (!(await stat(directory)).isDirectory()) throw new Error();
      } catch {
        fail("directory_missing", `项目目录不可用：${directory}`);
      }
    }
  }

  async ensureGit(directory: string): Promise<void> {
    try {
      const git = await lstat(join(directory, ".git"));
      if (!git.isDirectory() && !git.isFile()) fail("git_directory", ".git 不是有效文件或目录。");
      await execute("git", ["-C", directory, "rev-parse", "--git-dir"]);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await execute("git", ["init", "--", directory]);
  }

  async worktree(taskId: string, directories: string[], stateDir: string): Promise<string[]> {
    const primary = directories[0];
    if (!primary) fail("worktree_project", "独立 worktree 需要项目目录。");
    await this.verifyDirectories(directories);
    const root = join(stateDir, "worktrees");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const destination = resolve(root, taskId);
    if (!destination.startsWith(`${resolve(root)}/`)) fail("worktree_path", "worktree 标识无效。");
    try {
      await realpath(destination);
      fail("worktree_exists", "worktree 已存在，需先核对创建回执。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await execute("git", ["-C", primary, "rev-parse", "--verify", "HEAD"]);
    } catch {
      fail("worktree_create", "无法建立独立 worktree；请确认仓库已有提交且任务分支不存在。");
    }
    try {
      await execute("git", [
        "-C",
        primary,
        "worktree",
        "add",
        "-b",
        `herdr/${taskId}`,
        destination,
        "HEAD",
      ]);
    } catch {
      throw new OperationError(
        "worktree_uncertain",
        "worktree 创建未确认；请核对目录与任务分支，不能自动重试。",
        "unknown",
      );
    }
    return [destination, ...directories.slice(1)];
  }
}
