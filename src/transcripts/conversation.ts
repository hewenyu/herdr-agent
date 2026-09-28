import { open, stat } from "node:fs/promises";
import { OperationError } from "../core/errors.js";
import { canonical, stableId } from "../core/ids.js";
import type { ExecutionRef, TranscriptEntry } from "../core/types.js";
import { nativeInputLines, readInitialInput } from "./input.js";
import { parseRecord } from "./parser.js";
import type { TranscriptResolver } from "./resolver.js";

interface Cursor {
  binding: string;
  inode: string;
  device: string;
  before: number;
}

/** Read only the conversation after this participant's verified initial input. */
export async function conversation(
  resolver: TranscriptResolver,
  ref: ExecutionRef,
  receipt: string,
  cursor?: string,
): Promise<{ entries: TranscriptEntry[]; cursor?: string; truncated: boolean }> {
  const source = await resolver.resolve({ ...ref, transcriptReceipt: receipt }, true);
  if (!source || !(await readInitialInput(source, ref, receipt, true)))
    throw new OperationError("transcript_unverified", "尚未找到与本任务初始输入匹配的会话记录。");
  const binding = stableId(canonical(ref), receipt);
  let previous: Cursor | undefined;
  if (cursor) {
    try {
      previous = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Cursor;
      if (
        previous.binding !== binding ||
        !Number.isSafeInteger(previous.before) ||
        previous.before < 0
      )
        throw new Error("invalid cursor");
    } catch {
      throw new OperationError("invalid_cursor", "进度分页不属于当前参与者会话。");
    }
  }
  const file = await open(source.path, "r");
  try {
    const info = await file.stat({ bigint: true });
    const size = Number(info.size);
    if (!info.isFile() || !Number.isSafeInteger(size) || size > 64 * 1_048_576)
      throw new OperationError("transcript_too_large", "会话记录超过此次进度读取范围。");
    const inode = String(info.ino);
    const device = String(info.dev);
    if (
      previous &&
      (previous.inode !== inode || previous.device !== device || previous.before > size)
    )
      throw new OperationError("invalid_cursor", "会话文件已轮转，请重新查询进度。");
    const before = previous?.before ?? size;
    const collected: Array<{ offset: number; entries: TranscriptEntry[] }> = [];
    let matched = false;
    let offset = 0;
    let characters = 0;
    let entryCount = 0;
    let truncated = false;
    let earlierRecords = false;
    for await (const line of nativeInputLines(file, size)) {
      const start = offset;
      offset = line.afterOffset;
      const entries = parseRecord(ref.kind, line.text, start, `${source.path}:${inode}`);
      if (!matched) {
        if (
          entries.some(
            (entry) =>
              entry.role === "user" &&
              entry.text.split("\n").some((line) => line.trim() === receipt),
          )
        )
          matched = true;
        continue;
      }
      if (start >= before) break;
      if (!entries.length) continue;
      const compact = entries.map((entry) => ({ ...entry, text: entry.text.slice(0, 4000) }));
      characters += compact.reduce((sum, entry) => sum + entry.text.length, 0);
      entryCount += compact.length;
      collected.push({ offset: start, entries: compact });
      while (collected.length > 1 && (entryCount > 40 || characters > 24_000)) {
        // Keep all entries from a native record together: pagination is by record offset.
        // A single oversized record must survive so its offset remains reachable.
        const removed = collected.shift();
        characters -= removed?.entries.reduce((sum, entry) => sum + entry.text.length, 0) ?? 0;
        entryCount -= removed?.entries.length ?? 0;
        truncated = true;
        earlierRecords = true;
      }
      if (entries.some((entry) => entry.text.length > 4000)) truncated = true;
    }
    // Recheck the exact receipt/session/cwd after the bounded snapshot; path replacement
    // or native session mutation must not make an old binding authorize another session.
    const current = await file.stat({ bigint: true });
    const verified = await readInitialInput(source, ref, receipt, true);
    const pathInfo = await stat(source.path, { bigint: true });
    if (
      !matched ||
      !verified ||
      current.size < info.size ||
      pathInfo.dev !== info.dev ||
      pathInfo.ino !== info.ino
    )
      throw new OperationError("transcript_unverified", "会话身份在读取期间变化。");
    const first = collected[0]?.offset;
    return {
      entries: collected.flatMap((item) => item.entries),
      cursor:
        earlierRecords && first !== undefined
          ? Buffer.from(JSON.stringify({ binding, inode, device, before: first })).toString(
              "base64url",
            )
          : undefined,
      truncated,
    };
  } finally {
    await file.close();
  }
}
