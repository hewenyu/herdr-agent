import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  apiResponse,
  type CommandResult,
  GitHubRequestError,
  githubPort,
  type LocalAsset,
  publishAssets as publishWithWait,
  type Release,
  type ReleaseAsset,
  type ReleasePort,
  releaseAssets,
} from "../../scripts/release-assets.js";

const publishAssets = (
  port: ReleasePort,
  tag: string,
  commit: string,
  assets: LocalAsset[],
  notes?: string,
) => publishWithWait(port, tag, commit, assets, notes, async () => {});

const tag = "v0.3.14";
const commit = "46cd870a0371c4be2d34685378e1e68bcd4666ec";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fixture(prefix = "myrix") {
  const directory = await mkdtemp(join(tmpdir(), "herdr-release-test-"));
  const names = ["darwin_arm64", "linux_amd64", "linux_arm64"].map(
    (target) => `${prefix}_${tag}_${target}.tar.gz`,
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
    if (this.loseCreateAck) throw new GitHubRequestError("Lost create response", true);
    return { ...this.release };
  }
  async get() {
    return this.release && { ...this.release };
  }
  async publish() {
    this.writes.push("publish");
    if (this.failPublish) throw new Error("Publication failed");
    assert.ok(this.release);
    this.release.draft = false;
    if (this.losePublishAck) throw new GitHubRequestError("Lost publish response", true);
    return { ...this.release };
  }
  async assets() {
    return this.existing.map((asset) => ({ ...asset }));
  }
  async hash(asset: ReleaseAsset) {
    this.hashes.push(asset.id);
    return digest(asset.name);
  }
  async upload(release: Release, asset: LocalAsset) {
    assert.equal(release.id, this.release?.id);
    this.writes.push(`upload ${asset.name}`);
    if (this.failUpload === asset.name) throw new Error("Upload failed");
    assert.ok(!this.existing.some((item) => item.name === asset.name), "Must never overwrite");
    this.existing.push(remote(asset, this.existing.length + 1));
    if (this.loseUploadAck) throw new GitHubRequestError("Lost upload response", true);
  }
}

test("a newly created release remains usable when tag and list lookups never expose it", async () => {
  const f = await fixture();
  try {
    const port = new MemoryRelease();
    port.release = undefined;
    port.find = async () => undefined;
    await assert.doesNotReject(publishAssets(port, tag, commit, f.assets));
    assert.equal((await port.get())?.draft, false);
    assert.equal(port.writes.filter((write) => write === "create draft").length, 1);
    assert.equal(port.existing.length, 4);
  } finally {
    await f.dispose();
  }
});

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

for (const prefix of ["myrix", "herdr-agent"]) {
  test(`${prefix} restoration rejects opposite-brand partial archives before any write, without checksums`, async () => {
    const f = await fixture(prefix);
    try {
      const other = prefix === "myrix" ? "herdr-agent" : "myrix";
      for (const draft of [false, true]) {
        const port = new MemoryRelease();
        assert.ok(port.release);
        port.release.draft = draft;
        const first = f.assets[0];
        assert.ok(first);
        port.existing = [
          remote(first, 1),
          { ...remote(first, 2), name: `${other}_${tag}_linux_arm64.tar.gz`, digest: null },
        ];
        const before = structuredClone(port.existing);
        await assert.rejects(
          publishAssets(port, tag, commit, f.assets, "must-not-write-notes.md"),
          /Conflicting release archive branding/,
        );
        assert.deepEqual(port.writes, []);
        assert.deepEqual(port.hashes, []);
        assert.deepEqual(port.existing, before);
        assert.equal(port.release.draft, draft);
        assert.equal(port.notes, "Hand-written release notes");
        assert.equal(port.title, "My release title");
        assert.equal(port.prerelease, true);
      }
    } finally {
      await f.dispose();
    }
  });
}

