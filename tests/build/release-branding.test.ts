import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { releaseAssets } from "../../scripts/release-assets.js";

const targets = ["darwin_arm64", "linux_amd64", "linux_arm64"];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture(names: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "myrix-release-branding-"));
  for (const name of names) await writeFile(join(directory, name), name);
  const manifest = names.map((name) => `${digest(name)}  ${name}\n`).join("");
  await writeFile(join(directory, "SHA256SUMS"), manifest);
  return { directory, manifest, dispose: () => rm(directory, { recursive: true, force: true }) };
}

test("release restoration preserves exact names and checksums from both branding eras", async () => {
  for (const [prefix, tag] of [
    ["myrix", "v0.3.15"],
    ["herdr-agent", "v0.3.14"],
  ]) {
    const names = targets.map((target) => `${prefix}_${tag}_${target}.tar.gz`);
    const f = await fixture(names);
    try {
      const assets = await releaseAssets(tag as string, f.directory);
      assert.deepEqual(
        assets.map((asset) => asset.name),
        [...names, "SHA256SUMS"],
      );
      assert.deepEqual(
        assets.map((asset) => asset.sha256),
        [...names.map(digest), digest(f.manifest)],
      );
    } finally {
      await f.dispose();
    }
  }
});

test("release manifests cannot mix branding, tags, duplicate platforms or unrelated files", async () => {
  const tag = "v0.3.15";
  const names = targets.map((target) => `myrix_${tag}_${target}.tar.gz`);
  for (const invalid of [
    [names[0], names[1], `herdr-agent_${tag}_${targets[2]}.tar.gz`],
    [names[0], names[1], `myrix_v0.3.14_${targets[2]}.tar.gz`],
    [names[0], names[1], names[1]],
    [names[0], names[1]],
    [...names, "unrelated.tar.gz"],
    [...names].reverse(),
  ]) {
    const f = await fixture(invalid as string[]);
    try {
      await assert.rejects(releaseAssets(tag, f.directory), /SHA256SUMS/);
    } finally {
      await f.dispose();
    }
  }
});

test("legacy archives still require exact bytes and canonical checksums", async () => {
  const tag = "v0.3.14";
  const names = targets.map((target) => `herdr-agent_${tag}_${target}.tar.gz`);
  const f = await fixture(names);
  try {
    await writeFile(join(f.directory, names[0] as string), "replacement bytes");
    await assert.rejects(
      releaseAssets(tag, f.directory),
      /must match the original archives exactly/,
    );
  } finally {
    await f.dispose();
  }
});
