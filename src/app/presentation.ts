import { stripVTControlCharacters } from "node:util";
import type { AppConfig } from "../config/types.js";
import type { Store } from "../storage/store.js";

export type ScreenPresentation = Pick<AppConfig["ui"], "maxCols" | "tailLines">;
export const defaultPresentation: ScreenPresentation = { maxCols: 56, tailLines: 18 };
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

function columns(value: string): number {
  if (/^\p{Mark}+$/u.test(value)) return 0;
  const point = value.codePointAt(0) ?? 0;
  if (
    /\p{Extended_Pictographic}/u.test(value) ||
    (point >= 0x1100 &&
      (point <= 0x115f ||
        point === 0x2329 ||
        point === 0x232a ||
        (point >= 0x2e80 && point <= 0xa4cf) ||
        (point >= 0xac00 && point <= 0xd7a3) ||
        (point >= 0xf900 && point <= 0xfaff) ||
        (point >= 0xfe10 && point <= 0xfe19) ||
        (point >= 0xfe30 && point <= 0xfe6f) ||
        (point >= 0xff00 && point <= 0xff60) ||
        (point >= 0xffe0 && point <= 0xffe6) ||
        (point >= 0x20000 && point <= 0x3fffd)))
  )
    return 2;
  return 1;
}

function cropLine(line: string, maxCols: number): { text: string; cropped: boolean } {
  let text = "";
  let used = 0;
  const parts = [...graphemes.segment(line)].map(({ segment }) => segment);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] ?? "";
    const width = part === "\t" ? 8 - (used % 8) : columns(part);
    if (used + width > maxCols) return { text, cropped: true };
    text += part === "\t" ? " ".repeat(width) : part;
    used += width;
  }
  return { text, cropped: false };
}

/** Display only. Never pass this cropped text to screen detection, Guard validation or input logic. */
export function presentScreen(
  text: string,
  options: ScreenPresentation = defaultPresentation,
): string {
  const plain = Array.from(stripVTControlCharacters(text).replace(/\r\n?/g, "\n"))
    .filter((char) => {
      const point = char.codePointAt(0) ?? 0;
      return point === 9 || point === 10 || (point >= 32 && point !== 127);
    })
    .join("");
  const maxCols = Math.max(1, Math.floor(options.maxCols));
  const tailLines = Math.max(1, Math.floor(options.tailLines));
  const lines = plain.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const visible = lines.slice(-tailLines).map((line) => cropLine(line, maxCols));
  const clipped = lines.length > tailLines || visible.some((line) => line.cropped);
  const content = visible.map((line) => line.text).join("\n");
  return clipped
    ? `${content}\n[现场显示已裁剪：最多 ${maxCols} 列、末尾 ${tailLines} 行]`
    : content;
}

/** A skipped progress remains eligible on the next task tick; no delivery receipt is written. */
export function progressCooling(
  store: Store,
  taskId: string,
  cooldownMs: number,
  at = Date.now(),
): boolean {
  const last = store.get<{ at: number }>("notice_progress_last", taskId);
  return !!last && at >= last.at && at - last.at < cooldownMs;
}

export function recordProgressNotice(store: Store, taskId: string, at = Date.now()): void {
  store.set("notice_progress_last", taskId, { at });
}
