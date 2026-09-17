import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { duration, loadConfig, readEnv } from "../../src/config/load.js";
import { saveConfigSection } from "../../src/config/save.js";
import { listenAddress, safeEndpoint, validateConfig } from "../../src/config/validate.js";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const load = () => loadConfig({ stateDir: dir, home: dir, cwd: dir, env: {} });
  return { dir, load };
}

test("literal dotenv compatibility and process > state > repository precedence", async (t) => {
  const { dir } = await fixture(t);
  await mkdir(join(dir, "repo", "nested"), { recursive: true });
  await mkdir(join(dir, "repo", ".git"));
  const state = join(dir, "state");
  await mkdir(state);
  await writeFile(join(dir, "repo", ".env"), "FEISHU_APP_ID=repo\nFEISHU_APP_SECRET=repo-secret\n");
  await writeFile(
    join(state, ".env"),
    '\uFEFFFEISHU_APP_ID=state\r\nQUOTED="literal # ="\r\nexport BAD=ignored\r\nHASH=value # literal\n',
  );
  assert.deepEqual(readEnv(join(state, ".env")), {
    FEISHU_APP_ID: "state",
    QUOTED: '"literal # ="',
    HASH: "value # literal",
  });
  const base = { stateDir: state, home: dir, cwd: join(dir, "repo", "nested") };
  assert.equal(loadConfig({ ...base, env: {} }).feishu.appId, "state");
  assert.equal(loadConfig({ ...base, env: {} }).feishu.appSecret, "repo-secret");
  assert.equal(loadConfig({ ...base, env: { FEISHU_APP_ID: "process" } }).feishu.appId, "process");
  assert.equal(loadConfig({ ...base, env: { FEISHU_APP_ID: "" } }).feishu.appId, "");
});

test("catalog JSON replaces TOML projects but inherits omitted bypass; paths and zero defaults survive", async (t) => {
  const { dir, load } = await fixture(t);
  await writeFile(
    join(dir, "config.toml"),
    '\uFEFF[herdr]\nsocket_path="~/socket"\ncall_timeout="0"\n[ui]\nmax_cols=0\ntail_lines=0\nnotify_cooldown="0s"\n[tasks]\nbypass=false\n[tasks.projects.old]\npath="~/old"\n',
  );
  await writeFile(
    join(dir, "projects.json"),
    JSON.stringify({
      version: 1,
      default_project: "new",
      projects: { new: { path: "~/new", agent: "claude" } },
    }),
  );
  const config = load();
  assert.deepEqual(config.catalog, {
    projects: [{ name: "new", directories: [join(dir, "new")], agent: "claude" }],
    defaultProject: "new",
    bypass: false,
  });
  assert.equal(config.herdr.socket, join(dir, "socket"));
  assert.equal(config.herdr.timeoutMs, 10_000);
  assert.equal(config.ui.maxCols, 56);
  assert.equal(config.ui.tailLines, 18);
  assert.equal(config.ui.notifyCooldownMs, 30_000);
});

test("corrupt catalogs, invalid booleans and unsafe durations fail instead of dropping state", async (t) => {
  for (const projects of [[], null, { bad: { path: "" } }, { bad: { directories: ["/ok", 1] } }]) {
    const { dir, load } = await fixture(t);
    await writeFile(join(dir, "projects.json"), JSON.stringify({ version: 1, projects }));
    assert.throws(load, { code: "projects_corrupt" });
  }
  const { dir, load } = await fixture(t);
  await writeFile(join(dir, "config.toml"), '[tasks]\nbypass="false"\n');
  assert.throws(load, { code: "config_type" });
  assert.equal(duration("1h2m3s250ms", 0), 3_723_250);
  for (const value of ["-1s", "1s junk", `${"9".repeat(400)}h`, 5])
    assert.throws(() => duration(value, 1), { code: "config_duration" });
});

test("per-user memory is a complete override and section saves preserve unrelated fields", async (t) => {
  const { dir, load } = await fixture(t);
  await writeFile(
    join(dir, "config.toml"),
    '[tasks]\nbypass=false\n[memory]\nprovider="http"\nbase_url="https://example.test/memory"\napi_key="test-key"\n[memory.users.owner]\nprovider="file"\n',
  );
  assert.equal(load().memory.users.owner?.apiKey, "");
  assert.equal(load().memory.users.owner?.baseUrl, "");
  await saveConfigSection(dir, "tasks", { enabled: true });
  assert.equal(load().tasks.enabled, true);
  assert.equal(load().catalog.bypass, false);
  assert.equal(load().memory.apiKey, "test-key");
  assert.equal((await stat(join(dir, "config.toml"))).mode & 0o777, 0o600);
  assert.ok((await readFile(join(dir, "config.toml"), "utf8")).includes("test-key"));
});

test("loopback binding, service endpoints and credential identities are validated", async (t) => {
  const { load } = await fixture(t);
  assert.deepEqual(listenAddress("[::1]:0"), { host: "::1", port: 0 });
  for (const address of ["0.0.0.0:9", "localhost:9", "127.0.0.1:65536"])
    assert.throws(() => listenAddress(address));
  for (const endpoint of [
    "http://remote.test",
    "https://user:secret@example.test",
    "https://example.test?",
    "https://example.test#",
  ])
    assert.throws(() => safeEndpoint(endpoint));
  assert.equal(safeEndpoint("http://[::1]:9000/memory").hostname, "[::1]");
  const config = load();
  validateConfig(config);
  config.feishu = {
    ...config.feishu,
    appId: "cli_fixture",
    appSecret: "secret",
    allowedOpenIds: [" "],
  };
  assert.throws(() => validateConfig(config, { requireFeishu: true }), { code: "allowlist" });
  config.feishu.allowedOpenIds = ["owner"];
  config.feishu.appSecret = "";
  assert.throws(() => validateConfig(config, { requireFeishu: true }), { code: "feishu_secret" });
  config.feishu.appSecret = "secret";
  config.memory = {
    provider: "http",
    baseUrl: "https://localhost/memory",
    apiKey: "",
    timeoutMs: 1000,
    users: {},
  };
  validateConfig(config, { requireFeishu: true });
});
