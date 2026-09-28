import type { BigIntStats } from "node:fs";
import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExecutionRef } from "../core/types.js";
import { nativeInputLines } from "./input.js";
import type { TranscriptSource } from "./receipt.js";

const MiB = 1_048_576;
const fileName =
  /^rollout-.+-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/;
type Meta = { id: string; cwd: string; sessionId?: unknown; subagent: boolean };
type Cached = { signature: string; meta: Meta; receipts: Map<string, number | null> };
type Budget = { entries: number; bytes: number };
class IncompleteSearch extends Error {}

function signature(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

/** Discover missing native IDs only through complete, unique receipt searches.
 * Cache unchanged file facts, not a winning session: new files are still searched.
 */
export class CodexReceiptSources {
  private readonly files = new Map<string, Cached>();

  async resolve(
    home: string,
    ref: ExecutionRef,
    strictIO: boolean,
  ): Promise<TranscriptSource | undefined> {
    if (
      ref.kind !== "codex" ||
      !isAbsolute(ref.cwd) ||
      !/^HERDR_RECEIPT_[a-f0-9]{32}$/.test(ref.transcriptReceipt ?? "")
    )
      return;
    const budget: Budget = { entries: 0, bytes: 64 * MiB };
    let found: TranscriptSource | undefined;
    try {
      for await (const [path, id] of this.paths(join(home, ".codex/sessions"), 0, budget)) {
        const info = await stat(path, { bigint: true });
        if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER))
          throw new IncompleteSearch();
        const version = signature(info);
        let cached = this.files.get(path);
        if (cached?.signature !== version) {
          const file = await open(path, "r");
          try {
            if (signature(await file.stat({ bigint: true })) !== version)
              throw new IncompleteSearch();
            const meta = await this.metadata(file, Number(info.size), budget);
            if (signature(await file.stat({ bigint: true })) !== version)
              throw new IncompleteSearch();
            cached = { signature: version, meta, receipts: new Map() };
            if (this.files.size >= 4096) this.files.delete(this.files.keys().next().value ?? "");
            this.files.set(path, cached);
          } finally {
            await file.close();
          }
        }
        if (cached.meta.cwd !== ref.cwd) continue;
        // Subagent transcripts can inherit the parent's receipt and session_id.
        // They are not a top-level herdr-managed Codex input, even in the same cwd.
        if (cached.meta.subagent) continue;
        if (
          cached.meta.id !== id ||
          (cached.meta.sessionId !== undefined && cached.meta.sessionId !== id)
        )
          throw new IncompleteSearch();
        const receipt = ref.transcriptReceipt as string;
        let offset = cached.receipts.get(receipt);
        if (offset === undefined) {
          const size = Number(info.size);
          if (size > budget.bytes) throw new IncompleteSearch();
          budget.bytes -= size;
          const file = await open(path, "r");
          try {
            if (signature(await file.stat({ bigint: true })) !== version)
              throw new IncompleteSearch();
            offset = await this.match(file, size, cached.meta, receipt);
            if (signature(await file.stat({ bigint: true })) !== version)
              throw new IncompleteSearch();
            if (cached.receipts.size >= 64) cached.receipts.clear();
            cached.receipts.set(receipt, offset);
          } finally {
            await file.close();
          }
        }
        if (offset === null) continue;
        if (found) return;
        found = { path, sessionId: cached.meta.id, afterOffset: offset };
      }
      return found;
    } catch (error) {
      if (
        strictIO &&
        !(error instanceof IncompleteSearch) &&
        !(error instanceof SyntaxError) &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw error;
      return;
    }
  }

  private async *paths(
    directory: string,
    depth: number,
    budget: Budget,
  ): AsyncGenerator<[string, string]> {
    if (depth > 10) throw new IncompleteSearch();
    const children = await readdir(directory, { withFileTypes: true });
    budget.entries += children.length;
    if (budget.entries > 50_000) throw new IncompleteSearch();
    for (const child of children) {
      const path = join(directory, child.name);
      if (child.isDirectory()) yield* this.paths(path, depth + 1, budget);
      else if (child.isFile() && child.name.endsWith(".jsonl")) {
        const id = fileName.exec(child.name)?.[1];
        // An unrecognized native file cannot silently hide another receipt.
        if (!id) throw new IncompleteSearch();
        yield [path, id];
      }
    }
  }

  private async metadata(file: FileHandle, size: number, budget: Budget): Promise<Meta> {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < Math.min(size, MiB)) {
      const length = Math.min(4096, size - offset, MiB - offset);
      if (length > budget.bytes) throw new IncompleteSearch();
      budget.bytes -= length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new IncompleteSearch();
      const end = buffer.indexOf(10);
      chunks.push(end < 0 ? buffer : buffer.subarray(0, end));
      if (end >= 0) {
        const row = this.record(Buffer.concat(chunks).toString("utf8"));
        const payload = row.payload as Record<string, unknown> | undefined;
        if (
          row.type !== "session_meta" ||
          typeof payload?.id !== "string" ||
          typeof payload.cwd !== "string" ||
          !isAbsolute(payload.cwd)
        )
          throw new IncompleteSearch();
        const source = payload.source as Record<string, unknown> | undefined;
        return {
          id: payload.id,
          cwd: payload.cwd,
          sessionId: payload.session_id,
          subagent:
            payload.thread_source === "subagent" ||
            (!!source && typeof source === "object" && "subagent" in source),
        };
      }
      offset += length;
    }
    throw new IncompleteSearch();
  }

  private async match(
    file: FileHandle,
    size: number,
    meta: Meta,
    receipt: string,
  ): Promise<number | null> {
    let found: number | null = null;
    let sessionMatched = false;
    for await (const { text, afterOffset } of nativeInputLines(file, size)) {
      const row = this.record(text);
      const payload = row.payload as Record<string, unknown> | undefined;
      if (row.type === "session_meta") {
        if (
          sessionMatched ||
          payload?.id !== meta.id ||
          payload.cwd !== meta.cwd ||
          (payload.session_id !== undefined && payload.session_id !== meta.id)
        )
          throw new IncompleteSearch();
        sessionMatched = true;
      }
      if (
        !sessionMatched ||
        row.type !== "response_item" ||
        payload?.type !== "message" ||
        payload.role !== "user" ||
        !Array.isArray(payload.content)
      )
        continue;
      const matched = payload.content.some((value) => {
        const block = value as { type?: unknown; text?: unknown } | null;
        return (
          block &&
          ["text", "input_text"].includes(String(block.type)) &&
          typeof block.text === "string" &&
          block.text.split("\n").some((line) => line.trim() === receipt)
        );
      });
      if (!matched) continue;
      if (found !== null) throw new IncompleteSearch();
      found = afterOffset;
    }
    return found;
  }

  private record(line: string): Record<string, unknown> {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new IncompleteSearch();
      return value;
    } catch {
      throw new IncompleteSearch();
    }
  }
}
