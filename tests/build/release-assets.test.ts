import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  apiResponse,
  type CommandResult,
  githubPort,
  type LocalAsset,
  publishAssets,
  type Release,
  type ReleaseAsset,
  type ReleasePort,
  releaseAssets,
} from "../../scripts/release-assets.js";

const tag = "v0.3.14";
const commit = "46cd870a0371c4be2d34685378e1e68bcd4666ec";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "herdr-release-test-"));
  const names = ["darwin_arm64", "linux_amd64", "linux_arm64"].map(
    (target) => `herdr-agent_${tag}_${target}.tar.gz`,
  );
  let manifest = "";
  for (const name of names) {
    await writeFile(join(directory, name), name);
    manifest += `${digest(name)}  ${name}\n`;
  }
  await writeFile(join(directory, "SHA256SUMS"), manifest);
  return {
    directory,
    assets: await releaseAssets(tag, directory),
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

function remote(local: LocalAsset, id: number): ReleaseAsset {
  return {
    id,
    name: local.name,
    size: local.size,
    state: "uploaded",
    digest: `sha256:${local.sha256}`,
  };
}

class MemoryRelease implements ReleasePort {
  release: Release | undefined = { id: 1, tag_name: tag, draft: false };
  existing: ReleaseAsset[] = [];
  writes: string[] = [];
  hashes: number[] = [];
  // Deliberately unexposed through the port: a manual release's metadata survives.
  notes = "Hand-written release notes";
  title = "My release title";
  prerelease = true;
  failUpload?: string;
  loseUploadAck = false;
  loseCreateAck = false;
  failPublish = false;
  losePublishAck = false;
  async tagCommit() {
    return commit;
  }
  async find() {
    return this.release && { ...this.release };
  }
  async create() {
    this.writes.push("create draft");
    this.release = { id: 1, tag_name: tag, draft: true };
    if (this.loseCreateAck) throw new Error("Lost create response");
  }
  async publish() {
    this.writes.push("publish");
    if (this.failPublish) throw new Error("Publication failed");
    assert.ok(this.release);
    this.release.draft = false;
    if (this.losePublishAck) throw new Error("Lost publish response");
  }
  async assets() {
    return this.existing.map((asset) => ({ ...asset }));
  }
  async hash(asset: ReleaseAsset) {
    this.hashes.push(asset.id);
    return digest(asset.name);
  }
  async upload(_tag: string, asset: LocalAsset) {
    this.writes.push(`upload ${asset.name}`);
    if (this.failUpload === asset.name) throw new Error("Upload failed");
    assert.ok(!this.existing.some((item) => item.name === asset.name), "Must never overwrite");
    this.existing.push(remote(asset, this.existing.length + 1));
    if (this.loseUploadAck) throw new Error("Lost upload response");
  }
}

test("an existing manual release is completed once without changing its metadata", async () => {
  const f = await fixture();
  try {
    const port = new MemoryRelease();
    port.existing = f.assets.slice(0, 2).map(remote);
    assert.deepEqual(await publishAssets(port, tag, commit, f.assets, "unused-notes.md"), {
      uploaded: f.assets.slice(2).map((asset) => asset.name),
      skipped: f.assets.slice(0, 2).map((asset) => asset.name),
    });
    assert.deepEqual(
      port.writes,
      f.assets.slice(2).map((asset) => `upload ${asset.name}`),
    );
    port.writes = [];
    await publishAssets(port, tag, commit, f.assets);
    assert.deepEqual(port.writes, []);
    assert.equal(port.notes, "Hand-written release notes");
    assert.equal(port.title, "My release title");
    assert.equal(port.prerelease, true);
  } finally {
    await f.dispose();
  }
});

test("every same-name asset is preflighted before any missing asset is uploaded", async () => {
  const f = await fixture();
  try {
    const last = f.assets.at(-1);
    assert.ok(last);
    for (const change of [
      { digest: `sha256:${"0".repeat(64)}` },
      { size: last.size + 1 },
      { state: "starter" },
    ]) {
      const port = new MemoryRelease();
      port.existing = [{ ...remote(last, 1), ...change }];
      await assert.rejects(publishAssets(port, tag, commit, f.assets));
      assert.deepEqual(port.writes, []);
    }
    const duplicate = new MemoryRelease();
    duplicate.existing = [remote(last, 1), remote(last, 2)];
    await assert.rejects(publishAssets(duplicate, tag, commit, f.assets), /Duplicate/);
    assert.deepEqual(duplicate.writes, []);
  } finally {
    await f.dispose();
  }
});

test("missing API digest requires verified downloaded bytes, including failure before mutation", async () => {
  const f = await fixture();
  try {
    const first = f.assets[0];
    assert.ok(first);
    for (const value of [null, "md5:unsupported"]) {
      const port = new MemoryRelease();
      port.existing = [{ ...remote(first, 1), digest: value }];
      await publishAssets(port, tag, commit, f.assets);
      assert.ok(port.hashes.length > 0);
    }
    for (const hash of [
      async () => "0".repeat(64),
      async () => {
        throw new Error("Download failed");
      },
    ]) {
      const port = new MemoryRelease();
      port.existing = [{ ...remote(first, 1), digest: null }];
      port.hash = hash;
      await assert.rejects(publishAssets(port, tag, commit, f.assets));
      assert.deepEqual(port.writes, []);
    }
  } finally {
    await f.dispose();
  }
});

test("new release stays draft after partial failure and a retry publishes only after completion", async () => {
  const f = await fixture();
  try {
    const port = new MemoryRelease();
    port.release = undefined;
    port.loseCreateAck = true;
    port.failUpload = f.assets[1]?.name;
    await assert.rejects(publishAssets(port, tag, commit, f.assets), /Upload failed/);
    assert.equal((await port.find())?.draft, true);
    assert.equal(port.existing.length, 1);
    assert.ok(!port.writes.includes("publish"));
    port.failUpload = undefined;
    port.writes = [];
    port.loseUploadAck = true;
    port.losePublishAck = true;
    await publishAssets(port, tag, commit, f.assets);
    assert.deepEqual(port.writes, [
      ...f.assets.slice(1).map((asset) => `upload ${asset.name}`),
      "publish",
    ]);
    assert.equal((await port.find())?.draft, false);
    assert.equal(port.existing.length, 4);
  } finally {
    await f.dispose();
  }
});

test("an existing manual draft is published after verification and failed publication stays retryable", async () => {
  const f = await fixture();
  try {
    const port = new MemoryRelease();
    assert.ok(port.release);
    port.release.draft = true;
    port.existing = f.assets.map(remote);
    port.failPublish = true;
    await assert.rejects(publishAssets(port, tag, commit, f.assets), /Publication failed/);
    assert.equal(port.release.draft, true);
    port.failPublish = false;
    await publishAssets(port, tag, commit, f.assets);
    assert.deepEqual(port.writes, ["publish", "publish"]);
    assert.equal(port.release.draft, false);
    assert.equal(port.notes, "Hand-written release notes");
    assert.equal(port.prerelease, true);
  } finally {
    await f.dispose();
  }
});

test("tag mismatch, immutable missing assets and conflicting upload ACK never overwrite", async () => {
  const f = await fixture();
  try {
    const mismatch = new MemoryRelease();
    mismatch.tagCommit = async () => "0".repeat(40);
    await assert.rejects(publishAssets(mismatch, tag, commit, f.assets), /original build commit/);
    assert.deepEqual(mismatch.writes, []);
    const immutable = new MemoryRelease();
    assert.ok(immutable.release);
    immutable.release.immutable = true;
    await assert.rejects(publishAssets(immutable, tag, commit, f.assets), /Immutable/);
    assert.deepEqual(immutable.writes, []);
    const conflict = new MemoryRelease();
    conflict.upload = async (_tag, asset) => {
      conflict.writes.push(`upload ${asset.name}`);
      conflict.existing.push({ ...remote(asset, 1), digest: `sha256:${"0".repeat(64)}` });
      throw new Error("Lost ACK");
    };
    await assert.rejects(publishAssets(conflict, tag, commit, f.assets), /SHA-256 differs/);
    assert.equal(conflict.writes.length, 1);
  } finally {
    await f.dispose();
  }
});

test("original archive manifest and changed local bytes fail closed", async () => {
  const f = await fixture();
  try {
    const first = f.assets[0];
    assert.ok(first);
    await writeFile(first.path, "altered original archive");
    await assert.rejects(releaseAssets(tag, f.directory), /SHA256SUMS/);
    const port = new MemoryRelease();
    await assert.rejects(publishAssets(port, tag, commit, f.assets), /Local asset changed/);
    assert.deepEqual(port.writes, []);
  } finally {
    await f.dispose();
  }
});

function response(value: unknown, status = 200): CommandResult {
  return {
    status: status < 300 ? 0 : 1,
    stdout: `HTTP/2.0 ${status} Response\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}`,
    stderr: "",
  };
}

test("only explicit HTTP 404 is release absence; permission, transport and malformed data abort", async () => {
  assert.equal(apiResponse(response({}, 404), true), undefined);
  for (const status of [401, 403, 429, 500])
    assert.throws(() => apiResponse(response({}, status), true), /GitHub request failed/);
  for (const result of [
    { status: 1, stdout: "", stderr: "could not resolve host" },
    { ...response({}, 404), error: new Error("timeout") },
    { status: 0, stdout: "HTTP/2.0 200 OK\n\nnot JSON", stderr: "" },
  ])
    assert.throws(() => apiResponse(result, true));
  await assert.rejects(githubPort("owner/repo", () => response(null)).find(tag), /Invalid release/);
});

test("a draft missing from published-by-tag lookup is recovered from paginated releases", async () => {
  const paths: string[] = [];
  const draft = { id: 17, tag_name: tag, draft: true };
  const port = githubPort("owner/repo", (args) => {
    const path = args.at(-1) ?? "";
    paths.push(path);
    if (path.includes("/releases/tags/")) return response({}, 404);
    if (path.endsWith("page=1"))
      return response(
        Array.from({ length: 100 }, (_, id) => ({
          id: id + 1,
          tag_name: `v1.0.${id}`,
          draft: false,
        })),
      );
    if (path.endsWith("page=2")) return response([draft]);
    throw new Error(`Unexpected request ${path}`);
  });
  assert.deepEqual(await port.find(tag), draft);
  assert.equal(paths.length, 3);
  const missing = githubPort("owner/repo", (args) =>
    response([], args.at(-1)?.includes("/tags/") ? 404 : 200),
  );
  assert.equal(await missing.find(tag), undefined);
  const forbidden = githubPort("owner/repo", (args) =>
    response({}, args.at(-1)?.includes("/tags/") ? 404 : 403),
  );
  await assert.rejects(forbidden.find(tag), /HTTP 403/);
});

test("GitHub adapter peels annotated tags, paginates assets and uses only draft-safe mutations", async () => {
  const calls: string[][] = [];
  const port = githubPort("owner/repo", (args) => {
    calls.push(args);
    const path = args.at(-1) ?? "";
    if (path.includes("git/ref/tags/")) return response({ object: { type: "tag", sha: "abc" } });
    if (path.endsWith("git/tags/abc")) return response({ object: { type: "commit", sha: commit } });
    if (path.endsWith("page=1")) return response(Array.from({ length: 100 }, (_, id) => ({ id })));
    if (path.endsWith("page=2")) return response([{ id: 101, name: "last-page-asset" }]);
    return { status: 0, stdout: "", stderr: "" };
  });
  assert.equal(await port.tagCommit(tag), commit);
  assert.equal((await port.assets({ id: 1, tag_name: tag, draft: true })).at(-1)?.id, 101);
  await port.create(tag, "notes.md");
  await port.upload(tag, { name: "file", path: "/tmp/archive with spaces", size: 1, sha256: "" });
  await port.publish(tag);
  assert.deepEqual(
    calls.filter((args) => args[0] === "release"),
    [
      [
        "release",
        "create",
        tag,
        "--repo",
        "github.com/owner/repo",
        "--verify-tag",
        "--draft",
        "--title",
        `herdr-agent ${tag}`,
        "--notes-file",
        "notes.md",
      ],
      ["release", "upload", tag, "/tmp/archive with spaces", "--repo", "github.com/owner/repo"],
      ["release", "edit", tag, "--repo", "github.com/owner/repo", "--draft=false"],
    ],
  );
  assert.ok(calls.filter((args) => args[0] === "api").every((args) => args.includes("--hostname")));
});

test("GitHub fallback hashes exact binary asset bytes without stdout buffer truncation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-fake-gh-"));
  const oldPath = process.env.PATH;
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0xab);
  try {
    const executable = join(directory, "gh");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst fs = require('node:fs');\nconst expected = ['api','--hostname','github.com','repos/owner/repo/releases/assets/42','-H','Accept: application/octet-stream'];\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(2);\nfs.writeFileSync(1, Buffer.alloc(${bytes.length}, 0xab));\n`,
    );
    await chmod(executable, 0o755);
    process.env.PATH = `${directory}:${oldPath ?? ""}`;
    const port = githubPort("owner/repo");
    const asset = { id: 42, name: "large-archive", size: bytes.length, state: "uploaded" };
    assert.equal(await port.hash(asset), digest(bytes));
    await assert.rejects(port.hash({ ...asset, size: bytes.length - 1 }), /Downloaded asset size/);
    await writeFile(executable, `#!${process.execPath}\nprocess.exit(1);\n`);
    await assert.rejects(port.hash(asset), /Cannot read existing release asset/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  }
});
