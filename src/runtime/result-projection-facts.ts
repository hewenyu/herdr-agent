/**
 * Bounded scalar facts and metadata identity for durable result references.
 *
 * A reference replaces raw content, so the only business meaning that survives
 * is what these helpers keep: outcome/error scalars, a small structural sketch,
 * and a bounded, collision-resistant form of the tool name and call id. Every
 * cap is expressed in JSON-escaped UTF-8 bytes — never character counts — so a
 * control-heavy or multibyte value cannot inflate an envelope after it was
 * bounded.
 */
import { createHash } from "node:crypto";
import { serialize } from "./model-context.js";

const MAX_FACT_CHARS = 240;
const MAX_FACT_BYTES = 240;
export const MAX_STRUCTURE_KEYS = 12;
/** Escaped-byte cap for one stored tool name or tool call id. */
export const MAX_METADATA_BYTES = 128;
const ELLIPSIS = "…";
/** Per-fact caps tried in order: the first whole envelope that fits wins. */
export const FACT_CAP_ROUNDS = [MAX_FACT_BYTES, 128, 96, 64, 32, 16, 8, 0];
/** Keys carrying outcome/error evidence; they survive every reduction round. */
export const MANDATORY_FACT_KEYS = [
  "outcome",
  "status",
  "state",
  "code",
  "errorCode",
  "errorMessage",
  "error",
  "accepted",
  "verified",
  "complete",
  "ok",
  "id",
  "taskId",
  "remoteTaskId",
];

/** Escaped UTF-8 size of a text field inside a JSON envelope (quotes excluded). */
export function escapedBytes(text: string): number {
  const quoted = serialize(text);
  return quoted === undefined
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, Buffer.byteLength(quoted, "utf8") - 2);
}

/** Code-point-safe prefix whose JSON-escaped size stays inside `maxBytes`. */
export function escapedPrefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let result = "";
  let used = 0;
  for (const character of text) {
    const size = escapedBytes(character);
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return result;
}

/** Bounded scalar fact, kept verbatim in meaning but capped in escaped bytes. */
export function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return truncate(value);
  return undefined;
}

export function truncate(value: string, max = MAX_FACT_CHARS): string {
  const capped = value.length > max ? value.slice(0, max) : value;
  return truncateEscaped(capped, MAX_FACT_BYTES, max);
}

/**
 * Truncate one fact by characters AND escaped bytes, keeping the ellipsis
 * itself inside the byte cap so the final serialized envelope cannot grow.
 */
export function truncateEscaped(value: string, maxBytes: number, maxChars: number): string {
  const capped = value.length > maxChars ? value.slice(0, maxChars) : value;
  if (capped === value && escapedBytes(capped) <= maxBytes) return value;
  if (maxBytes <= escapedBytes(ELLIPSIS)) return escapedPrefix(capped, maxBytes);
  return `${escapedPrefix(capped, maxBytes - escapedBytes(ELLIPSIS))}${ELLIPSIS}`;
}

/**
 * Keep a readable prefix of an oversized identity while staying unique: the
 * digest suffix makes two long names that share a prefix distinguishable. The
 * cap counts JSON-escaped bytes, so control-heavy ids cannot expand the
 * envelope past the model budget after re-serialization.
 */
export function boundedMetadata(
  value: string,
  identity: string,
  maxBytes = MAX_METADATA_BYTES,
): string {
  if (escapedBytes(value) <= maxBytes) return value;
  const suffix = `#${identity}`;
  return `${escapedPrefix(value, Math.max(0, maxBytes - escapedBytes(suffix)))}${suffix}`;
}

/** Stable, short, non-reversible identity for last-resort metadata display. */
export function metadataDigest(value: string): string {
  return `#${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

/** Unique identity of one (tool, call) pair, used only to disambiguate prefixes. */
export function metadataIdentity(tool: string, toolCallId: string, separator = "\u001f"): string {
  return createHash("sha256")
    .update(tool)
    .update(separator)
    .update(toolCallId)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Candidate fact maps from most to least detailed. Values are capped by escaped
 * bytes, and later rounds keep only the keys that carry outcome/error evidence,
 * so the caller can always find a representation inside the byte budget.
 */
export function factCandidates(
  facts: Record<string, string | number | boolean> | undefined,
): Array<Record<string, string | number | boolean> | undefined> {
  const keys = Object.keys(facts ?? {});
  if (!facts || !keys.length) return [undefined];
  const reduced: Array<Record<string, string | number | boolean> | undefined> = [];
  for (const cap of FACT_CAP_ROUNDS) {
    reduced.push(cappedFacts(facts, keys, cap), cappedFacts(facts, mandatoryKeys(keys), cap));
  }
  return reduced;
}

export function mandatoryKeys(keys: string[]): string[] {
  return keys.filter((name) => MANDATORY_FACT_KEYS.includes(name));
}

export function cappedFacts(
  facts: Record<string, string | number | boolean>,
  keys: string[],
  cap: number,
): Record<string, string | number | boolean> | undefined {
  if (!keys.length) return undefined;
  const result: Record<string, string | number | boolean> = {};
  for (const name of keys) {
    const value = facts[name];
    if (value === undefined) continue;
    result[name] = typeof value === "string" ? truncateEscaped(value, cap, cap) : value;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Smallest candidate that fits the model budget; `fallback` must always fit. */
export function firstBounded<T>(candidates: T[], fallback: T): T;
export function firstBounded<T>(candidates: T[], fallback: undefined): T | undefined;
export function firstBounded<T>(candidates: T[], fallback: T | undefined): T | undefined {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    if (
      (serialize(candidate) === undefined ? Number.MAX_SAFE_INTEGER : bytesOf(candidate)) <= 16384
    )
      return candidate;
  }
  return fallback;
}

function bytesOf(value: unknown): number {
  const text = serialize(value);
  return text === undefined ? Number.MAX_SAFE_INTEGER : Buffer.byteLength(text, "utf8");
}
