export const registry = "https://registry.npmjs.org/";
export const defaultPackageName = "@yuebanlaosiji/myrix";
export const targets = [
  { archive: "darwin_arm64", suffix: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { archive: "linux_arm64", suffix: "linux-arm64", os: "linux", cpu: "arm64" },
  { archive: "linux_amd64", suffix: "linux-x64", os: "linux", cpu: "x64" },
] as const;
export type Target = (typeof targets)[number];

export function releaseVersion(tag: string): { version: string; distTag: "latest" | "next" } {
  const numeric = "(?:0|[1-9][0-9]*)";
  const identifier = `(?:${numeric}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
  const pattern = new RegExp(
    `^v(${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?)$`,
  );
  const match = pattern.exec(tag);
  if (!match?.[1] || match[0] !== tag || tag.length > 128)
    throw new Error(
      "Release tag must be vMAJOR.MINOR.PATCH[-PRERELEASE] (strict SemVer, no build metadata)",
    );
  const version = match[1];
  if (
    version
      .split(/[.-]/)
      .slice(0, 3)
      .some((part) => !Number.isSafeInteger(Number(part)))
  )
    throw new Error("Release version exceeds the safe SemVer integer range");
  return { version, distTag: version.includes("-") ? "next" : "latest" };
}

export function packageName(input = defaultPackageName): string {
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(input) ||
    input.trim() !== input ||
    input.length > 195
  )
    throw new Error("NPM_PACKAGE_NAME must be a lowercase npm package name (up to 195 characters)");
  if (["herdr-agent", "rix", "node_modules", "favicon.ico"].includes(input))
    throw new Error(
      `NPM_PACKAGE_NAME ${input} is unavailable; use the authorized @yuebanlaosiji/myrix name or your own scope`,
    );
  return input;
}

export function platformPackage(name: string, target: Target): string {
  return `${packageName(name)}-${target.suffix}`;
}

/** No install hooks or network fallback: only the matching installed optional package is executed. */
export function launcher(name: string): string {
  const packages = Object.fromEntries(
    targets.map((target) => [target.suffix, platformPackage(name, target)]),
  );
  return `#!/usr/bin/env node
"use strict";
const { spawn } = require("node:child_process");
const { dirname, join } = require("node:path");
const packages = ${JSON.stringify(packages)};
const target = process.platform + "-" + process.arch;
const dependency = packages[target];
function fail(message) { process.stderr.write("myrix: " + message + "\\n"); process.exitCode = 1; }
if (!dependency) {
  fail("unsupported platform " + target + "; supported: " + Object.keys(packages).join(", "));
} else {
  let executable;
  try { executable = join(dirname(require.resolve(dependency + "/package.json")), "bin", "herdr-agent"); }
  catch { fail("missing native package " + dependency + ". Reinstall ${name} with optional dependencies enabled."); }
  if (executable) {
    const child = spawn(executable, process.argv.slice(2), { stdio: "inherit" });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map(signals.map(signal => [signal, () => child.kill(signal)]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    function detach() { for (const [signal, handler] of handlers) process.off(signal, handler); }
    child.on("error", error => { detach(); fail("cannot start " + target + " executable: " + error.message); });
    child.on("exit", (code, signal) => {
      detach();
      if (signal) { try { process.kill(process.pid, signal); } catch { process.exitCode = 1; } }
      else process.exitCode = code === null ? 1 : code;
    });
  }
}
`;
}

export function metadata(name: string, version: string) {
  return {
    name,
    version,
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/hewenyu/herdr-agent.git" },
    homepage: "https://github.com/hewenyu/herdr-agent#readme",
    bugs: { url: "https://github.com/hewenyu/herdr-agent/issues" },
    publishConfig: { access: "public", registry },
  };
}
