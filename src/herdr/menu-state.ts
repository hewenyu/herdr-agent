import { canonical, stableId } from "../core/ids.js";
import { cleanScreen, parseOptions } from "./screen.js";

/** Choice rows and their selection only; surrounding logs/spinners are not effect evidence. */
export function menuState(raw: string): string | undefined {
  const lines = cleanScreen(raw).split("\n");
  const selected = lines.findLastIndex((line) => /^\s*[❯›▶>]\s+\S/.test(line));
  const row = lines[selected];
  if (!row) return;
  const match = /^(\s*)[❯›▶>]\s+(\S.*)$/.exec(row);
  if (!match) return;
  const numbered = parseOptions(raw);
  if (numbered.length) {
    const key = /^(\d)[.)]\s+/.exec(match[2] ?? "")?.[1];
    if (!key || !numbered.some((option) => option.key === key)) return;
    return stableId("native-menu-v1", canonical({ options: numbered, selected: key }));
  }
  // ASCII > is also used by composers and quoted prose. It is a choice cursor
  // only when the complete numbered-menu parser establishes that boundary.
  if (/^\s*>/.test(row)) return;
  // Unnumbered choice groups use a cursor and aligned adjacent rows. If the UI
  // has no recoverable choice boundary, a blocked readback stays uncertain.
  const column = row.indexOf(match[2] ?? "");
  const option = (line: string | undefined): string | undefined => {
    if (!line?.trim() || line.search(/\S/) !== column || /^[─━═┄┈│┌└]/u.test(line.trim())) return;
    return line.trim();
  };
  const before: string[] = [],
    after: string[] = [];
  for (let i = selected - 1; i >= 0; i--) {
    const label = option(lines[i]);
    if (!label) break;
    before.unshift(label);
  }
  for (let i = selected + 1; i < lines.length; i++) {
    const label = option(lines[i]);
    if (!label) break;
    after.push(label);
  }
  const options = [...before, match[2]?.trim(), ...after];
  if (options.length < 2 || new Set(options).size !== options.length) return;
  // Aligned log lines can appear beside an unnumbered menu. They must not prove
  // a transition: only a changed cursor-marked choice can do so in this format.
  return stableId("native-unnumbered-selection-v1", match[2]?.trim() ?? "");
}
