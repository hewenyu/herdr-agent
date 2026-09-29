import { canonical, stableId } from "../core/ids.js";
import { cleanScreen, hasEnterConfirmation, parseOptions } from "./screen.js";

export interface NativeMenuOption {
  id: string;
  label: string;
}

export interface NativeMenu {
  options: NativeMenuOption[];
  /** -1 means a shortcut prompt advertises no default. */
  selected: number;
  confirmation: "enter" | "shortcut";
  shortcuts?: Array<"y" | "n">;
}

function nativeOptions(labels: string[], context = ""): NativeMenuOption[] {
  const identity = stableId("native-options-v1", context, canonical(labels));
  return labels.map((label, index) => ({ id: `option:${index + 1}:${identity}`, label }));
}

/** Explicit y/n prompts use their advertised letters, never an inferred Enter. */
function shortcutMenu(lines: string[]): NativeMenu | undefined {
  const tail = lines.filter((line) => line.trim()).slice(-3);
  const position = tail.findLastIndex((line) =>
    /[[(][yYnN]\s*[/|]\s*[yYnN][\])]\s*:?\s*$/.test(line),
  );
  if (
    position < 0 ||
    tail
      .slice(position + 1)
      .some((line) => !/^\s*(?:Only|Press|Type|Enter)\s+[yn]\s+(?:or|\/)\s+[yn]\b/i.test(line))
  )
    return;
  const prompt = tail[position]?.trim();
  if (!prompt) return;
  const match = /[[(]([yYnN])\s*[/|]\s*([yYnN])[\])]\s*:?\s*$/.exec(prompt);
  if (!match?.[1] || !match[2] || match[1].toLowerCase() === match[2].toLowerCase()) return;
  const letters = [match[1], match[2]];
  const defaults = letters.filter((letter) => letter === letter.toUpperCase());
  if (defaults.length > 1) return;
  const shortcuts = letters.map((letter) => letter.toLowerCase() as "y" | "n");
  return {
    options: nativeOptions(
      shortcuts.map((key) => (key === "y" ? "Yes (y)" : "No (n)")),
      tail.slice(position).join("\n"),
    ),
    selected: defaults.length ? letters.indexOf(defaults[0] as string) : -1,
    confirmation: "shortcut",
    shortcuts,
  };
}

/**
 * Native cursor menus expose semantic targets, not numeric keyboard shortcuts.
 * No particular warning, product version, or option wording is required.
 * Ambiguous/partial choice groups remain manual rather than inventing controls.
 */
export function nativeMenu(raw: string): NativeMenu | undefined {
  const lines = cleanScreen(raw).split("\n");
  const shortcut = shortcutMenu(lines);
  if (shortcut) return shortcut;
  const selectedLine = lines.findLastIndex((line) => /^\s*[❯›▶>]\s+\S/.test(line));
  const row = lines[selectedLine];
  if (!row || !hasEnterConfirmation(lines.slice(selectedLine + 1))) return;
  const match = /^(\s*)[❯›▶>]\s+(\S.*)$/.exec(row);
  if (!match) return;
  const numbered = parseOptions(raw);
  let labels: string[];
  let selected: number;
  if (numbered.length) {
    const number = /^([1-9])[.)]\s+/.exec(match[2] ?? "")?.[1];
    selected = numbered.findIndex((option) => option.key === number);
    labels = numbered.map((option) => option.label);
  } else {
    // ASCII > also marks composers and quotations. Only numbered parsing can
    // establish it as a menu cursor. A failed numbered menu is not unnumbered.
    if (/^\s*>/.test(row) || /^[1-9][.)]\s+/.test(match[2] ?? "")) return;
    const column = row.indexOf(match[2] ?? "");
    const option = (line: string | undefined): string | undefined => {
      if (
        !line?.trim() ||
        line.search(/\S/) !== column ||
        /^[─━═┄┈│┌└❯›▶>]/u.test(line.trim()) ||
        hasEnterConfirmation([line])
      )
        return;
      return line.trim();
    };
    const before: string[] = [],
      after: string[] = [];
    for (let index = selectedLine - 1; index >= 0; index--) {
      const label = option(lines[index]);
      if (!label) break;
      before.unshift(label);
    }
    for (let index = selectedLine + 1; index < lines.length; index++) {
      const label = option(lines[index]);
      if (!label) break;
      after.push(label);
    }
    labels = [...before, (match[2] ?? "").trim(), ...after];
    selected = before.length;
  }
  if (selected < 0 || labels.length < 2 || new Set(labels).size !== labels.length) return;
  // Include all labels and order: a selector's old ID cannot address a changed
  // menu, while moving the cursor preserves the same semantic target IDs.
  return {
    options: nativeOptions(labels),
    selected,
    confirmation: "enter",
  };
}

export interface NativeMenuAction {
  key: "up" | "down" | "enter" | "y" | "n";
  beforeOptionId?: string;
  targetOptionId: string;
  expectedOptionId: string;
}

/** One guarded effect per observation. Navigation must be read back before Enter. */
export function menuAction(menu: NativeMenu, targetOptionId: string): NativeMenuAction | undefined {
  const target = menu.options.findIndex((option) => option.id === targetOptionId);
  const before = menu.options[menu.selected];
  if (target < 0) return;
  if (menu.confirmation === "shortcut") {
    const key = menu.shortcuts?.[target];
    return key
      ? { key, beforeOptionId: before?.id, targetOptionId, expectedOptionId: targetOptionId }
      : undefined;
  }
  if (!before) return;
  const step = Math.sign(target - menu.selected);
  const expected = menu.options[menu.selected + step];
  if (!expected) return;
  return {
    key: step === 0 ? menu.confirmation : step > 0 ? "down" : "up",
    beforeOptionId: before.id,
    targetOptionId,
    expectedOptionId: expected.id,
  };
}
