import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecutionRef } from "../core/types.js";
import { receiptSource, type TranscriptSource } from "./receipt.js";

export class TranscriptResolver {
  private readonly cache = new Map<string, { path?: string; checked: number }>();
  constructor(private readonly home = homedir()) {}

  async resolve(ref: ExecutionRef, strictIO = false): Promise<TranscriptSource | undefined> {
    if (!ref.sessionId) return receiptSource(this.home, ref, strictIO);
    if (!/^[A-Za-z0-9_-]+$/.test(ref.sessionId)) return;
    const key = `${strictIO ? "strict:" : ""}${ref.kind}:${ref.sessionId}`;
    const cached = this.cache.get(key);
    if (cached?.path) return { path: cached.path };
    if (cached && Date.now() - cached.checked < 2_000) return;
    const root = join(this.home, ref.kind === "claude" ? ".claude/projects" : ".codex/sessions");
    const path = await this.find(
      root,
      ref.sessionId,
      ref.kind === "claude",
      0,
      { visited: 0 },
      strictIO,
    );
    if (this.cache.size > 1_024) this.cache.delete(this.cache.keys().next().value ?? "");
    this.cache.set(key, { path, checked: Date.now() });
    return path ? { path } : undefined;
  }

  private async find(
    directory: string,
    id: string,
    claude: boolean,
    depth: number,
    budget: { visited: number },
    strictIO: boolean,
  ): Promise<string | undefined> {
    if (depth > (claude ? 1 : 10) || budget.visited > 50_000) return;
    let children: Dirent[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (strictIO && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (++budget.visited > 50_000) return;
      const path = join(directory, child.name);
      if (child.isDirectory()) {
        const found = await this.find(path, id, claude, depth + 1, budget, strictIO);
        if (found) return found;
      } else if (
        child.isFile() &&
        (claude
          ? child.name === `${id}.jsonl`
          : child.name.endsWith(".jsonl") && child.name.includes(id))
      ) {
        try {
          if ((await stat(path)).isFile()) return path;
        } catch (error) {
          if (strictIO && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          /* Continue searching. */
        }
      }
    }
    return;
  }
}