test("unrelated manual attachments survive release completion without blocking publication", async () => {
  for (const prefix of ["myrix", "herdr-agent"]) {
    const f = await fixture(prefix);
    try {
      const port = new MemoryRelease();
      assert.ok(port.release);
      port.release.draft = true;
      const attachments = ["manual-notes.pdf", "herdr-agent_v0.3.13_linux_arm64.tar.gz"].map(
        (name, index) => ({ id: 100 + index, name, size: 7, state: "uploaded", digest: null }),
      );
      port.existing = [...attachments];
      await publishAssets(port, tag, commit, f.assets, "unused-notes.md");
      assert.deepEqual(port.writes, [
        ...f.assets.map((asset) => `upload ${asset.name}`),
        "publish",
      ]);
      assert.deepEqual(port.existing.slice(0, attachments.length), attachments);
      assert.deepEqual(port.hashes, []);
      assert.equal(port.notes, "Hand-written release notes");
      assert.equal(port.title, "My release title");
      assert.equal(port.prerelease, true);
    } finally {
      await f.dispose();
    }
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
      throw new GitHubRequestError("Lost ACK", true);
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
  const missing = githubPort("owner/repo", (args) => {
    if (args.at(-1) === "graphql") return response({ data: { repository: { release: null } } });
    return response([], args.at(-1)?.includes("/tags/") ? 404 : 200);
  });
  assert.equal(await missing.find(tag), undefined);
  const forbidden = githubPort("owner/repo", (args) =>
    response({}, args.at(-1)?.includes("/tags/") ? 404 : 403),
  );
  await assert.rejects(forbidden.find(tag), /HTTP 403/);
});

test("GitHub adapter peels tags, paginates assets and mutates only the confirmed release ID", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const draft = { id: 17, tag_name: tag, draft: true };
  const directory = await mkdtemp(join(tmpdir(), "myrix-release-notes-"));
  try {
    const notes = join(directory, "notes.md");
    await writeFile(notes, "Release notes\nwith literal `code` and $variables\n");
    const port = githubPort("owner/repo", (args, input) => {
      calls.push({ args, input });
      const path = args.at(-1) ?? "";
      if (path.includes("git/ref/tags/")) return response({ object: { type: "tag", sha: "abc" } });
      if (path.endsWith("git/tags/abc"))
        return response({ object: { type: "commit", sha: commit } });
      if (path.endsWith("page=1"))
        return response(Array.from({ length: 100 }, (_, id) => ({ id })));
      if (path.endsWith("page=2")) return response([{ id: 101, name: "last-page-asset" }]);
      if (path.startsWith("https://uploads.github.com/")) return response({ id: 42 }, 201);
      if (path === "repos/owner/repo/releases") return response(draft, 201);
      if (args.includes("PATCH")) return response({ ...draft, draft: false });
      if (path === "repos/owner/repo/releases/17") return response(draft);
      throw new Error(`Unexpected request ${args}`);
    });
    assert.equal(await port.tagCommit(tag), commit);
    assert.equal((await port.assets(draft)).at(-1)?.id, 101);
    assert.deepEqual(await port.create(tag, notes), draft);
    assert.deepEqual(await port.get(draft), draft);
    await port.upload(draft, {
      name: "file with spaces+#.tar.gz",
      path: "/tmp/archive with spaces",
      size: 1,
      sha256: "",
    });
    assert.deepEqual(await port.publish(draft), { ...draft, draft: false });
    const writes = calls.filter(({ args }) => args.includes("--method"));
    assert.equal(writes.length, 3);
    assert.deepEqual(JSON.parse(writes[0]?.input ?? ""), {
      tag_name: tag,
      name: `myrix ${tag}`,
      body: "Release notes\nwith literal `code` and $variables\n",
      draft: true,
      prerelease: false,
    });
    assert.deepEqual(writes[1]?.args.slice(4), [
      "--method",
      "POST",
      "--input",
      "/tmp/archive with spaces",
      "-H",
      "Content-Type: application/octet-stream",
      "https://uploads.github.com/repos/owner/repo/releases/17/assets?name=file%20with%20spaces%2B%23.tar.gz",
    ]);
    assert.deepEqual(JSON.parse(writes[2]?.input ?? ""), { tag_name: tag, draft: false });
    assert.ok(calls.every(({ args }) => args[0] === "api" && args.includes("--hostname")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("a lost create ACK tolerates delayed and transient reads without creating twice", async () => {
  const f = await fixture();
  try {
    const port = new MemoryRelease();
    port.release = undefined;
    port.loseCreateAck = true;
    let reads = 0;
    port.find = async () => {
      reads++;
      if (reads <= 2) return;
      if (reads === 3) throw new GitHubRequestError("HTTP 503", true);
      return port.release && { ...port.release };
    };
    await publishAssets(port, tag, commit, f.assets);
    assert.equal(reads, 4);
    assert.equal(port.writes.filter((write) => write === "create draft").length, 1);
    assert.equal((await port.get())?.draft, false);
  } finally {
    await f.dispose();
  }
});

test("unconfirmed creation is bounded and local or permission failures never retry", async () => {
  const f = await fixture();
  try {
    for (const error of [
      new GitHubRequestError("Lost create ACK", true),
      new GitHubRequestError("HTTP 403", false),
      new Error("ENOENT notes file"),
    ]) {
      const port = new MemoryRelease();
      let reads = 0;
      port.find = async () => {
        reads++;
        return undefined;
      };
      port.create = async () => {
        port.writes.push("create draft");
        throw error;
      };
      await assert.rejects(
        publishAssets(port, tag, commit, f.assets),
        (actual) => actual === error,
      );
      assert.equal(reads, error instanceof GitHubRequestError && error.recoverable ? 7 : 1);
      assert.deepEqual(port.writes, ["create draft"]);
    }
  } finally {
    await f.dispose();
  }
});

test("lost publication ACK waits for the same ID despite tag lookup returning a replacement", async () => {
  const f = await fixture();
  try {
    const port = new MemoryRelease();
    port.release = { id: 17, tag_name: tag, draft: true };
    port.existing = f.assets.map(remote);
    port.losePublishAck = true;
    let finds = 0;
    port.find = async () =>
      ++finds === 1
        ? { id: 17, tag_name: tag, draft: true }
        : { id: 99, tag_name: tag, draft: false };
    let reads = 0;
    port.get = async () => {
      reads++;
      if (reads === 1) return;
      if (reads === 2) throw new GitHubRequestError("timeout", true);
      if (reads === 3) return { id: 17, tag_name: tag, draft: true };
      return port.release && { ...port.release };
    };
    await publishAssets(port, tag, commit, f.assets);
    assert.equal(finds, 1);
    assert.equal(reads, 4);
    assert.deepEqual(port.writes, ["publish"]);
  } finally {
    await f.dispose();
  }
});

test("publication confirmation rejects another ID, another tag, or permission errors immediately", async () => {
  const f = await fixture();
  try {
    for (const result of [
      { id: 99, tag_name: tag, draft: false },
      { id: 1, tag_name: "v9.0.0", draft: false },
      new GitHubRequestError("HTTP 403", false),
    ]) {
      const port = new MemoryRelease();
      port.release = { id: 1, tag_name: tag, draft: true };
      port.existing = f.assets.map(remote);
      port.losePublishAck = true;
      let reads = 0;
      port.get = async () => {
        reads++;
        if (result instanceof Error) throw result;
        return result;
      };
      await assert.rejects(
        publishAssets(port, tag, commit, f.assets),
        /Release ID changed|different tag|HTTP 403/,
      );
      assert.equal(reads, 1);
      assert.deepEqual(port.writes, ["publish"]);
    }
  } finally {
    await f.dispose();
  }
});

test("a delayed upload ACK is reconciled without a second upload", async () => {
  const f = await fixture();
  try {
    const port = new MemoryRelease();
    port.loseUploadAck = true;
    let hidden = 0;
    const upload = port.upload.bind(port);
    port.upload = async (release, asset) => {
      hidden = 2;
      await upload(release, asset);
    };
    port.assets = async () => {
      if (hidden > 0) {
        hidden--;
        return port.existing.slice(0, -1);
      }
      return port.existing.map((asset) => ({ ...asset }));
    };
    await publishAssets(port, tag, commit, f.assets);
    assert.deepEqual(
      port.writes,
      f.assets.map((asset) => `upload ${asset.name}`),
    );
  } finally {
    await f.dispose();
  }
});

test("GraphQL pending-tag lookup resumes a draft missing from REST lists and fails closed", async () => {
  const draft = { id: 17, tag_name: tag, draft: true };
  const paths: string[] = [];
  const port = githubPort("owner/repo", (args, input) => {
    const path = args.at(-1) ?? "";
    paths.push(path);
    if (path.includes("/releases/tags/")) return response({}, 404);
    if (path.includes("?per_page")) return response([]);
    if (path === "graphql") {
      assert.deepEqual(JSON.parse(input ?? "").variables, { owner: "owner", name: "repo", tag });
      return response({ data: { repository: { release: { databaseId: 17 } } } });
    }
    if (path.endsWith("/releases/17")) return response(draft);
    throw new Error(`Unexpected request ${path}`);
  });
  assert.deepEqual(await port.find(tag), draft);
  assert.equal(paths.at(-1), "repos/owner/repo/releases/17");
  for (const result of [
    response({}, 403),
    response({ errors: [{ message: "Forbidden" }], data: { repository: { release: null } } }),
    response({ data: { repository: null } }),
    response({ data: { repository: { release: {} } } }),
  ]) {
    const forbidden = githubPort("owner/repo", (args) => {
      if (args.at(-1) === "graphql") return result;
      return response([], args.at(-1)?.includes("/tags/") ? 404 : 200);
    });
    await assert.rejects(forbidden.find(tag));
  }
});

test("REST creation and publication responses must identify the expected draft and exact ID", async () => {
  for (const value of [
    { id: 0, tag_name: tag, draft: true },
    { id: 17, tag_name: "v9.0.0", draft: true },
    { id: 17, tag_name: tag, draft: false },
  ]) {
    await assert.rejects(githubPort("owner/repo", () => response(value, 201)).create(tag));
  }
  await assert.rejects(
    githubPort("owner/repo", () => response({ id: 17, tag_name: tag, draft: true })).create(tag),
    /Expected HTTP 201/,
  );
  const draft = { id: 17, tag_name: tag, draft: true };
  for (const value of [
    { ...draft, id: 99, draft: false },
    { ...draft, tag_name: "v9.0.0", draft: false },
    draft,
  ])
    await assert.rejects(githubPort("owner/repo", () => response(value)).publish(draft));
  await assert.rejects(
    githubPort("owner/repo", () => response({ ...draft, id: 99 })).get(draft),
    /Release ID changed/,
  );
});

test("HTTP 422 create and upload races reconcile only exact existing assets", async () => {
  const f = await fixture();
  try {
    const draft = { id: 17, tag_name: tag, draft: true };
    let created = false;
    const assets: ReleaseAsset[] = [];
    let writes = 0;
    const port = githubPort("owner/repo", (args, input) => {
      const path = args.at(-1) ?? "";
      if (path.includes("/git/ref/")) return response({ object: { type: "commit", sha: commit } });
      if (path.includes("/releases/tags/")) return created ? response(draft) : response({}, 404);
      if (path.includes("/releases?")) return response([]);
      if (path === "graphql") return response({ data: { repository: { release: null } } });
      if (path === "repos/owner/repo/releases") {
        created = true;
        writes++;
        return response({}, 422);
      }
      if (path.includes("/assets?per_page")) return response(assets);
      if (path.startsWith("https://uploads.github.com/")) {
        writes++;
        const name = new URL(path).searchParams.get("name");
        const local = f.assets.find((asset) => asset.name === name);
        assert.ok(local);
        assets.push(remote(local, assets.length + 1));
        return response({}, 422);
      }
      if (args.includes("PATCH")) {
        writes++;
        assert.deepEqual(JSON.parse(input ?? ""), { tag_name: tag, draft: false });
        return response({ ...draft, draft: false });
      }
      throw new Error(`Unexpected request ${args}`);
    });
    await publishAssets(port, tag, commit, f.assets);
    assert.equal(writes, 6);
  } finally {
    await f.dispose();
  }
});
