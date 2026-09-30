import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkedHandoffDirectory } from "../../src/orchestration/handoff.js";

test("handoff directories accept dot-prefixed names without allowing parent traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "myrix-handoff-boundary-"));
  try {
    await checkedHandoffDirectory(root, join(root, "..notes.md"), true);
    for (const path of ["../x", ".."]) {
      await assert.rejects(checkedHandoffDirectory(root, resolve(root, path), true), {
        code: "workflow_handoff",
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
