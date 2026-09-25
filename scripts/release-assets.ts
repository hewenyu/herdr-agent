import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface LocalAsset {
  name: string;
  path: string;
  size: number;
  sha256: string;
}
export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  state: string;
  digest?: string | null;
}
export interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
  immutable?: boolean;
}
export interface ReleasePort {
  tagCommit(tag: string): Promise<string>;
  find(tag: string): Promise<Release | undefined>;
  create(tag: string, notes?: string): Promise<void>;
  publish(tag: string): Promise<void>;
  assets(release: Release): Promise<ReleaseAsset[]>;
  hash(asset: ReleaseAsset): Promise<string>;
  upload(tag: string, asset: LocalAsset): Promise<void>;
}

export async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Use only the three original build archives and their exact checksum manifest. */
export async function releaseAssets(tag: string, directory: string): Promise<LocalAsset[]> {
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Expected a vSEMVER tag");
  const names = ["darwin_arm64", "linux_arm64", "linux_amd64"]
    .map((target) => `herdr-agent_${tag}_${target}.tar.gz`)
    .sort();
  const assets: LocalAsset[] = [];
  for (const name of [...names, "SHA256SUMS"]) {
    const path = resolve(directory, name);
    const stat = await lstat(path);
    assert.ok(stat.isFile() && stat.size > 0, `Expected a nonempty regular file: ${name}`);
    assets.push({ name, path, size: stat.size, sha256: await sha256(path) });
  }
  const checksums = assets
    .slice(0, -1)
    .map((asset) => `${asset.sha256}  ${asset.name}\n`)
    .join("");
  assert.equal(
    await readFile(resolve(directory, "SHA256SUMS"), "utf8"),
    checksums,
    "SHA256SUMS must match the original archives exactly",
  );
  return assets;
}

async function matches(port: ReleasePort, remote: ReleaseAsset, local: LocalAsset): Promise<void> {
  assert.equal(remote.state, "uploaded", `Incomplete existing asset: ${local.name}`);
  assert.equal(remote.size, local.size, `Existing asset size differs: ${local.name}`);
  const digest = /^sha256:[a-f0-9]{64}$/i.test(remote.digest ?? "")
    ? remote.digest?.slice(7).toLowerCase()
    : await port.hash(remote);
  assert.equal(digest, local.sha256, `Existing asset SHA-256 differs: ${local.name}`);
}

async function inspect(
  port: ReleasePort,
  release: Release,
  expected: LocalAsset[],
): Promise<LocalAsset[]> {
  const remote = await port.assets(release);
  const missing: LocalAsset[] = [];
  for (const local of expected) {
    const sameName = remote.filter((asset) => asset.name === local.name);
    assert.ok(sameName.length <= 1, `Duplicate existing asset name: ${local.name}`);
    if (sameName[0]) await matches(port, sameName[0], local);
    else missing.push(local);
  }
  return missing;
}

