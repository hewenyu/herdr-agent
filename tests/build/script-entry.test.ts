import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { childResultDiagnosticRequired, childResultSnapshot } from "./child-result.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const modes = [
  { name: "native type stripping", flags: ["--experimental-strip-types"] },
  { name: "tsx loader", flags: ["--import", "tsx"] },
  { name: "tsx CLI", flags: [tsx] },
] as const;

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, "myrix-script-entry-"));
  t.after(async () => {
    assert.equal(await realpath(directory), directory);
    assert.equal(dirname(directory), parent);
    assert.match(basename(directory), /^myrix-script-entry-/);
    await rm(directory, { recursive: true, force: true });
  });
  const scripts = join(directory, "scripts");
  await mkdir(scripts);
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  const entry = join(scripts, "release-assets.ts");
  // Keep the publishing script independently runnable: copy only this one source file.
  await copyFile(new URL("../../scripts/release-assets.ts", import.meta.url), entry);
  const directoryAlias = join(directory, "linked scripts");
  const fileAlias = join(directory, "release alias.ts");
  await symlink(scripts, directoryAlias, "dir");
  await symlink(entry, fileAlias, "file");
  const aliasedEntry = join(directoryAlias, "release-assets.ts");
  for (const alias of [aliasedEntry, fileAlias]) {
    assert.equal(await realpath(alias), entry);
    assert.notEqual(alias, entry, "the regression fixture must retain a symlink component");
  }
  return { directory, entry, aliasedEntry, fileAlias };
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: "" },
    encoding: "utf8",
    timeout: 10_000,
  });
  // The success path stays unformatted; a failure adds only a bounded snapshot
  // of pid/status/signal/error and each stream tail to the original assertions.
  const diagnostic = childResultDiagnosticRequired(result)
    ? childResultSnapshot(result)
    : undefined;
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.signal, null, diagnostic);
  return result;
}

function assertUsage(args: string[]) {
  const result = run(args);
  // No release arguments: reaching main must stop at Usage, before any gh/network effects.
  assert.equal(result.status, 1, result.stderr || "entry silently skipped main");
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Usage: node scripts\/release-assets\.ts/);
}

for (const mode of modes) {
  test(`release CLI executes canonical and symlink entries with ${mode.name}`, async (t) => {
    const { entry, aliasedEntry, fileAlias } = await fixture(t);
    for (const path of [entry, aliasedEntry, relative(root, fileAlias)]) {
      assertUsage([...mode.flags, path]);
    }
  });
}

test("release CLI does not depend on preserve-symlinks-main", async (t) => {
  const { fileAlias } = await fixture(t);
  for (const flags of [modes[0].flags, modes[1].flags]) {
    assertUsage([...flags, fileAlias]);
    assertUsage(["--preserve-symlinks-main", ...flags, fileAlias]);
  }
});

test("importing the release module is inert even when argv names that module", async (t) => {
  const { directory, entry } = await fixture(t);
  const expression = `await import(${JSON.stringify(pathToFileURL(entry).href)}); process.stdout.write("imported-only");`;
  const importer = join(directory, "importer.mts");
  await writeFile(importer, expression);
  for (const flags of [modes[0].flags, modes[1].flags]) {
    for (const args of [
      [...flags, importer],
      [...flags, "--input-type=module", "--eval", expression],
      [...flags, "--input-type=module", "--eval", expression, entry],
    ]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "imported-only");
      assert.doesNotMatch(result.stderr, /Usage: node scripts\/release-assets\.ts/);
    }
  }
});

test("all build and release scripts use the native main guard", async () => {
  // CI executes the real build/binary/smoke bodies. This inexpensive structural
  // contract keeps all four entry guards aligned with the real CLI tests above.
  for (const name of ["build", "binary", "release-assets", "smoke"]) {
    const source = await readFile(new URL(`../../scripts/${name}.ts`, import.meta.url), "utf8");
    assert.equal(source.match(/^if \(import\.meta\.main\) \{$/gm)?.length, 1, name);
    assert.doesNotMatch(source, /pathToFileURL\(resolve\(process\.argv\[1\]\)\)/);
  }
});
