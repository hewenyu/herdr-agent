import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import { type VerificationRun, VerificationRunner } from "../../src/orchestration/verify.js";
import { ProjectCatalog } from "../../src/projects/catalog.js";
import { Store } from "../../src/storage/store.js";

for (const [name, defect] of [
  ["unknown status", { status: "unrecognized" }],
  ["mismatched identity", { id: "other-run", status: "running" }],
  ["unconfirmed exit disguised as a string", { status: "cancelled", exitConfirmed: "false" }],
  ["empty legacy directory", { cwd: "", directories: undefined }],
] as const) {
  test(`damaged verification authority (${name}) cannot release or rewrite its barrier`, () => {
    const store = new Store(":memory:");
    const projects = new ProjectCatalog(store, {
      projects: [],
      defaultProject: "fixture",
      bypass: false,
    });
    const options = { store, projects, stateDir: "/unused-verification-authority-fixture" };
    const valid: VerificationRun = {
      id: "run",
      taskId: "task",
      project: "fixture",
      commandIndex: 0,
      configRevision: "config",
      artifactRevision: "artifact",
      description: "frozen verification",
      command: "never spawned",
      cwd: "/unused-verification-authority-fixture/project",
      directories: ["/unused-verification-authority-fixture/project"],
      timeoutMs: 1000,
      status: "unknown",
      stdoutPath: "/unused-verification-authority-fixture/stdout.log",
      stderrPath: "/unused-verification-authority-fixture/stderr.log",
      createdAt: "2026-10-01T00:00:00.000Z",
      exitConfirmed: false,
    };
    try {
      const runner = new VerificationRunner(options);
      store.set("verification_runs", valid.id, { ...valid, ...defect });
      const before = store.entries("verification_runs");
      let error: unknown;
      try {
        new VerificationRunner(options);
      } catch (cause) {
        error = cause;
      }
      assert.deepEqual(store.entries("verification_runs"), before);
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "verify_record_invalid");
      assert.throws(() => runner.blockingDirectories(), { code: "verify_record_invalid" });
      assert.deepEqual(store.entries("verification_runs"), before);
    } finally {
      store.close();
    }
  });
}
