import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { packageName, platformPackage, releaseVersion, targets } from "./config.js";
import { command, integrity, offlineEnvironment } from "./io.js";
import type { Distribution } from "./prepare.js";

export async function loadDistribution(
  directory: string,
  tag: string,
  name: string,
): Promise<Distribution> {
  packageName(name);
  const release = releaseVersion(tag);
  const distribution = JSON.parse(
    await readFile(join(directory, "distribution.json"), "utf8"),
  ) as Distribution;
  assert.equal(distribution.schema, 1);
  assert.equal(distribution.name, name);
  assert.equal(distribution.tag, tag);
  assert.equal(distribution.version, release.version);
  assert.equal(distribution.distTag, release.distTag);
  const expected = [
    ...targets.map((target) => ({ target: target.suffix, name: platformPackage(name, target) })),
    { target: "launcher", name },
  ];
  assert.equal(distribution.packages.length, expected.length);
  for (const [index, item] of distribution.packages.entries()) {
    assert.equal(item.target, expected[index]?.target);
    assert.equal(item.name, expected[index]?.name);
    assert.equal(item.version, release.version);
    assert.ok(item.tarball.endsWith(".tgz") && basename(item.tarball) === item.tarball);
    const path = resolve(directory, item.tarball);
    assert.equal(await integrity(path), item.integrity, `Tarball integrity changed: ${item.name}`);
    const manifest = JSON.parse(command("tar", ["-xOzf", path, "package/package.json"]));
    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, item.version);
    assert.equal(
      manifest.scripts,
      undefined,
      "Distribution packages must not have lifecycle scripts",
    );
    if (item.target === "launcher") {
      assert.deepEqual(manifest.bin, { myrix: "bin/myrix.cjs", "herdr-agent": "bin/myrix.cjs" });
      assert.deepEqual(
        manifest.optionalDependencies,
        Object.fromEntries(
          targets.map((target) => [platformPackage(name, target), release.version]),
        ),
      );
    } else {
      const target = targets.find((target) => target.suffix === item.target);
      assert.ok(target);
      assert.deepEqual(manifest.files, ["bin/myrix", "LICENSE", "LICENSES"]);
      assert.deepEqual(manifest.os, [target.os]);
      assert.deepEqual(manifest.cpu, [target.cpu]);
      if (target.os === "linux") assert.deepEqual(manifest.libc, ["glibc"]);
    }
  }
  return distribution;
}

/** Install the packed files offline into a disposable global prefix and run both command aliases. */
export async function verifyDistribution(
  directory: string,
  tag: string,
  name: string,
): Promise<void> {
  const distribution = await loadDistribution(directory, tag, name);
  const target = `${process.platform}-${process.arch}`;
  const native = distribution.packages.find((item) => item.target === target);
  const launcher = distribution.packages.find((item) => item.target === "launcher");
  assert.ok(native && launcher, `No npm smoke target for ${target}`);
  const temporary = await mkdtemp(join(tmpdir(), "myrix-npm-install-"));
  try {
    const prefix = join(temporary, "prefix");
    await mkdir(prefix);
    const env = offlineEnvironment(temporary);
    command(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        resolve(directory, native.tarball),
        resolve(directory, launcher.tarball),
      ],
      temporary,
      env,
    );
    for (const alias of ["myrix", "herdr-agent"]) {
      const executable = join(prefix, "bin", alias);
      const stamp = JSON.parse(command(executable, ["version", "--json"], temporary, env)) as {
        version: string;
      };
      assert.ok(
        stamp.version === tag || stamp.version === distribution.version,
        `${alias} version must match ${tag}`,
      );
      const version = command(executable, ["--version"], temporary, env);
      assert.match(version, /^myrix /, `${alias} must identify the service as myrix`);
      assert.ok(version.includes(stamp.version));
      assert.match(command(executable, ["help"], temporary, env), /serve/);
      for (const trace of [false, true]) {
        const migrated = spawnSync(
          executable,
          [
            ...(trace ? ["--trace-warnings"] : []),
            "migrate",
            "--dry-run",
            "--state-dir",
            join(temporary, `state-${alias}`),
          ],
          { cwd: temporary, env, encoding: "utf8", timeout: 10_000 },
        );
        assert.equal(migrated.status, 0, migrated.stderr || migrated.error?.message);
        assert.doesNotMatch(migrated.stderr, /herdr-agent/);
        if (migrated.stderr.includes("ExperimentalWarning"))
          assert.match(migrated.stderr, trace ? /\n\s+at / : /myrix --trace-warnings/);
      }
    }
    await writeFile(
      join(directory, "verified.json"),
      `${JSON.stringify({ schema: 1, tag, name, target, packages: distribution.packages }, null, 2)}\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function requireVerification(
  directory: string,
  distribution: Distribution,
): Promise<void> {
  const verification = JSON.parse(await readFile(join(directory, "verified.json"), "utf8"));
  assert.equal(verification.schema, 1);
  assert.equal(verification.tag, distribution.tag);
  assert.equal(verification.name, distribution.name);
  assert.ok(targets.some((target) => target.suffix === verification.target));
  assert.deepEqual(
    verification.packages,
    distribution.packages,
    "The verified package set changed; run verify again",
  );
}
