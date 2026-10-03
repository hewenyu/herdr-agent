import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { dispatch } from "../../src/app/actions.js";
import type { ApplicationContext } from "../../src/app/context.js";
import { loadConfig } from "../../src/config/load.js";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-model-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = loadConfig({ stateDir: dir, home: dir, cwd: dir, env: {} });
  let changes = 0;
  const context = {
    config,
    changed: () => {
      changes += 1;
    },
  } as unknown as ApplicationContext;
  return { dir, context, changes: () => changes };
}

const input = {
  enabled: true,
  provider: "anthropic-messages",
  model: "audit",
  baseUrl: "https://model.example.invalid/v1",
  apiKey: "test-only-key",
};

test("config.ai saves ai and tasks together while preserving unrelated config", async (t) => {
  const { dir, context, changes } = await fixture(t);
  await writeFile(join(dir, "config.toml"), "[ui]\nmax_cols = 99\n[ai]\ncontext_tokens = 1234\n");
  await dispatch(context, "config.ai", input);
  const reloaded = loadConfig({ stateDir: dir, home: dir, cwd: dir, env: {} });
  assert.equal(reloaded.ai.enabled, true);
  assert.equal(reloaded.ai.provider, "anthropic-messages");
  assert.equal(reloaded.ai.model, "audit");
  assert.equal(reloaded.ai.apiKey, "test-only-key");
  assert.equal(reloaded.tasks.enabled, true, "enabling ai also enables tasks");
  assert.equal(reloaded.ui.maxCols, 99, "unrelated section survives");
  assert.equal(reloaded.ai.contextTokens, 1234, "unknown ai keys survive");
  assert.equal((await stat(join(dir, "config.toml"))).mode & 0o777, 0o600);
  assert.equal(changes(), 1);
});

test("config.ai refuses to overwrite a file it cannot parse and still saves after repair", async (t) => {
  const { dir, context } = await fixture(t);
  const path = join(dir, "config.toml");
  const broken = '[ai]\nmodel = "unterminated\n';
  await writeFile(path, broken);
  await assert.rejects(dispatch(context, "config.ai", input), { code: "config_parse" });
  assert.equal(await readFile(path, "utf8"), broken);
  await writeFile(path, "");
  await dispatch(context, "config.ai", input);
  const reloaded = loadConfig({ stateDir: dir, home: dir, cwd: dir, env: {} });
  assert.equal(reloaded.ai.model, "audit");
  assert.equal(reloaded.tasks.enabled, true);
});
