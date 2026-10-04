/**
 * Test-only builder for the long verification startup fixture.
 *
 * The long fixture attempts two fixed, bounded stderr breadcrumbs: a POSIX shell builtin
 * `printf` immediately before `exec`, and one `fs.writeSync(2, ...)` in the child program right
 * after `node:fs` loads and before the marker write. They are positive observations only: a
 * missing breadcrumb proves nothing, and a present Node stage proves only that JavaScript reached
 * that write, not that the marker write or the release poll ever completed. This module adds no
 * product behavior and establishes no root cause for any run.
 */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Fixed shell-stage breadcrumb text, written to stderr by the shell builtin before `exec`. */
export const shellStage = "herdr-verify-fixture:shell";

/** Fixed Node-stage breadcrumb text, written to fd 2 right after `node:fs` loads. */
export const nodeStage = "herdr-verify-fixture:node";

/** Fixed release-file poll delay, so the child never busy-waits or logs per poll. */
export const releasePollMs = 10;

export interface VerificationStartupFixtureOptions {
  /** Pinned interpreter the shell must `exec`, keeping the child in the shell's pid and group. */
  node: string;
  /** Marker file that receives the child's `process.cwd()` bytes and no trailing newline. */
  marker: string;
  /** Release file whose appearance clears the poll and exits the child with code 0. */
  release: string;
}

export interface VerificationStartupFixture {
  /** Shell command handed to the verification runner, which executes it through `/bin/sh -c`. */
  command: string;
  /** Emitted Node program, so deterministic tests can evaluate it without spawning a process. */
  script: string;
}

/** Builds the long fixture's command and script; it spawns no process and writes no file. */
export function buildVerificationStartupFixture(
  options: VerificationStartupFixtureOptions,
): VerificationStartupFixture {
  const { node, marker, release } = options;
  const stageLine = JSON.stringify(`${nodeStage}\n`);
  const releasePath = JSON.stringify(release);
  const poll = [
    "const timer = setInterval(() => {",
    `if (fs.existsSync(${releasePath})) {`,
    "clearInterval(timer); process.exit(0); } },",
    `${releasePollMs});`,
  ].join(" ");
  const script = [
    "const fs = require('node:fs');",
    `try { fs.writeSync(2, ${stageLine}); } catch { /* Diagnostic only. */ }`,
    `fs.writeFileSync(${JSON.stringify(marker)}, process.cwd());`,
    poll,
  ].join(" ");
  // Ignore diagnostic write failures even with errexit; only marker/poll failures are fatal.
  const execLine = `exec ${shellQuote(node)} -e ${shellQuote(script)}`;
  const command = `printf '%s\\n' ${shellQuote(shellStage)} >&2 || :; ${execLine}`;
  return { command, script };
}
