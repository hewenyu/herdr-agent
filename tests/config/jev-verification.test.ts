import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config/load.js";
import { validateConfig } from "../../src/config/validate.js";

test("Jev key does not enable private ingress and explicit operation settings survive loading", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "myrix-jev-config-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const load = () => loadConfig({ stateDir, home: stateDir, cwd: stateDir, env: {} });
  assert.equal(load().jev?.ingressEnabled, false);
  assert.equal(load().jev?.apiKey, "");
  await writeFile(
    join(stateDir, "config.toml"),
    `[jev]
api_key = "fixture-secret"
base_url = "https://api.typesafe.ai"
model = "jev-1.13.0"
timeout = "4s"
confidence_threshold = 0.9
stall_rounds = 5
[tasks.projects.repo]
directories = ["~/repo"]
verify = ["npm run check"]
verify_timeout = "30s"
`,
  );
  const config = load();
  const jev = config.jev;
  assert.ok(jev);
  assert.deepEqual(config.jev, {
    apiKey: "fixture-secret",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-1.13.0",
    timeoutMs: 4000,
    confidenceThreshold: 0.9,
    ingressEnabled: false,
    approvalsEnabled: true,
    stallRounds: 5,
  });
  assert.deepEqual(config.catalog.projects[0]?.verify, ["npm run check"]);
  assert.equal(config.catalog.projects[0]?.verifyTimeoutMs, 30_000);
  validateConfig(config);
  assert.throws(() => validateConfig({ ...config, jev: { ...jev, timeoutMs: 0 } }), {
    code: "jev_timeout",
  });
  assert.throws(() => validateConfig({ ...config, jev: { ...jev, confidenceThreshold: 1.1 } }), {
    code: "jev_confidence",
  });
  assert.throws(() => validateConfig({ ...config, jev: { ...jev, stallRounds: 0 } }), {
    code: "jev_stall",
  });
  assert.throws(
    () => validateConfig({ ...config, jev: { ...jev, ingressEnabled: true, apiKey: "" } }),
    { code: "jev_key" },
  );
  await writeFile(
    join(stateDir, "config.toml"),
    '[jev]\napi_key="fixture-secret"\napprovals_enabled=false\n',
  );
  assert.equal(load().jev?.approvalsEnabled, false);
  assert.equal(load().jev?.ingressEnabled, false);
});

test("TOML verification rejects malformed command lists and out-of-range timeout", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "myrix-verify-config-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const load = () => loadConfig({ stateDir, home: stateDir, cwd: stateDir, env: {} });
  for (const verify of ['"npm test"', '[" "]', "[42]"]) {
    await writeFile(
      join(stateDir, "config.toml"),
      `[tasks.projects.repo]\npath="~/repo"\nverify=${verify}\n`,
    );
    assert.throws(load, { code: "project_verify" });
  }
  await writeFile(
    join(stateDir, "config.toml"),
    '[tasks.projects.repo]\npath="~/repo"\nverify=[]\nverify_timeout="11m"\n',
  );
  assert.throws(load, { code: "project_verify_timeout" });
});
