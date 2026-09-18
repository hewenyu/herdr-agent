import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { ProjectCatalog } from "../../src/projects/catalog.js";
import { Store } from "../../src/storage/store.js";

const execute = promisify(execFile);

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-projects-"));
  const store = new Store(":memory:");
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const catalog = new ProjectCatalog(
    store,
    { projects: [], defaultProject: "", bypass: false },
    dir,
  );
  return { dir, store, catalog };
}

test("project registration verifies every directory, initializes primary Git and only removes catalog entries", async (t) => {
  const { dir, catalog } = await fixture(t);
  const primary = join(dir, "primary");
  const extra = join(dir, "extra");
  await mkdir(primary);
  await mkdir(extra);
  await assert.rejects(
    catalog.save({ name: "invalid", agent: "codex", directories: [primary, join(dir, "missing")] }),
    { code: "directory_missing" },
  );
  await assert.rejects(stat(join(primary, ".git")), { code: "ENOENT" });
  const saved = await catalog.save({
    name: "有效项目",
    agent: "claude",
    directories: [primary, extra, primary],
  });
  assert.deepEqual(saved.directories, [primary, extra]);
  assert.equal(catalog.get().name, "有效项目");
  assert.equal((await stat(join(primary, ".git"))).isDirectory(), true);
  await writeFile(join(primary, "retain.txt"), "user work");
  catalog.remove("有效项目");
  assert.equal(catalog.snapshot().defaultProject, "");
  assert.equal(await readFile(join(primary, "retain.txt"), "utf8"), "user work");
  assert.equal(catalog.snapshot().bypass, false);
});

test("new projects use configured home root and reject existing directories and path traversal", async (t) => {
  const { dir, catalog } = await fixture(t);
  const created = await catalog.create("新项目", "codex");
  assert.deepEqual(created.directories, [join(dir, "herder-agent-code", "新项目")]);
  await assert.rejects(catalog.create("新项目"), { code: "project_exists" });
  await assert.rejects(catalog.create("../escape"), { code: "project_name" });
  await mkdir(join(dir, "herder-agent-code", "occupied"));
  await assert.rejects(catalog.create("occupied"), { code: "project_directory_exists" });
  assert.throws(() => catalog.settings({ defaultProject: "missing" }), { code: "project_missing" });
  assert.equal(catalog.snapshot().defaultProject, "新项目");
});

test("worktree has a task branch and isolated primary directory while retaining extra directories", async (t) => {
  const { dir, catalog } = await fixture(t);
  const project = await catalog.create("repo");
  const primary = project.directories[0] as string;
  await execute("git", [
    "-C",
    primary,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const extra = join(dir, "extra");
  await mkdir(extra);
  const state = join(dir, "state");
  const directories = await catalog.worktree("task-one", [primary, extra], state);
  assert.deepEqual(directories, [join(state, "worktrees", "task-one"), extra]);
  const branch = await execute("git", ["-C", directories[0] as string, "branch", "--show-current"]);
  assert.equal(branch.stdout.trim(), "herdr/task-one");
  await assert.rejects(catalog.worktree("task-one", [primary], state), { code: "worktree_exists" });
  await assert.rejects(catalog.worktree("../../escape", [primary], state), {
    code: "worktree_path",
  });
  const empty = await catalog.create("empty");
  await assert.rejects(catalog.worktree("no-head", empty.directories, state), {
    code: "worktree_create",
    outcome: "not_executed",
  });
});
