import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
  create(tag: string, notes?: string): Promise<Release>;
  get(release: Release): Promise<Release | undefined>;
  publish(release: Release): Promise<Release>;
  assets(release: Release): Promise<ReleaseAsset[]>;
  hash(asset: ReleaseAsset): Promise<string>;
  upload(release: Release, asset: LocalAsset): Promise<void>;
}

export async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function archiveNames(tag: string, prefix: string): string[] {
  return ["darwin_arm64", "linux_arm64", "linux_amd64"]
    .map((target) => `${prefix}_${tag}_${target}.tar.gz`)
    .sort();
}

/** Preserve original bytes and names when restoring releases from either branding era. */
export async function releaseAssets(tag: string, directory: string): Promise<LocalAsset[]> {
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Expected a vSEMVER tag");
  const manifest = await readFile(resolve(directory, "SHA256SUMS"), "utf8");
  const entries = manifest.split("\n");
  const names = ["myrix", "herdr-agent"]
    .map((prefix) => archiveNames(tag, prefix))
    .find(
      (candidate) =>
        entries.length === 4 &&
        entries[3] === "" &&
        candidate.every((name, index) => entries[index]?.slice(66) === name),
    );
  assert.ok(
    names,
    "SHA256SUMS must list exactly three sorted myrix or legacy herdr-agent archives from one release",
  );
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
  assert.equal(manifest, checksums, "SHA256SUMS must match the original archives exactly");
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
  const localNames = new Set(expected.map((asset) => asset.name));
  const installers = new Set(
    ["myrix", "herdr-agent"].flatMap((prefix) => archiveNames(release.tag_name, prefix)),
  );
  const conflict = remote.find(
    (asset) => installers.has(asset.name) && !localNames.has(asset.name),
  );
  assert.ok(!conflict, `Conflicting release archive branding: ${conflict?.name}`);
  const missing: LocalAsset[] = [];
  for (const local of expected) {
    const sameName = remote.filter((asset) => asset.name === local.name);
    assert.ok(sameName.length <= 1, `Duplicate existing asset name: ${local.name}`);
    if (sameName[0]) await matches(port, sameName[0], local);
    else missing.push(local);
  }
  return missing;
}

function checkedRelease(value: unknown, tag: string, id?: number): Release {
  assert.ok(value && typeof value === "object", "Invalid release response");
  const release = value as Release;
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, "Invalid release ID");
  if (id !== undefined) assert.equal(release.id, id, "Release ID changed");
  assert.equal(release.tag_name, tag, "Release lookup returned a different tag");
  assert.equal(typeof release.draft, "boolean", "Invalid release state");
  return release;
}

export class GitHubRequestError extends Error {
  recoverable: boolean;
  constructor(message: string, recoverable: boolean) {
    super(message);
    this.recoverable = recoverable;
  }
}

type Wait = (milliseconds: number) => Promise<unknown>;

/** Retry only confirmation reads after an uncertain ACK, never repeat the mutation. */
async function recover<T>(
  error: unknown,
  read: () => Promise<T | undefined>,
  wait: Wait,
): Promise<T> {
  if (!(error instanceof GitHubRequestError) || !error.recoverable) throw error;
  for (const milliseconds of [0, 200, 500, 1_000, 2_000, 4_000]) {
    if (milliseconds) await wait(milliseconds);
    try {
      const result = await read();
      if (result !== undefined) return result;
    } catch (readError) {
      if (!(readError instanceof GitHubRequestError) || !readError.recoverable) throw readError;
    }
  }
  throw error;
}

