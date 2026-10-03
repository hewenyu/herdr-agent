import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig, readToml } from "../../src/config/load.js";
import { saveConfigSection, saveConfigSections } from "../../src/config/save.js";

async function fixture(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-config-save-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const load = (dir: string) => loadConfig({ stateDir: dir, home: dir, cwd: dir, env: {} });

const temporaryLeftovers = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((name) => name.endsWith(".tmp"));

test("concurrent saves of different sections to one file keep every section", async (t) => {
  const dir = await fixture(t);
  await Promise.all([
    saveConfigSection(dir, "ai", { enabled: true, model: "audit" }),
    saveConfigSection(dir, "tasks", { enabled: true }),
    saveConfigSection(dir, "runtime", { max_concurrent_tasks: 7 }),
  ]);
  const config = load(dir);
  assert.equal(config.ai.enabled, true);
  assert.equal(config.ai.model, "audit");
  assert.equal(config.tasks.enabled, true);
  assert.equal(config.runtime.maxConcurrentTasks, 7);
  assert.deepEqual(await temporaryLeftovers(dir), []);
});

test("concurrent saves of the same section merge keys instead of losing the earlier save", async (t) => {
  const dir = await fixture(t);
  await Promise.all([
    saveConfigSection(dir, "tasks", { enabled: true }),
    saveConfigSection(dir, "tasks", { poll_interval: "5s" }),
    saveConfigSection(dir, "tasks", { bypass: false }),
  ]);
  const config = load(dir);
  assert.equal(config.tasks.enabled, true);
  assert.equal(config.tasks.pollIntervalMs, 5000);
  assert.equal(config.catalog.bypass, false);
});

test("normalized paths share the same lock and later saves win only on conflicting keys", async (t) => {
  const dir = await fixture(t);
  await Promise.all([
    saveConfigSection(dir, "ai", { model: "first", enabled: true }),
    saveConfigSection(`${dir}/.`, "ai", { model: "second" }),
  ]);
  const config = load(dir);
  assert.equal(config.ai.model, "second");
  assert.equal(config.ai.enabled, true);
});

test("a batch save merges several sections into one file and preserves unknown fields", async (t) => {
  const dir = await fixture(t);
  const path = join(dir, "config.toml");
  await writeFile(
    path,
    'title = "kept"\n[ai]\nprovider = "anthropic-messages"\ncontext_tokens = 1234\n[ui]\nmax_cols = 99\n[feishu]\nnotify_chat_id = "chat-1"\n',
  );
  await saveConfigSections(dir, {
    ai: { enabled: true, provider: "openai-responses", model: "audit" },
    tasks: { enabled: true },
  });
  const raw = readToml(path);
  assert.equal(raw.title, "kept");
  assert.equal((raw.ui as Record<string, unknown>).max_cols, 99);
  assert.equal((raw.feishu as Record<string, unknown>).notify_chat_id, "chat-1");
  assert.equal((raw.ai as Record<string, unknown>).context_tokens, 1234, "unknown ai keys survive");
  assert.equal((raw.ai as Record<string, unknown>).model, "audit");
  assert.equal((raw.ai as Record<string, unknown>).enabled, true);
  assert.equal((raw.tasks as Record<string, unknown>).enabled, true);
  const config = load(dir);
  assert.equal(config.ui.maxCols, 99);
  assert.equal(config.feishu.notifyChatId, "chat-1");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await temporaryLeftovers(dir), []);
});

test("a rejected save leaves the file untouched and a corrected retry succeeds", async (t) => {
  const dir = await fixture(t);
  const path = join(dir, "config.toml");
  const broken = '[ai]\nmodel = "unterminated\n';
  await writeFile(path, broken);
  await assert.rejects(
    saveConfigSections(dir, { ai: { enabled: true }, tasks: { enabled: true } }),
    {
      code: "config_parse",
    },
  );
  assert.equal(await readFile(path, "utf8"), broken, "a failed save must not rewrite the file");
  await writeFile(path, '[ai]\nmodel = "previous"\n');
  await saveConfigSections(dir, { ai: { model: "audit" }, tasks: { enabled: true } });
  const config = load(dir);
  assert.equal(config.ai.model, "audit");
  assert.equal(config.tasks.enabled, true);
  assert.deepEqual(await temporaryLeftovers(dir), []);
});

test("a rejected save on one config path does not block an unrelated path", async (t) => {
  const brokenDir = await fixture(t);
  const otherDir = await fixture(t);
  await writeFile(join(brokenDir, "config.toml"), "= not toml\n");
  const failing = saveConfigSections(brokenDir, { ai: { enabled: true } });
  const unrelated = saveConfigSections(otherDir, { tasks: { enabled: true } });
  await assert.rejects(failing, { code: "config_parse" });
  await unrelated;
  assert.equal(load(otherDir).tasks.enabled, true);
  await writeFile(join(brokenDir, "config.toml"), "");
  await saveConfigSections(brokenDir, { ai: { model: "audit" } });
  assert.equal(load(brokenDir).ai.model, "audit");
});
