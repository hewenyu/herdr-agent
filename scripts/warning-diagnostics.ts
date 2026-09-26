import assert from "node:assert/strict";

/** Check the command shown to users; trace frames may contain any checkout or source path. */
export function verifyWarningDiagnostics(stderr: string, trace: boolean): void {
  const hints = stderr.match(/^\(Use [^\r\n]*--trace-warnings[^\r\n]*/gm) ?? [];
  if (trace) {
    assert.deepEqual(hints, [], "Trace mode must show the stack instead of an enable-trace hint");
  } else {
    for (const hint of hints)
      assert.match(
        hint,
        /^\(Use [`'"]?myrix --trace-warnings(?:\s|[`'"])/,
        "Warning hints must identify the command as myrix",
      );
  }
  if (!stderr.includes("ExperimentalWarning")) return;
  if (trace) {
    assert.match(stderr, /^\s+at\s+\S/m, "Trace mode must retain the warning stack");
  } else {
    assert.ok(hints.length > 0, "Experimental warnings must include the myrix trace hint");
  }
}