/** Preflight the complete existing set before writing; never edit release notes or replace assets. */
export async function publishAssets(
  port: ReleasePort,
  tag: string,
  commit: string,
  expected: LocalAsset[],
  notes?: string,
): Promise<{ uploaded: string[]; skipped: string[] }> {
  assert.match(commit, /^[a-f0-9]{40}$/i, "Expected the full original build commit SHA");
  assert.equal(
    await port.tagCommit(tag),
    commit,
    "Release tag no longer points to the original build commit",
  );
  let release = await port.find(tag);
  if (!release) {
    try {
      await port.create(tag, notes);
    } catch (error) {
      // A create may succeed remotely before its response is lost. Re-read;
      // never create a second release or overwrite metadata to repair the ACK.
      release = await port.find(tag);
      if (!release) throw error;
    }
    release ??= await port.find(tag);
  }
  assert.ok(release, "Created release could not be confirmed");
  assert.equal(release.tag_name, tag, "Release lookup returned a different tag");
  const missing = await inspect(port, release, expected);
  assert.ok(
    !release.immutable || !missing.length,
    "Immutable release is missing assets; refusing mutation",
  );
  const uploaded: string[] = [];
  for (const local of missing) {
    assert.equal((await lstat(local.path)).size, local.size, `Local asset changed: ${local.name}`);
    assert.equal(await sha256(local.path), local.sha256, `Local asset changed: ${local.name}`);
    try {
      await port.upload(tag, local);
    } catch (error) {
      // A racing uploader or lost upload ACK is safe only when the exact
      // remote bytes are now proven. Missing or conflicting data stays failed.
      const remaining = await inspect(port, release, expected);
      if (remaining.some((asset) => asset.name === local.name)) throw error;
    }
    uploaded.push(local.name);
  }
  assert.deepEqual(await inspect(port, release, expected), [], "Release assets remain incomplete");
  assert.equal(await port.tagCommit(tag), commit, "Release tag changed during publication");
  if (release.draft) {
    try {
      await port.publish(tag);
    } catch (error) {
      const current = await port.find(tag);
      if (!current || current.tag_name !== tag || current.draft) throw error;
    }
    const published = await port.find(tag);
    assert.ok(
      published && published.tag_name === tag && !published.draft,
      "Release publication was not confirmed",
    );
    assert.deepEqual(
      await inspect(port, published, expected),
      [],
      "Published release assets remain incomplete",
    );
  }
  return {
    uploaded,
    skipped: expected.filter((asset) => !missing.includes(asset)).map((asset) => asset.name),
  };
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
type Command = (args: string[]) => CommandResult;
function run(args: string[]): CommandResult {
  return spawnSync("gh", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}

/** Only a real HTTP 404 is absence. Authentication, network and parse failures are errors. */
export function apiResponse(result: CommandResult, allowMissing = false): unknown {
  if (result.error) throw new Error(`GitHub request failed: ${result.error.message}`);
  const header = result.stdout.match(/^HTTP\/\S+\s+(\d{3})[^\r\n]*\r?\n/);
  const status = Number(header?.[1]);
  if (allowMissing && status === 404) return undefined;
  if (result.status !== 0 || status < 200 || status >= 300 || !header)
    throw new Error(
      `GitHub request failed (HTTP ${header?.[1] ?? "unknown"}, exit ${result.status})`,
    );
  const separator = result.stdout.match(/\r?\n\r?\n/);
  if (separator?.index === undefined) throw new Error("GitHub response has no JSON body");
  return JSON.parse(result.stdout.slice(separator.index + separator[0].length));
}

export function githubPort(repository: string, command: Command = run): ReleasePort {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Expected OWNER/REPO");
  const base = `repos/${repository}`;
  const api = (path: string, missing = false) =>
    apiResponse(command(["api", "--hostname", "github.com", "--include", path]), missing);
  const checkedRelease = (value: unknown, tag: string): Release => {
    assert.ok(value && typeof value === "object", "Invalid release response");
    const release = value as Release;
    assert.ok(Number.isSafeInteger(release.id) && release.id > 0, "Invalid release ID");
    assert.equal(release.tag_name, tag, "Release lookup returned a different tag");
    assert.equal(typeof release.draft, "boolean", "Invalid release state");
    return release;
  };
  return {
    async tagCommit(tag) {
      let object = (
        api(`${base}/git/ref/tags/${encodeURIComponent(tag)}`) as {
          object: { type: string; sha: string };
        }
      ).object;
      const seen = new Set<string>();
      while (object.type === "tag") {
        assert.ok(!seen.has(object.sha), "Cyclic annotated tag");
        seen.add(object.sha);
        object = (api(`${base}/git/tags/${object.sha}`) as { object: typeof object }).object;
      }
      assert.equal(object.type, "commit", "Release tag must resolve to a commit");
      return object.sha;
    },
    async find(tag) {
      const value = api(`${base}/releases/tags/${encodeURIComponent(tag)}`, true);
      if (value !== undefined) return checkedRelease(value, tag);
      // The by-tag endpoint only promises published releases. Authenticated
      // writers can see drafts in this list, including interrupted prior runs.
      for (let page = 1; ; page++) {
        const batch = api(`${base}/releases?per_page=100&page=${page}`);
        assert.ok(Array.isArray(batch), "GitHub release list is not an array");
        const matching = batch.filter((item) => item?.tag_name === tag);
        assert.ok(matching.length <= 1, "Duplicate releases for the requested tag");
        if (matching.length) return checkedRelease(matching[0], tag);
        if (batch.length < 100) return;
      }
    },
    async create(tag, notes) {
      const args = [
        "release",
        "create",
        tag,
        "--repo",
        `github.com/${repository}`,
        "--verify-tag",
        "--draft",
        "--title",
        `herdr-agent ${tag}`,
      ];
      if (notes) args.push("--notes-file", notes);
      else args.push("--notes", "");
      if (tag.includes("-")) args.push("--prerelease");
      const result = command(args);
      if (result.error || result.status !== 0)
        throw new Error("GitHub release creation was not confirmed");
    },
    async publish(tag) {
      const result = command([
        "release",
        "edit",
        tag,
        "--repo",
        `github.com/${repository}`,
        "--draft=false",
      ]);
      if (result.error || result.status !== 0)
        throw new Error("GitHub release publication was not confirmed");
    },
    async assets(release) {
      const assets: ReleaseAsset[] = [];
      for (let page = 1; ; page++) {
        const batch = api(`${base}/releases/${release.id}/assets?per_page=100&page=${page}`);
        assert.ok(Array.isArray(batch), "GitHub asset list is not an array");
        assets.push(...batch);
        if (batch.length < 100) return assets;
      }
    },
    async hash(asset) {
      assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, "Invalid release asset ID");
      const directory = await mkdtemp(join(tmpdir(), "herdr-release-asset-"));
      try {
        const path = join(directory, "asset");
        const fd = openSync(path, "wx", 0o600);
        let result: ReturnType<typeof spawnSync>;
        try {
          // Stream binary output to disk: native archives exceed text-buffer limits.
          result = spawnSync(
            "gh",
            [
              "api",
              "--hostname",
              "github.com",
              `${base}/releases/assets/${asset.id}`,
              "-H",
              "Accept: application/octet-stream",
            ],
            { stdio: ["ignore", fd, "pipe"], timeout: 120_000 },
          );
        } finally {
          closeSync(fd);
        }
        if (result.error || result.status !== 0)
          throw new Error(`Cannot read existing release asset: ${asset.name}`);
        assert.equal(
          (await lstat(path)).size,
          asset.size,
          `Downloaded asset size differs: ${asset.name}`,
        );
        return await sha256(path);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async upload(tag, asset) {
      const result = command([
        "release",
        "upload",
        tag,
        asset.path,
        "--repo",
        `github.com/${repository}`,
      ]);
      if (result.error || result.status !== 0)
        throw new Error(`Upload was not confirmed: ${asset.name}`);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [repository, tag, commit, directory, notes] = process.argv.slice(2);
  if (!repository || !tag || !commit || !directory)
    throw new Error(
      "Usage: node scripts/release-assets.ts OWNER/REPO TAG ORIGINAL_COMMIT ARCHIVES_DIR [NOTES_FILE]",
    );
  const assets = await releaseAssets(tag, directory);
  const result = await publishAssets(githubPort(repository), tag, commit, assets, notes);
  process.stdout.write(
    `Release ${tag}: ${result.uploaded.length} missing assets uploaded, ${result.skipped.length} identical assets retained.\n`,
  );
}
