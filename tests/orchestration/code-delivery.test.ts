import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  codeDeliveryEvidence,
  codeDeliveryRevision,
  codeDeliveryText,
} from "../../src/orchestration/code-delivery.js";

import { branch, fixture, prUrl } from "./code-delivery-fixture.js";

test("code delivery reports actual Git branch, HEAD, clean/dirty state without trusting participant PR text", async () => {
  const h = await fixture();
  try {
    const commit = await h.initialize();
    const before = Date.now();
    const evidence = await codeDeliveryEvidence(h.task);
    assert.ok(Date.parse(evidence.observedAt) >= before);
    assert.equal(evidence.repositories[0]?.pr, undefined);
    assert.deepEqual(evidence.repositories, [
      {
        directory: h.directory,
        commit,
        branch,
        dirty: false,
        upstream: undefined,
        statusRevision: createHash("sha256").update("").digest("hex"),
        indexRevision: createHash("sha256")
          .update(await h.git("ls-files", "--stage", "-z"))
          .digest("hex"),
      },
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

for (const operation of ["branch", "index", "upstream"])
  test(`${operation} changing at the same HEAD during PR lookup invalidates the mixed snapshot`, async () => {
    const h = await fixture();
    try {
      const commit = await h.initialize();
      await writeFile(join(h.directory, "index.mjs"), "export const answer = 43;\n");
      await h.git("branch", "local-upstream");
      const gitArgs =
        operation === "branch"
          ? ["checkout", "--quiet", "-b", "feature/new-name"]
          : operation === "index"
            ? ["add", "index.mjs"]
            : ["branch", "--set-upstream-to=local-upstream"];
      await h.respond({ gitArgs, pr: { url: prUrl, headRefOid: commit, headRefName: branch } });
      const evidence = await codeDeliveryEvidence(h.task);
      assert.equal(await h.git("rev-parse", "HEAD"), commit);
      assert.match(evidence.repositories[0]?.error ?? "", /采集期间 Git.*发生变化/);
      assert.equal(evidence.repositories[0]?.pr, undefined);
    } finally {
      await h.close();
    }
  });

test("Git revision ignores observation time but retains raw staged status and index content", async () => {
  const h = await fixture();
  try {
    await h.initialize();
    await writeFile(join(h.directory, "index.mjs"), "export const answer = 43;\n");
    const unstaged = await codeDeliveryEvidence(h.task);
    assert.equal(
      codeDeliveryRevision(unstaged),
      codeDeliveryRevision({
        ...unstaged,
        observedAt: "another-time",
      }),
    );
    assert.equal(
      codeDeliveryRevision(unstaged),
      codeDeliveryRevision(JSON.parse(JSON.stringify(unstaged))),
    );
    await h.git("add", "index.mjs");
    const staged = await codeDeliveryEvidence(h.task);
    assert.equal(unstaged.repositories[0]?.dirty, true);
    assert.equal(staged.repositories[0]?.dirty, true);
    assert.notEqual(
      unstaged.repositories[0]?.statusRevision,
      staged.repositories[0]?.statusRevision,
    );
    assert.notEqual(unstaged.repositories[0]?.indexRevision, staged.repositories[0]?.indexRevision);
    assert.notEqual(codeDeliveryRevision(unstaged), codeDeliveryRevision(staged));
  } finally {
    await h.close();
  }
});
