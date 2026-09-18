import { cleanScreen, composerRange } from "./screen.js";

const normalize = (text: string) => cleanScreen(text).replace(/[\s\u2500-\u257f]/gu, "");
const trimMarkers = (text: string) => text.replace(/^[>❯›»•·▌▏↳|*-]+/u, "");

function regions(raw: string): { inside?: string[]; outside: string[] } {
  const lines = cleanScreen(raw).split("\n");
  const range = composerRange(raw);
  return range
    ? {
        inside: lines.slice(...range),
        outside: [...lines.slice(0, range[0]), ...lines.slice(range[1])],
      }
    : { outside: lines };
}

function hits(lines: string[], needle: string, strict: boolean): number {
  if (strict) return lines.filter((line) => trimMarkers(normalize(line)) === needle).length;
  return lines.map(normalize).join("").split(needle).length - 1;
}

export function composerOccupied(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const region = regions(raw);
  if (!region.inside) return raw.trim() !== "";
  return region.inside.some((line) => trimMarkers(normalize(line)) !== "");
}

export function verifyEcho(
  before: string | undefined,
  after: string | undefined,
  text: string,
  queued: boolean,
): boolean {
  if (after === undefined) return false;
  const needle = normalize(text);
  if (!needle) return false;
  const post = regions(after);
  const strict = [...needle].length < 8;
  if (!queued) return hits(post.outside, needle, strict) > 0;
  if (before === undefined) return false;
  const pre = regions(before);
  if (
    post.inside &&
    pre.inside &&
    hits(post.inside, needle, false) > hits(pre.inside, needle, false)
  )
    return true;
  return hits(post.outside, needle, strict) > hits(pre.outside, needle, strict);
}

export function verifyReceipt(
  before: string | undefined,
  after: string | undefined,
  text: string,
  receipt: string | undefined,
  queued: boolean,
): boolean {
  if (!receipt || !/^HERDR_RECEIPT_[a-f0-9]{32}$/.test(receipt) || before === undefined)
    return false;
  if (
    !text.trimEnd().endsWith(receipt) ||
    text.split(receipt).length !== 2 ||
    normalize(before).includes(receipt)
  )
    return false;
  return verifyEcho(before, after, receipt, queued);
}
