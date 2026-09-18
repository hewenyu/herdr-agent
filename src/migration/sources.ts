import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite } from "../storage/atomic.js";
import { fields, invalid, type SourceFile } from "./common.js";

const fixed = [
  "config.toml",
  ".env",
  "projects.json",
  "tasks.json",
  "assistant-operations.json",
  "dedup.json",
  "routes.json",
  "selection.json",
  "deliveries.json",
];
const directories = ["conversations", "memory", "notifications"];
export const businessSource = (name: string): boolean =>
  !["config.toml", ".env", "projects.json"].includes(name);

/** Explicit stateDir only. Never follows symlinks or inspects arbitrary home files. */
export async function readSources(stateDir: string): Promise<SourceFile[]> {
  try {
    const root = await lstat(stateDir);
    if (!root.isDirectory() || root.isSymbolicLink()) invalid("迁移状态目录必须是普通目录");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const files: SourceFile[] = [];
  const visit = async (name: string, recursive: boolean): Promise<void> => {
    let info: Stats;
    try {
      info = await lstat(join(stateDir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) invalid("迁移源包含符号链接，需先人工核对");
    if (info.isDirectory() && recursive) {
      for (const child of (await readdir(join(stateDir, name))).sort())
        await visit(join(name, child), true);
      return;
    }
    if (!info.isFile() || info.size > 100 * 1024 * 1024) invalid("迁移源类型或大小异常");
    // Archive only recognized JSON documents; ignore abandoned atomic-write temp files.
    if (recursive && !name.endsWith(".json")) return;
    const bytes = await readFile(join(stateDir, name));
    const entry: SourceFile = {
      name,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      modifiedAt: info.mtime.toISOString(),
    };
    if (businessSource(name)) {
      try {
        entry.data = fields(JSON.parse(bytes.toString("utf8")));
      } catch {
        invalid(`旧版 ${name} 无法解析`);
      }
    }
    files.push(entry);
  };
  for (const name of fixed) await visit(name, false);
  for (const name of directories) await visit(name, true);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export const rollbackInstructions = [
  "停止新版服务并保留当前 SQLite 数据库及其 WAL/SHM 文件，不同时运行新旧飞书连接。",
  "本迁移未改写任何 Go 源状态文件；备份目录含源文件快照和校验清单。",
  "迁移后新增的任务、输入与清理不会回写 Go JSON。回退前必须核对 herdr 和飞书现场，避免旧服务重复执行或操作已变化资源。",
  "需要恢复旧版本时，在服务停止状态下人工选择已核对的快照；不要自动覆盖新数据库或删除执行资源。",
];

export async function backupSources(stateDir: string, files: SourceFile[]): Promise<string> {
  const backups = join(stateDir, "backups");
  await mkdir(backups, { recursive: true, mode: 0o700 });
  const parent = await lstat(backups);
  if (!parent.isDirectory() || parent.isSymbolicLink()) invalid("备份目录不能是符号链接");
  const directory = join(
    backups,
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(directory, { mode: 0o700 });
  for (const file of files) {
    const path = join(directory, file.name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(file.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await atomicWrite(
    join(directory, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        files: files.map(({ name, sha256, bytes }) => ({ name, sha256, size: bytes.length })),
        rollback: rollbackInstructions,
      },
      null,
      2,
    ),
  );
  const folders = new Set([directory, backups, stateDir]);
  for (const file of files) {
    for (
      let folder = dirname(join(directory, file.name));
      folder !== directory;
      folder = dirname(folder)
    )
      folders.add(folder);
  }
  for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
    const handle = await open(folder, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return directory;
}