/** Preflight the complete existing set before writing; never edit release notes or replace assets. */
export async function publishAssets(
  port: ReleasePort,
  tag: string,
  commit: string,
  expected: LocalAsset[],
  notes?: string,
  wait: Wait = delay,
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
      // The successful response identifies the draft even before tag/list lookups expose it.
      release = checkedRelease(await port.create(tag, notes), tag);
      assert.equal(release.draft, true, "New release must remain draft until assets are verified");
    } catch (error) {
      release = await recover(error, () => port.find(tag), wait);
    }
  }
  release = checkedRelease(release, tag);
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
      await port.upload(release, local);
    } catch (error) {
      // A lost ACK is safe only when the same release now has the exact expected bytes.
      await recover(
        error,
        async () => {
          const remaining = await inspect(port, release, expected);
          return remaining.some((asset) => asset.name === local.name) ? undefined : true;
        },
        wait,
      );
    }
    uploaded.push(local.name);
  }
  assert.deepEqual(await inspect(port, release, expected), [], "Release assets remain incomplete");
  assert.equal(await port.tagCommit(tag), commit, "Release tag changed during publication");
  if (release.draft) {
    let published: Release;
    try {
      published = checkedRelease(await port.publish(release), tag, release.id);
      assert.equal(published.draft, false, "Release publication was not confirmed");
    } catch (error) {
      published = await recover(
        error,
        async () => {
          const current = await port.get(release);
          if (!current) return;
          checkedRelease(current, tag, release.id);
          return current.draft ? undefined : current;
        },
        wait,
      );
    }
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
type Command = (args: string[], input?: string) => CommandResult;
function run(args: string[], input?: string): CommandResult {
  return spawnSync("gh", args, {
    input,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Only a real HTTP 404 is absence. Authentication, network and parse failures are errors. */
export function apiResponse(
  result: CommandResult,
  allowMissing = false,
  expectedStatus?: number,
): unknown {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new GitHubRequestError(
      `GitHub request failed: ${result.error.message}`,
      !code || ["ETIMEDOUT", "ENOBUFS"].includes(code),
    );
  }
  const header = result.stdout.match(/^HTTP\/\S+\s+(\d{3})[^\r\n]*\r?\n/);
  const status = Number(header?.[1]);
  if (allowMissing && status === 404) return undefined;
  if (result.status !== 0 || status < 200 || status >= 300 || !header)
    throw new GitHubRequestError(
      `GitHub request failed (HTTP ${header?.[1] ?? "unknown"}, exit ${result.status})`,
      !header || status >= 500 || [408, 409, 422].includes(status),
    );
  if (expectedStatus !== undefined && status !== expectedStatus)
    throw new GitHubRequestError(`Expected HTTP ${expectedStatus}, received ${status}`, false);
  const separator = result.stdout.match(/\r?\n\r?\n/);
  if (separator?.index === undefined)
    throw new GitHubRequestError("GitHub response has no JSON body", false);
  try {
    return JSON.parse(result.stdout.slice(separator.index + separator[0].length));
  } catch {
    throw new GitHubRequestError("GitHub response has invalid JSON", false);
  }
}

export function githubPort(repository: string, command: Command = run): ReleasePort {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Expected OWNER/REPO");
  const base = `repos/${repository}`;
  const apiArgs = ["api", "--hostname", "github.com", "--include"];
  const api = (path: string, missing = false) => apiResponse(command([...apiArgs, path]), missing);
  const write = (path: string, method: string, body: unknown, status: number) =>
    apiResponse(
      command([...apiArgs, "--method", method, "--input", "-", path], JSON.stringify(body)),
      false,
      status,
    );
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
      // Authenticated writers can recover drafts from interrupted runs, across all pages.
      for (let page = 1; ; page++) {
        const batch = api(`${base}/releases?per_page=100&page=${page}`);
        assert.ok(Array.isArray(batch), "GitHub release list is not an array");
        const matching = batch.filter((item) => item?.tag_name === tag);
        assert.ok(matching.length <= 1, "Duplicate releases for the requested tag");
        if (matching.length) return checkedRelease(matching[0], tag);
        if (batch.length < 100) break;
      }
      // gh itself resolves a draft's pending tag via GraphQL, then fetches it by database ID.
      const [owner, name] = repository.split("/");
      const response = write(
        "graphql",
        "POST",
        {
          query:
            "query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){databaseId}}}",
          variables: { owner, name, tag },
        },
        200,
      ) as {
        errors?: unknown;
        data?: { repository?: { release?: { databaseId?: number } | null } | null };
      };
      assert.ok(!response.errors, "GitHub GraphQL release lookup failed");
      const repositoryData = response.data?.repository;
      assert.ok(repositoryData && "release" in repositoryData, "Invalid GraphQL release lookup");
      if (repositoryData.release === null) return;
      const id = repositoryData.release?.databaseId;
      assert.ok(Number.isSafeInteger(id) && (id ?? 0) > 0, "Invalid GraphQL release ID");
      return checkedRelease(api(`${base}/releases/${id}`), tag, id);
    },
    async create(tag, notes) {
      const value = write(
        `${base}/releases`,
        "POST",
        {
          tag_name: tag,
          name: `myrix ${tag}`,
          body: notes ? await readFile(notes, "utf8") : "",
          draft: true,
          prerelease: tag.includes("-"),
        },
        201,
      );
      const release = checkedRelease(value, tag);
      assert.equal(release.draft, true, "New release must remain draft until assets are verified");
      return release;
    },
    async get(release) {
      checkedRelease(release, release.tag_name);
      const value = api(`${base}/releases/${release.id}`, true);
      return value === undefined ? undefined : checkedRelease(value, release.tag_name, release.id);
    },
    async publish(release) {
      checkedRelease(release, release.tag_name);
      const value = write(
        `${base}/releases/${release.id}`,
        "PATCH",
        {
          tag_name: release.tag_name,
          draft: false,
        },
        200,
      );
      const published = checkedRelease(value, release.tag_name, release.id);
      assert.equal(published.draft, false, "Release publication was not confirmed");
      return published;
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
    async upload(release, asset) {
      checkedRelease(release, release.tag_name);
      const endpoint = `https://uploads.github.com/${base}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`;
      // --input opens and streams the file; gh supplies its exact Content-Length.
      apiResponse(
        command([
          ...apiArgs,
          "--method",
          "POST",
          "--input",
          asset.path,
          "-H",
          "Content-Type: application/octet-stream",
          endpoint,
        ]),
        false,
        201,
      );
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
