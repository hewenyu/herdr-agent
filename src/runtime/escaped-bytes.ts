/**
 * Escaped-size helpers for text that is embedded in a JSON envelope.
 *
 * A text field costs more bytes inside JSON than its own UTF-8 length: quotes
 * and backslashes double and controls use two- or six-byte escapes, while well-paired
 * astral code points keep their four UTF-8 bytes (only a lone surrogate is
 * emitted as a six-byte escape). These helpers measure that cost exactly by
 * re-serializing the text, and cut prefixes on code-point boundaries so a
 * surrogate pair is never split.
 *
 * Only the leaf JSON helper is imported; there is no dependency on the model
 * context or projection modules that consume these helpers.
 */
import { serialize } from "./json.js";

/** Escaped UTF-8 size of a text field inside a JSON envelope (quotes excluded). */
export function escapedBytes(text: string): number {
  const quoted = serialize(text);
  return quoted === undefined
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, Buffer.byteLength(quoted, "utf8") - 2);
}

/**
 * Longest prefix whose escaped size stays within `maxBytes`. The cut is made on
 * code points, so an existing surrogate pair is never split. Lone surrogates
 * remain verbatim in the prefix and are escaped when serialized to JSON.
 */
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
