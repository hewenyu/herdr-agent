/**
 * Leaf JSON helpers shared by the runtime.
 *
 * `parseJson` and `plainObject` were duplicated across `model-context.ts`,
 * `recovery-envelope.ts` and `tool-results.ts`. Keeping them here keeps their
 * exact semantics in one place and lets those modules share the behavior
 * without importing one another (no cycle, no layer drift).
 */

/** JSON text for a value, or undefined when it cannot be serialized at all. */
export function serialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value ?? null) ?? "null";
  } catch {
    return undefined;
  }
}

/** Parsed value, or `undefined` when the text is not valid JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Non-null, non-array object view of a value, or `undefined` for anything else. */
export function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
