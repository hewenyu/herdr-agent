import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export function command(file: string, args: string[], cwd?: string, env = process.env): string {
  return execFileSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
}

export async function integrity(path: string): Promise<string> {
  return `sha512-${createHash("sha512")
    .update(await readFile(path))
    .digest("base64")}`;
}

export async function safeTree(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(relative: string) {
    for (const name of (await readdir(join(directory, relative))).sort()) {
      const path = join(relative, name);
      const info = await lstat(join(directory, path));
      if (info.isSymbolicLink())
        throw new Error(`Symlinks are not allowed in distribution inputs: ${path}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files.push(path);
      else throw new Error(`Non-file distribution input: ${path}`);
    }
  }
  await visit("");
  return files;
}

/** Validate all archive entries before extraction; CI archives contain only regular files/directories. */
export async function extract(archive: string, directory: string): Promise<void> {
  const source = resolve(archive);
  const names = command("tar", ["-tzf", source]).trimEnd().split("\n");
  if (
    !names.length ||
    names.some(
      (name) =>
        !name ||
        name.startsWith("/") ||
        name.includes("\\") ||
        [...name].some((character) => character.charCodeAt(0) < 32) ||
        name.split("/").includes(".."),
    )
  )
    throw new Error(`Unsafe archive paths in ${basename(source)}`);
  const modes = command("tar", ["-tvzf", source]).trimEnd().split("\n");
  if (modes.some((line) => !/^[d-]/.test(line)))
    throw new Error(`Archive contains links or special files: ${basename(source)}`);
  await mkdir(directory, { recursive: true });
  command("tar", ["-xzf", source, "-C", directory]);
  await safeTree(directory);
}

export function offlineEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: "C.UTF-8",
    npm_config_cache: join(directory, "npm-cache"),
    npm_config_userconfig: join(directory, "empty-npmrc"),
    npm_config_globalconfig: join(directory, "empty-global-npmrc"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_offline: "true",
  };
}
