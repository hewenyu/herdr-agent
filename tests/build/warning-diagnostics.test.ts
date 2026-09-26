import assert from "node:assert/strict";
import test from "node:test";
import { verifyWarningDiagnostics } from "../../scripts/warning-diagnostics.js";

const warning =
  "(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n";
const hint = (command: string) =>
  `(Use \`${command} --trace-warnings ...\` to show where the warning was created)\n`;
const stack =
  "    at new Store (/home/runner/work/herdr-agent/herdr-agent/dist/myrix.cjs:200353:44)\n";

test("warning checks accept myrix hints and preserve trace frames containing legacy checkout paths", () => {
  assert.doesNotThrow(() => verifyWarningDiagnostics(warning + hint("myrix"), false));
  assert.doesNotThrow(() => verifyWarningDiagnostics(warning + stack, true));
  assert.doesNotThrow(() =>
    verifyWarningDiagnostics(
      `${warning}    at new Store (/Users/herdr-agent --trace-warnings/project/myrix.cjs:1:2)\n`,
      true,
    ),
  );
  for (const trace of [false, true]) assert.doesNotThrow(() => verifyWarningDiagnostics("", trace));
});

test("warning checks reject legacy command hints even if a correct myrix hint is also present", () => {
  for (const command of ["herdr-agent", "node", "myrix-old"])
    assert.throws(
      () => verifyWarningDiagnostics(warning + hint(command), false),
      /Warning hints must identify the command as myrix/,
    );
  assert.throws(
    () => verifyWarningDiagnostics(warning + hint("myrix") + hint("herdr-agent"), false),
    /Warning hints must identify the command as myrix/,
  );
});

test("trace warnings require a stack and never retain an enable-trace hint", () => {
  for (const command of ["myrix", "herdr-agent"])
    assert.throws(
      () => verifyWarningDiagnostics(warning + stack + hint(command), true),
      /Trace mode must show the stack/,
    );
  assert.throws(
    () => verifyWarningDiagnostics(warning, true),
    /Trace mode must retain the warning stack/,
  );
  assert.throws(
    () => verifyWarningDiagnostics(warning, false),
    /Experimental warnings must include the myrix trace hint/,
  );
});
