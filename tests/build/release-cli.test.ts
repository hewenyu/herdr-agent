import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tag = "v0.3.17";
const commit = "1".repeat(40);
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// Exercise the real child-process boundary, including binary --input files and typed fields.
// Tag/list lookups stay stale for the entire run; only the returned release ID is usable.
const fakeGh = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const fixture = JSON.parse(fs.readFileSync(process.env.RELEASE_CLI_FIXTURE, "utf8"));
const statePath = process.env.RELEASE_CLI_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
assert.equal(args.shift(), "api", "Release mutations must use the ID-based API");
const fields = {};
const headers = {};
let endpoint, input, method, hostname, include = false;
while (args.length) {
  const arg = args.shift();
  if (arg === "--include" || arg === "-i") { include = true; continue; }
  if (arg === "--hostname") { hostname = args.shift(); continue; }
  if (arg === "--method" || arg === "-X") { method = args.shift(); continue; }
  if (arg === "--input") { input = args.shift(); continue; }
  if (arg === "--header" || arg === "-H") {
    const header = args.shift();
    const colon = header.indexOf(":");
    headers[header.slice(0, colon).toLowerCase()] = header.slice(colon + 1).trim();
    continue;
  }
  if (["-F", "--field", "-f", "--raw-field"].includes(arg)) {
    const field = args.shift();
    const equals = field.indexOf("=");
    const key = field.slice(0, equals);
    let value = field.slice(equals + 1);
    if (arg === "-F" || arg === "--field") {
      if (value.startsWith("@")) value = fs.readFileSync(value.slice(1), "utf8");
      else if (/^(true|false|null|-?\d+)$/.test(value)) value = JSON.parse(value);
    }
    fields[key] = value;
    continue;
  }
  assert.ok(!arg.startsWith("-"), "Unexpected gh flag: " + arg);
  assert.equal(endpoint, undefined, "Exactly one API endpoint is required");
  endpoint = arg;
}
assert.equal(hostname, "github.com");
method ??= input || Object.keys(fields).length ? "POST" : "GET";
const body = input ? fs.readFileSync(input === "-" ? 0 : input) : undefined;
const url = new URL(endpoint, "https://api.github.com/");
const route = url.pathname;
state.calls.push({ method, route });
function response(value, status = 200) {
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (include) process.stdout.write("HTTP/2.0 " + status + " Response\r\nContent-Type: application/json\r\n\r\n");
  process.stdout.write(JSON.stringify(value));
  process.exit(status < 400 ? 0 : 1);
}
const base = "/repos/owner/repo";
const releasePath = base + "/releases/73";
const release = () => ({ id: 73, tag_name: fixture.tag, draft: !state.published });
if (route === base + "/git/ref/tags/" + fixture.tag) {
  assert.equal(method, "GET");
  response({ object: { type: "commit", sha: fixture.commit } });
}
if (route === base + "/releases/tags/" + fixture.tag) response({}, 404);
if (route === "/graphql") response({ data: { repository: { release: null } } });
if (route === base + "/releases" && method === "GET") response([]);
if (route === base + "/releases" && method === "POST") {
  assert.equal(state.created, 0, "Never create a replacement draft after a successful response");
  const payload = body ? JSON.parse(body.toString("utf8")) : fields;
  assert.equal(payload.tag_name, fixture.tag);
  assert.equal(payload.name, "myrix " + fixture.tag);
  assert.equal(payload.body, fixture.notes);
  assert.equal(payload.draft, true);
  assert.equal(payload.prerelease, false);
  state.created += 1;
  response(release(), 201);
}
if (route === releasePath + "/assets" && method === "GET") {
  assert.equal(url.hostname, "api.github.com");
  assert.equal(state.created, 1);
  response(state.assets);
}
if (route === releasePath + "/assets" && method === "POST") {
  assert.equal(url.hostname, "uploads.github.com");
  assert.equal(headers["content-type"], "application/octet-stream");
  assert.ok(body, "Upload must send the raw file through --input");
  const name = url.searchParams.get("name") || fields.name;
  assert.ok(fixture.assets[name], "Unexpected release asset name");
  assert.equal(body.length, fixture.assets[name].size);
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  assert.equal(digest, fixture.assets[name].sha256, "Upload must contain exact binary bytes");
  assert.ok(!state.assets.some((asset) => asset.name === name), "Never replace an uploaded asset");
  const asset = { id: state.assets.length + 1, name, size: body.length, state: "uploaded", digest: "sha256:" + digest };
  state.assets.push(asset);
  response(asset, 201);
}
if (route === releasePath && method === "PATCH") {
  const payload = body ? JSON.parse(body.toString("utf8")) : fields;
  assert.deepEqual(payload, { tag_name: fixture.tag, draft: false }, "Publication must preserve existing release metadata");
  assert.equal(state.assets.length, 4, "Never publish an incomplete release");
  assert.equal(state.published, false);
  state.published = true;
  response(release());
}
if (route === releasePath && method === "GET") response(release());
throw new Error("Unexpected API operation: " + method + " " + endpoint);
`;

test("the dependency-free release workflow command publishes by ID despite stale lookups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "myrix release cli "));
  const scripts = join(directory, "scripts");
  const archives = join(directory, "release archives");
  const binaries = join(directory, "test-bin");
  const notes = 'Release notes with "quotes", @references and 中文.\nSecond line.\n';
  try {
    await Promise.all([scripts, archives, binaries].map((path) => mkdir(path)));
    await copyFile(
      new URL("../../scripts/release-assets.ts", import.meta.url),
      join(scripts, "release-assets.ts"),
    );
    const assets: Record<string, { size: number; sha256: string }> = {};
    let manifest = "";
    for (const [index, target] of ["darwin_arm64", "linux_amd64", "linux_arm64"].entries()) {
      const name = `myrix_${tag}_${target}.tar.gz`;
      const bytes = Buffer.from([0, 255, 128, 13, 10, index, 34, 92]);
      await writeFile(join(archives, name), bytes);
      assets[name] = { size: bytes.length, sha256: hash(bytes) };
      manifest += `${hash(bytes)}  ${name}\n`;
    }
    await writeFile(join(archives, "SHA256SUMS"), manifest);
    assets.SHA256SUMS = { size: Buffer.byteLength(manifest), sha256: hash(manifest) };
    const notesPath = join(archives, "release notes.md");
    await writeFile(notesPath, notes);
    const fixturePath = join(directory, "fixture.json");
    const statePath = join(directory, "state.json");
    await writeFile(fixturePath, JSON.stringify({ tag, commit, assets, notes }));
    await writeFile(
      statePath,
      JSON.stringify({ created: 0, assets: [], published: false, calls: [] }),
    );
    await writeFile(join(binaries, "gh"), `#!${process.execPath}\n${fakeGh}`, { mode: 0o755 });
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "scripts/release-assets.ts",
        "owner/repo",
        tag,
        commit,
        archives,
        notesPath,
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          PATH: binaries,
          NODE_OPTIONS: "",
          RELEASE_CLI_FIXTURE: fixturePath,
          RELEASE_CLI_STATE: statePath,
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /4 missing assets uploaded, 0 identical assets retained/);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.created, 1);
    assert.equal(state.published, true);
    assert.equal(state.assets.length, 4);
    assert.equal(
      state.calls.filter((call: { method: string }) => call.method === "PATCH").length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
