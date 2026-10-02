import { open } from "node:fs/promises";
import { OperationError } from "../core/errors.js";
import type { ExecutionRef, TranscriptEntry, TranscriptPage } from "../core/types.js";
import { conversation } from "./conversation.js";
import { readInitialInput } from "./input.js";
import { parseLines } from "./parser.js";
import type { TranscriptResolver } from "./resolver.js";

interface Cursor {
  path: string;
  device: string;
  inode: string;
  offset: number;
  skipPartial?: boolean;
}
const maxRead = 4 * 1_048_576;

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      typeof decoded.path !== "string" ||
      typeof decoded.device !== "string" ||
      typeof decoded.inode !== "string" ||
      !Number.isSafeInteger(decoded.offset) ||
      (decoded.offset ?? -1) < 0
    )
      throw new Error("invalid cursor");
    return decoded as Cursor;
  } catch (cause) {
    throw new OperationError("invalid_cursor", "原生记录读取位置无效。", "not_executed", { cause });
  }
}
const encodeCursor = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString("base64url");

export class TranscriptReader {
  constructor(private readonly resolver: TranscriptResolver) {}

  conversation(ref: ExecutionRef, receipt: string, cursor?: string) {
    return conversation(this.resolver, ref, receipt, cursor);
  }

  async initialInput(ref: ExecutionRef, receipt: string): Promise<string | undefined> {
    try {
      const source = await this.resolver.resolve({ ...ref, transcriptReceipt: receipt }, true);
      return source ? await readInitialInput(source, ref, receipt, true) : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async page(ref: ExecutionRef, cursor?: string): Promise<TranscriptPage> {
    const source = await this.resolver.resolve(ref);
    if (!source) return { entries: [], cursor: cursor ?? "" };
    const { path, afterOffset = 0 } = source;
    const previous = decodeCursor(cursor);
    const file = await open(path, "r");
    try {
      const info = await file.stat({ bigint: true });
      const size = Number(info.size);
      if (!Number.isSafeInteger(size))
        throw new OperationError("transcript_too_large", "原生记录超过安全读取范围。");
      const state: Cursor = {
        path,
        device: String(info.dev),
        inode: String(info.ino),
        offset: size,
      };
      if (
        !previous ||
        previous.path !== path ||
        previous.inode !== state.inode ||
        previous.device !== state.device
      ) {
        // EOF may be in the middle of a record; discard its eventual remainder.
        if (size) {
          const last = Buffer.alloc(1);
          await file.read(last, 0, 1, size - 1);
          state.skipPartial = last[0] !== 10;
        }
        return { entries: [], cursor: encodeCursor(state), path };
      }
      // The verified receipt's afterOffset is the authoritative lower bound; a cursor
      // never reads before it. Restarting at 0 on a shrink below the previous offset is
      // safe because the boundary is re-applied here, and it is a record boundary, so a
      // stale partial flag must not make the first post-receipt record be skipped.
      const requested = previous.offset > size ? 0 : previous.offset;
      state.offset = Math.max(afterOffset, requested);
      state.skipPartial =
        previous.offset > size || afterOffset > requested ? false : previous.skipPartial;
      if (state.offset > size) {
        // The source is shorter than the receipt boundary (the file shrank after the
        // receipt was resolved, e.g. same-inode truncation). No record after the receipt
        // can exist yet: report an empty page and pin the cursor at EOF so later growth
        // resumes at the receipt boundary, never in the earlier transcript.
        state.offset = size;
        state.skipPartial = false;
        return { entries: [], cursor: encodeCursor(state), path };
      }
      const buffer = Buffer.alloc(Math.min(maxRead, size - state.offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, state.offset);
      let data = buffer.subarray(0, bytesRead);
      if (state.skipPartial) {
        const end = data.indexOf(10);
        state.offset += end < 0 ? data.length : end + 1;
        if (end < 0) return { entries: [], cursor: encodeCursor(state), path };
        data = data.subarray(end + 1);
        state.skipPartial = false;
      }
      const parsed = parseLines(ref.kind, data, state.offset, `${path}:${state.inode}`);
      state.offset += parsed.consumed;
      if (parsed.consumed === 0 && data.length === maxRead) {
        state.offset += data.length;
        state.skipPartial = true;
      }
      return { entries: parsed.entries, cursor: encodeCursor(state), path };
    } finally {
      await file.close();
    }
  }

  async sampleLastReply(ref: ExecutionRef): Promise<TranscriptEntry | undefined> {
    const source = await this.resolver.resolve(ref);
    if (!source) return;
    const { path, afterOffset = 0 } = source;
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      let offset = Math.max(afterOffset, info.size - 256 * 1_024);
      if (offset > info.size) return;
      const buffer = Buffer.alloc(info.size - offset);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      let data = buffer.subarray(0, bytesRead);
      if (offset > afterOffset) {
        const end = data.indexOf(10);
        if (end < 0) return;
        data = data.subarray(end + 1);
        offset += end + 1;
      }
      const entries = parseLines(ref.kind, data, offset, `${path}:${info.ino}`).entries;
      return (
        entries.findLast((entry) => entry.role === "assistant" && entry.final) ??
        entries.findLast((entry) => entry.role === "assistant")
      );
    } finally {
      await file.close();
    }
  }
}
