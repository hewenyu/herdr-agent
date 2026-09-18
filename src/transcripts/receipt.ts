import { open, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExecutionRef } from "../core/types.js";

export interface TranscriptSource {
  path: string;
  /** Only records following the participant's initial user input belong to this task. */
  afterOffset?: number;
}

/** Missing native IDs must be recovered from an exact durable input marker, never recency. */
export async function receiptSource(
  home: string,
  ref: ExecutionRef,
): Promise<TranscriptSource | undefined> {
  if (
    ref.kind !== "claude" ||
    !isAbsolute(ref.cwd) ||
    !/^HERDR_RECEIPT_[a-f0-9]{32}$/.test(ref.transcriptReceipt ?? "")
  )
    return;
  const directory = join(home, ".claude/projects", ref.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  try {
    const children = (await readdir(directory, { withFileTypes: true })).filter(
      (child) => child.isFile() && /^[A-Za-z0-9_-]+\.jsonl$/.test(child.name),
    );
    // An incomplete search cannot establish that a match is unique.
    if (children.length > 256) return;
    let remaining = 32 * 1_048_576;
    let found: TranscriptSource | undefined;
    for (const child of children) {
      const path = join(directory, child.name);
      const file = await open(path, "r");
      let data: Buffer;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > Math.min(remaining, 8 * 1_048_576)) return;
        remaining -= info.size;
        data = Buffer.alloc(info.size);
        const { bytesRead } = await file.read(data, 0, data.length, 0);
        if (bytesRead !== data.length) return;
      } finally {
        await file.close();
      }
      const afterOffset = matchReceipt(data, child.name.slice(0, -6), ref);
      if (afterOffset === undefined) continue;
      if (found) return;
      found = { path, afterOffset };
    }
    return found;
  } catch {
    // Missing/inaccessible/changing directories cannot safely identify a transcript.
    return;
  }
}

function matchReceipt(data: Buffer, sessionId: string, ref: ExecutionRef): number | undefined {
  let afterOffset: number | undefined;
  let offset = 0;
  for (;;) {
    const end = data.indexOf(10, offset);
    if (end < 0) return afterOffset;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(data.subarray(offset, end).toString("utf8"));
    } catch {
      return;
    }
    offset = end + 1;
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    if (typeof row.sessionId === "string" && row.sessionId !== sessionId) return;
    if (
      row.type !== "user" ||
      row.isSidechain === true ||
      row.isMeta === true ||
      row.cwd !== ref.cwd ||
      row.sessionId !== sessionId
    )
      continue;
    const message = row.message as { content?: unknown } | undefined;
    const content = message?.content;
    const blocks = typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
    const match = blocks.some((block: unknown) => {
      const value = block as { type?: string; text?: string } | null;
      const text = typeof block === "string" ? block : value?.type === "text" ? value.text : "";
      return (
        typeof text === "string" &&
        text.split("\n").some((line) => line.trim() === ref.transcriptReceipt)
      );
    });
    if (match) afterOffset ??= offset;
  }
}
