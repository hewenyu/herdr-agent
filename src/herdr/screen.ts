import { stripVTControlCharacters } from "node:util";
import type { ScreenOption } from "../core/types.js";

export function cleanScreen(raw: string): string {
  return [...stripVTControlCharacters(raw)]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || (code >= 32 && code !== 127);
    })
    .join("");
}

export function trustKeys(raw: string): string[] | undefined {
  const lines = cleanScreen(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 5 || lines.at(-1) !== "Press enter to continue") return;
  const start = lines.findIndex((line) => line.startsWith("> You are in "));
  if (start < 0 || start > lines.length - 5) return;
  if (start > 0) {
    if (lines[start - 1] !== "Welcome to Codex, OpenAI's command-line coding agent") return;
    if (lines.slice(0, start - 1).some((line) => /[\p{L}\p{N}]/u.test(line))) return;
  }
  if (
    !lines
      .slice(start + 1, -3)
      .join("")
      .replace(/\s/g, "")
      .includes("Doyoutrustthecontentsofthisdirectory?")
  )
    return;
  if (lines.at(-3) === "› 1. Yes, continue" && lines.at(-2) === "2. No, quit") return ["enter"];
  if (lines.at(-3) === "1. Yes, continue" && lines.at(-2) === "› 2. No, quit")
    return ["up", "enter"];
  return;
}

export function showsDialog(raw: string): boolean {
  if (trustKeys(raw)) return true;
  const compact = cleanScreen(raw).toLowerCase().replace(/\s/g, "");
  return ["doyouwanttoproceed?", "↑/↓tonavigate", "esctocancel"].some((marker) =>
    compact.includes(marker),
  );
}

export function parseOptions(raw: string): ScreenOption[] {
  const result: ScreenOption[] = [];
  const seen = new Set<string>();
  for (const line of cleanScreen(raw).split("\n")) {
    const match = /^\s*[❯›>]?\s*([1-9])[.)]\s+(.+)$/.exec(line);
    const key = match?.[1];
    const label = match?.[2]?.trim();
    if (key && label && !seen.has(key)) {
      seen.add(key);
      result.push({ key, label });
    }
  }
  return result;
}

/** Conservative native composer boundaries: uncertain footer text is excluded from proof. */
export function composerRange(raw: string): [number, number] | undefined {
  const lines = cleanScreen(raw).split("\n");
  const nonBlankAfter = (index: number) =>
    lines.slice(index + 1).filter((line) => line.trim()).length;
  const rule = (line: string) =>
    /^[\u2500-\u257f]+$/u.test(line.trim()) && /[─━┄┅┈┉╌╍═]{10}/u.test(line);
  let composer = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!(lines[index] ?? "").trimStart().startsWith("›")) continue;
    if (nonBlankAfter(index) <= 8) composer = index;
    break;
  }
  let bottom = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!rule(lines[index] ?? "")) continue;
    if (bottom < 0) {
      if (nonBlankAfter(index) > 8) break;
      bottom = index;
    } else {
      if (composer < bottom) return [index, bottom + 1];
      break;
    }
  }
  if (composer >= 0) return [composer, lines.length];
  let start = -1;
  let count = 0;
  for (let index = lines.length - 1; index >= 0 && count < 5; index--) {
    if (!(lines[index] ?? "").trim()) continue;
    start = index;
    count++;
  }
  return start < 0 ? undefined : [start, lines.length];
}
