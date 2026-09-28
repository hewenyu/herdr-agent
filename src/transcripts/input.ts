import { type FileHandle, open } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentKind, ExecutionRef } from "../core/types.js";
import type { TranscriptSource } from "./receipt.js";

/** Comparison-only compatibility for Claude's native single-paste envelope.
 * Keep the original transcript unchanged; callers must still match the entire
 * payload to their durable input and independently verify receipt and identity.
 */
export function nativeInputCandidates(kind: AgentKind, input: string): string[] {
  if (kind !== "claude") return [input];
  const match =
    /^\n\n<pasted_content id="([a-f0-9]{4})">\n\n([\s\S]*)\n<\/pasted_content id="\1">\n$/.exec(
      input,
    );
  const payload = match?.[2];
  if (match?.[0] !== input || payload === undefined || /<\/?pasted_content\b/.test(payload))
    return [input];
  return [input, payload];
}

/** Read native user input as evidence; assistant echoes and terminal text are insufficient. */
export async function readInitialInput(
  source: TranscriptSource,
  ref: ExecutionRef,
  receipt: string,
  strictIO = false,
): Promise<string | undefined> {
  if (!/^HERDR_RECEIPT_[a-f0-9]{32}$/.test(receipt)) return;
  const id =
    ref.sessionId ??
    source.sessionId ??
    (ref.kind === "claude" ? basename(source.path, ".jsonl") : "");
  if (!id) return;
  const file = await open(source.path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size)) return;
    let sessionMatched = ref.kind === "claude";
    let input: string | undefined;
    for await (const { text: line } of nativeInputLines(file, info.size)) {
      const row = JSON.parse(line) as Record<string, unknown>;
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
          if (
            sessionMatched ||
            payload?.id !== id ||
            payload.cwd !== ref.cwd ||
            (payload.session_id !== undefined && payload.session_id !== id)
          )
            return;
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
    return sessionMatched ? input : undefined;
  } catch (error) {
    if (strictIO && !(error instanceof SyntaxError)) throw error;
    return;
  } finally {
    await file.close();
  }
}

/** Bound memory per record, not per session: long-running native sessions are normal. */
export async function* nativeInputLines(
  file: FileHandle,
  size: number,
): AsyncGenerator<{ text: string; afterOffset: number }> {
  const buffer = Buffer.alloc(Math.min(size, 1_048_576));
  let pending = Buffer.alloc(0);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, size - offset),
      offset,
    );
    if (!bytesRead) throw new SyntaxError("transcript changed during input readback");
    offset += bytesRead;
    const data = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
    let start = 0;
    for (;;) {
      const end = data.indexOf(10, start);
      if (end < 0) break;
      if (end - start > 8 * 1_048_576)
        throw new SyntaxError("transcript record exceeds read limit");
      yield {
        text: data.subarray(start, end).toString("utf8"),
        afterOffset: offset - data.length + end + 1,
      };
      start = end + 1;
    }
    pending = Buffer.from(data.subarray(start));
    if (pending.length > 8 * 1_048_576)
      throw new SyntaxError("transcript record exceeds read limit");
  }
  // The native writer may still be appending its final record. Ignore its fragment.
}
