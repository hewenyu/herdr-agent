import { stripVTControlCharacters } from "node:util";
import type { AgentKind, ScreenOption } from "../core/types.js";

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

/** Exact native startup templates, never a general approval/question recognizer. */
export function directoryTrustKeys(
  kind: AgentKind,
  raw: string,
  expectedDirectory: string,
): string[] | undefined {
  if (!expectedDirectory.startsWith("/") || /[\r\n]/.test(expectedDirectory)) return;
  const lines = cleanScreen(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (kind === "codex") {
    const input = trustKeys(raw);
    if (!input) return;
    const start = lines.findIndex((line) => line.startsWith("> You are in "));
    const shown = lines[start]?.slice("> You are in ".length) ?? "";
    if (shown !== expectedDirectory) {
      // Native Codex clips this heading at the right edge without an ellipsis.
      // Accept a prefix only when another native paragraph reaches the same
      // column. The control layer separately verifies the full cwd from herdr.
      const rawLines = cleanScreen(raw)
        .split("\n")
        .map((line) => line.trimEnd());
      const heading = rawLines.find((line) => line.startsWith("> You are in ")) ?? "";
      const width = heading.length;
      if (
        !shown.startsWith("/") ||
        !expectedDirectory.startsWith(shown) ||
        width < 40 ||
        !/^[\x20-\x7e]+$/.test(heading) ||
        rawLines.some((line) => line.length > width) ||
        !rawLines.some((line) => line.startsWith("  ") && line.length === width)
      )
        return;
    }
    const question = lines.slice(start + 1, -3).join(" ");
    if (
      ![
        "Do you trust the contents of this directory?",
        "Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection. Trusting the directory allows project-local config, hooks, and exec policies to load.",
      ].includes(question)
    )
      return;
    return input;
  }
  if (/^─+$/.test(lines[0] ?? "")) lines.shift();
  if (lines[0] !== "Accessing workspace:" || lines.at(-1) !== "Enter to confirm · Esc to cancel")
    return;
  const question = lines.findIndex((line) => line.startsWith("Quick safety check:"));
  if (question < 2 || lines.slice(1, question).join("") !== expectedDirectory) return;
  const warning = lines.slice(question, -4).join(" ").replace(/\s+/g, " ");
  if (
    warning !==
    "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first. Claude Code'll be able to read, edit, and execute files here."
  )
    return;
  if (lines.at(-4) !== "Security guide") return;
  if (lines.at(-3) === "❯ No, exit" && lines.at(-2) === "Yes, I trust this folder")
    return ["down", "enter"];
  if (lines.at(-3) === "No, exit" && lines.at(-2) === "❯ Yes, I trust this folder")
    return ["enter"];
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
