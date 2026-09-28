import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Task } from "../../src/core/types.js";
import { codeDeliveryEvidence, codeDeliveryText } from "../../src/orchestration/code-delivery.js";

const execute = promisify(execFile);
const branch = "feature/actual-delivery";
const prUrl = "https://github.com/example/project/pull/42";

/** This test file runs in its own Node test process; gh never reaches a network client. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "code-delivery-evidence-")));
  const directory = join(root, "repository");
  const bin = join(root, "bin");
  await mkdir(directory);
  await mkdir(bin);
  const previousPath = process.env.PATH;
  const responseFile = join(bin, "response.json");
  await writeFile(responseFile, JSON.stringify({ unavailable: true }));
  const fakeGh = join(bin, "gh");
  await writeFile(
    fakeGh,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const response = JSON.parse(fs.readFileSync(path.join(__dirname, 'response.json'), 'utf8'));
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({args:process.argv.slice(2), cwd:process.cwd()}) + '\\n');
if (response.unavailable) process.exit(1);
if (response.advanceHead) execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'Concurrent change'], {cwd:process.cwd()});
process.stdout.write(response.malformed ? 'invalid-json' : JSON.stringify(response.pr));
`,
  );
  await chmod(fakeGh, 0o700);
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  const git = async (...args: string[]) =>
    (await execute("git", ["-C", directory, ...args])).stdout.trim();
  const initialize = async () => {
    await git("init", "--quiet", "--initial-branch", branch);
    await git("config", "user.name", "Isolated Fixture");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "commit.gpgsign", "false");
    await git("config", "core.hooksPath", bin);
    await writeFile(join(directory, "index.mjs"), "export const answer = 42;\n");
    await git("add", "index.mjs");
    await git("commit", "--quiet", "-m", "Initial fixture");
    return git("rev-parse", "HEAD");
  };
  const task = {
    directories: [directory],
    result: "参与者声称已提交到 https://github.com/example/project/pull/999。",
  } as Task;
  return {
    root,
    directory,
    bin,
    task,
    git,
    initialize,
    respond: (value: unknown) => writeFile(responseFile, JSON.stringify(value)),
    async close() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("code delivery reports actual Git branch, HEAD, clean/dirty state without trusting participant PR text", async () => {
  const h = await fixture();
  try {
    const commit = await h.initialize();
    const before = Date.now();
    const evidence = await codeDeliveryEvidence(h.task);
    assert.ok(Date.parse(evidence.observedAt) >= before);
    assert.equal(evidence.repositories[0]?.pr, undefined);
    assert.deepEqual(evidence.repositories, [
      { directory: h.directory, commit, branch, dirty: false, upstream: undefined },
    ]);
    assert.doesNotMatch(codeDeliveryText(evidence).join("\n"), /pull\/999/);
    assert.match(codeDeliveryText(evidence).join("\n"), /未取得当前提交对应的 PR 证据/);
    await writeFile(join(h.directory, "index.mjs"), "export const answer = 43;\n");
    await writeFile(join(h.directory, "untracked.txt"), "uncommitted\n");
    const changed = await codeDeliveryEvidence(h.task);
    assert.equal(changed.repositories[0]?.dirty, true);
    assert.equal(changed.repositories[0]?.commit, commit);
    assert.equal(changed.repositories[0]?.branch, branch);
    assert.match(codeDeliveryText(changed).join("\n"), /仍有未提交修改/);
  } finally {
    await h.close();
  }
});

test("PR evidence requires current commit, current branch and an actual GitHub PR URL", async () => {
  const h = await fixture();
  try {
    const commit = await h.initialize();
    const base = { url: prUrl, headRefOid: commit, headRefName: branch };
    for (const pr of [
      { ...base, headRefOid: "0".repeat(40) },
      { ...base, headRefName: "feature/different" },
      { ...base, url: "https://example.invalid/project/pull/42" },
      { ...base, url: "https://github.com/example/project/issues/42" },
      { ...base, url: "https://github.com@example.invalid/example/project/pull/42" },
    ]) {
      await h.respond({ pr });
      assert.equal(
        (await codeDeliveryEvidence(h.task)).repositories[0]?.pr,
        undefined,
        JSON.stringify(pr),
      );
    }
    await h.respond({ malformed: true });
    assert.equal((await codeDeliveryEvidence(h.task)).repositories[0]?.pr, undefined);
    await h.respond({ pr: base });
    assert.deepEqual((await codeDeliveryEvidence(h.task)).repositories[0]?.pr, {
      url: prUrl,
      headCommit: commit,
    });
    const calls = (await readFile(join(h.bin, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(calls.every((call) => call.cwd === h.directory));
    assert.ok(
      calls.every(
        (call) =>
          JSON.stringify(call.args) ===
          JSON.stringify(["pr", "view", "--json", "url,headRefOid,headRefName"]),
      ),
    );
  } finally {
    await h.close();
  }
});

test("non-Git and unborn repositories explicitly report unconfirmed delivery facts", async () => {
  const h = await fixture();
  try {
    for (const initialize of [false, true]) {
      if (initialize) await h.git("init", "--quiet", "--initial-branch", branch);
      const evidence = await codeDeliveryEvidence(h.task);
      const entry = evidence.repositories[0];
      assert.ok(entry?.error);
      assert.equal(entry.commit, undefined);
      assert.equal(entry.branch, undefined);
      assert.equal(entry.dirty, undefined);
      assert.equal(entry.pr, undefined);
      assert.match(codeDeliveryText(evidence).join("\n"), /分支：未确认；提交：未确认/);
    }
    await assert.rejects(readFile(join(h.bin, "calls.jsonl")), { code: "ENOENT" });
  } finally {
    await h.close();
  }
});

test("detached HEAD remains explicit and cannot borrow a named branch's PR evidence", async () => {
  const h = await fixture();
  try {
    const commit = await h.initialize();
    await h.git("checkout", "--quiet", "--detach", commit);
    await h.respond({ pr: { url: prUrl, headRefOid: commit, headRefName: branch } });
    const entry = (await codeDeliveryEvidence(h.task)).repositories[0];
    assert.equal(entry?.branch, "detached HEAD");
    assert.equal(entry.commit, commit);
    assert.equal(entry.pr, undefined);
    assert.equal(entry.error, undefined);
  } finally {
    await h.close();
  }
});

test("HEAD changing during PR lookup invalidates an otherwise matching PR receipt", async () => {
  const h = await fixture();
  try {
    const commit = await h.initialize();
    await h.respond({
      advanceHead: true,
      pr: { url: prUrl, headRefOid: commit, headRefName: branch },
    });
    const evidence = await codeDeliveryEvidence(h.task);
    const entry = evidence.repositories[0];
    assert.notEqual(await h.git("rev-parse", "HEAD"), commit);
    assert.match(entry?.error ?? "", /采集期间提交发生变化/);
    assert.equal(entry?.pr, undefined);
    assert.match(codeDeliveryText(evidence).join("\n"), /交付位置未确认/);
  } finally {
    await h.close();
  }
});
