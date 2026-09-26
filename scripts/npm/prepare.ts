import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  launcher,
  metadata,
  packageName,
  platformPackage,
  releaseVersion,
  type Target,
  targets,
} from "./config.js";
import { command, extract, integrity, offlineEnvironment, safeTree } from "./io.js";

export interface PackedPackage {
  name: string;
  version: string;
  target: string;
  tarball: string;
  integrity: string;
}
export interface Distribution {
  schema: 1;
  name: string;
  tag: string;
  version: string;
  distTag: "latest" | "next";
  packages: PackedPackage[];
}

export function verifyArchitecture(bytes: Buffer, target: Target): void {
  if (target.os === "darwin") {
    assert.ok(
      bytes.length >= 8 &&
        bytes.readUInt32LE(0) === 0xfeedfacf &&
        bytes.readUInt32LE(4) === 0x0100000c,
      "Expected a macOS arm64 Mach-O executable",
    );
  } else {
    assert.ok(
      bytes.length >= 20 &&
        bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
        bytes[4] === 2 &&
        bytes[5] === 1,
      "Expected a little-endian 64-bit ELF executable",
    );
    assert.equal(
      bytes.readUInt16LE(18),
      target.cpu === "x64" ? 62 : 183,
      `Wrong ELF architecture for ${target.suffix}`,
    );
  }
}

async function json(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function pack(
  directory: string,
  destination: string,
  target: string,
  env: NodeJS.ProcessEnv,
): Promise<PackedPackage> {
  const result = JSON.parse(
    command(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
      directory,
      env,
    ),
  ) as Array<{
    name: string;
    version: string;
    filename: string;
    integrity: string;
    files: Array<{ path: string; mode: number }>;
  }>;
  assert.equal(result.length, 1);
  const packed = result[0];
  assert.ok(packed && basename(packed.filename) === packed.filename);
  assert.equal(await integrity(join(destination, packed.filename)), packed.integrity);
  const executable = target === "launcher" ? "bin/myrix.cjs" : "bin/myrix";
  assert.ok(
    (packed.files.find((file) => file.path === executable)?.mode ?? 0) & 0o111,
    `${executable} lost its executable mode during npm pack`,
  );
  if (target !== "launcher")
    for (const file of await safeTree(join(directory, "LICENSES")))
      assert.ok(
        packed.files.some((entry) => entry.path === `LICENSES/${file}`),
        `npm pack omitted LICENSES/${file}`,
      );
  return {
    name: packed.name,
    version: packed.version,
    target,
    tarball: packed.filename,
    integrity: packed.integrity,
  };
}

export async function prepareDistribution(
  tag: string,
  name: string,
  archives: string,
  output: string,
): Promise<Distribution> {
  packageName(name);
  const release = releaseVersion(tag);
  const destination = resolve(output);
  await mkdir(destination, { recursive: true });
  assert.deepEqual(await safeTree(destination), [], "Distribution output must be empty");
  const temporary = await mkdtemp(join(tmpdir(), "myrix-npm-prepare-"));
  const distribution: Distribution = { schema: 1, tag, name, ...release, packages: [] };
  const env = offlineEnvironment(temporary);
  try {
    let projectLicense: Buffer | undefined;
    for (const target of targets) {
      const unpacked = join(temporary, `archive-${target.suffix}`);
      await extract(join(archives, `myrix_${tag}_${target.archive}.tar.gz`), unpacked);
      const binary = join(unpacked, "myrix");
      assert.ok(
        (await lstat(binary)).mode & 0o111,
        `${target.suffix} archive binary is not executable`,
      );
      verifyArchitecture(await readFile(binary), target);
      const license = await readFile(join(unpacked, "LICENSE"));
      assert.ok(license.length > 0);
      if (projectLicense)
        assert.ok(projectLicense.equals(license), "Platform project licenses differ");
      projectLicense = license;
      for (const required of ["manifest.json", "NODE-LICENSE.txt", "README.md"])
        assert.ok(
          (await readFile(join(unpacked, "LICENSES", required))).length > 0,
          `Missing ${target.suffix} ${required}`,
        );
      const directory = join(temporary, target.suffix);
      await mkdir(join(directory, "bin"), { recursive: true });
      await copyFile(binary, join(directory, "bin/myrix"));
      await chmod(join(directory, "bin/myrix"), 0o755);
      await cp(join(unpacked, "LICENSES"), join(directory, "LICENSES"), { recursive: true });
      await writeFile(join(directory, "LICENSE"), license);
      await json(join(directory, "package.json"), {
        ...metadata(platformPackage(name, target), release.version),
        description: `Native myrix executable (${target.suffix})`,
        os: [target.os],
        cpu: [target.cpu],
        ...(target.os === "linux" ? { libc: ["glibc"] } : {}),
        files: ["bin/myrix", "LICENSE", "LICENSES"],
      });
      distribution.packages.push(await pack(directory, destination, target.suffix, env));
    }
    assert.ok(projectLicense);
    const directory = join(temporary, "launcher");
    await mkdir(join(directory, "bin"), { recursive: true });
    await writeFile(join(directory, "bin/myrix.cjs"), launcher(name), { mode: 0o755 });
    await writeFile(join(directory, "LICENSE"), projectLicense);
    await writeFile(
      join(directory, "README.md"),
      [
        `# ${name}`,
        "",
        `Install with \`npm install -g ${name}\`. Run \`myrix setup\`, then \`myrix serve\`. The \`herdr-agent\` command is a compatibility alias.`,
        "",
        "Node >=18 runs the launcher; the native executable includes its own runtime. Supported targets: macOS arm64, Linux arm64 and Linux x64 (glibc). Keep optional dependencies enabled. herdr and authenticated Claude/Codex executors are separate prerequisites.",
        "",
        "Each native package includes the complete LICENSES directory, which must accompany redistribution. No install script downloads or executes code.",
        "",
      ].join("\n"),
    );
    await json(join(directory, "package.json"), {
      ...metadata(name, release.version),
      description: "pi orchestration for herdr-managed Claude and Codex",
      engines: { node: ">=18" },
      bin: { myrix: "bin/myrix.cjs", "herdr-agent": "bin/myrix.cjs" },
      files: ["bin/myrix.cjs", "LICENSE", "README.md"],
      optionalDependencies: Object.fromEntries(
        targets.map((target) => [platformPackage(name, target), release.version]),
      ),
    });
    distribution.packages.push(await pack(directory, destination, "launcher", env));
    await json(join(destination, "distribution.json"), distribution);
    return distribution;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
