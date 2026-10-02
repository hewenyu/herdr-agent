import assert from "node:assert/strict";

/**
 * Assert that a test fixture lookup actually produced a value, and return it narrowed.
 *
 * A non-null assertion would defer the failure to an incidental TypeError at the use site;
 * this keeps it an explicit AssertionError that names the fixture expectation that was violated.
 */
export function assertDefined<T>(value: T | undefined, description: string): T {
  assert.ok(value !== undefined, description);
  return value;
}
