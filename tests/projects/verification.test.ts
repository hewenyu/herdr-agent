import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectCatalog } from "../../src/projects/catalog.js";
import { Store } from "../../src/storage/store.js";

test("SQLite project verification settings survive restart, model edits and TOML reseeding", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "myrix-project-verification-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const initial = { projects: [], defaultProject: "", bypass: false };
  let store = new Store(join(dir, "state.db"));
  t.after(() => store.close());
  let catalog = new ProjectCatalog(store, initial, dir);
  const project = await catalog.create("fixture");
  await catalog.save({ ...project, verify: ["npm run check"], verifyTimeoutMs: 4000 });
  await catalog.save({ name: project.name, agent: "claude", directories: project.directories });
  assert.deepEqual(catalog.get().verify, ["npm run check"]);
  store.close();
  store = new Store(join(dir, "state.db"));
  catalog = new ProjectCatalog(store, initial, dir);
  assert.equal(catalog.get().verifyTimeoutMs, 4000);
  assert.equal(catalog.get().agent, "claude");
  const other = join(dir, "other");
  await mkdir(other);
  await assert.rejects(catalog.save({ ...catalog.get(), directories: [other] }), {
    code: "project_verify_scope",
  });
  await assert.rejects(stat(join(other, ".git")), { code: "ENOENT" });
  await catalog.save({ ...catalog.get(), directories: [other] }, false, {
    localConfiguration: true,
  });
  assert.deepEqual(catalog.get().directories, [other]);
  assert.deepEqual(catalog.get().verify, ["npm run check"]);
  await catalog.save({ ...catalog.get(), verify: [] });
  assert.deepEqual(catalog.get().verify, []);
  await assert.rejects(catalog.save({ ...catalog.get(), verify: [""] }), {
    code: "project_verify",
  });
  assert.deepEqual(catalog.get().verify, []);
});
