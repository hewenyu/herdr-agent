import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { ExecutionRef } from "../core/types.js";
import type { TranscriptSource } from "./receipt.js";

/** Read native user input as evidence; assistant echoes and terminal text are insufficient. */
export async function readInitialInput(
  source: TranscriptSource,
  ref: ExecutionRef,
  receipt: string,
  strictIO = false,
): Promise<string | undefined> {
  if (!/^HERDR_RECEIPT_[a-f0-9]{32}$/.test(receipt)) return;
  const id = ref.sessionId ?? (ref.kind === "claude" ? basename(source.path, ".jsonl") : "");
  if (!id) return;
  const file = await open(source.path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 8 * 1_048_576) return;
    const data = Buffer.alloc(info.size);
    if ((await file.read(data, 0, data.length, 0)).bytesRead !== data.length) return;
    let sessionMatched = ref.kind === "claude";
    let input: string | undefined;
    let offset = 0;
    for (;;) {
      const end = data.indexOf(10, offset);
      if (end < 0) return sessionMatched ? input : undefined;
      const row = JSON.parse(data.subarray(offset, end).toString("utf8")) as Record<
        string,
        unknown
      >;
      offset = end + 1;
      if (!row || typeof row !== "object" || Array.isArray(row)) return;
      let content: unknown;
      if (ref.kind === "claude") {
        if (typeof row.sessionId === "string" && row.sessionId !== id) return;
        if (row.type !== "user" || row.isSidechain === true || row.isMeta === true) continue;
        if (row.sessionId !== id || row.cwd !== ref.cwd) continue;
        content = (row.message as { content?: unknown } | undefined)?.content;
      } else {
        const payload = row.payload as Record<string, unknown> | undefined;
        if (row.type === "session_meta") {
          if (sessionMatched || payload?.id !== id || payload.cwd !== ref.cwd) return;
          sessionMatched = true;
        }
        if (
          !sessionMatched ||
          row.type !== "response_item" ||
          payload?.type !== "message" ||
          payload.role !== "user"
        )
          continue;
        content = payload.content;
      }
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .flatMap((value: unknown) => {
                  const block = value as { type?: string; text?: string } | null;
                  return block &&
                    ["text", "input_text"].includes(block.type ?? "") &&
                    typeof block.text === "string"
                    ? [block.text]
                    : [];
                })
                .join("\n")
            : "";
      if (!text.split("\n").some((line) => line.trim() === receipt)) continue;
      if (input !== undefined) return;
      input = text;
    }
  } catch (error) {
    if (strictIO && !(error instanceof SyntaxError)) throw error;
    return;
  } finally {
    await file.close();
  }
}
