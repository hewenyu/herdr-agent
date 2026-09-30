import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { inspectArtifact } from "../../src/orchestration/board.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

test("artifact containment accepts dot-dot-prefixed names but rejects parent and outside paths", async () => {
  const h = setup();
  try {
    const created = await h.service.create(actor, discussion);
    const root = join(h.directory, "project");
    await mkdir(join(root, "..cache"), { recursive: true });
    const task = { ...created, directories: [root], boardDirectory: undefined };
    const content = "artifact";
    for (const path of ["..notes.md", "..cache/a"]) await writeFile(join(root, path), content);
    await writeFile(join(h.directory, "x"), "outside");
    for (const path of ["..notes.md", "..cache/a"]) {
      const artifact = await inspectArtifact(task, path);
      assert.equal(artifact.hash, createHash("sha256").update(content).digest("hex"));
      assert.ok(artifact.path.endsWith(path));
    }
    for (const path of ["../x", "..", join(h.directory, "x")])
      await assert.rejects(inspectArtifact(task, path), {
        code: "workflow_artifact",
        message: /超出当前任务目录/,
      });
    // Existing report/consensus callers use canonical absolute paths inside the allowed root.
    assert.equal(
      (await inspectArtifact(task, join(root, "..notes.md"))).hash,
      createHash("sha256").update(content).digest("hex"),
    );
  } finally {
    h.close();
  }
});
