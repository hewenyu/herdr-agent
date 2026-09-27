import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config/load.js";
import { setup } from "./helpers.js";

test("local project settings save verification while invalid values leave configuration untouched", async () => {
  const h = setup(false, false);
  try {
    const cwd = join(h.directory, "verify-fixture");
    await mkdir(cwd);
    const project = await h.app.projects.save({
      name: "verify-fixture",
      agent: "codex",
      directories: [cwd],
    });
    const config = loadConfig({
      stateDir: h.directory,
      home: h.directory,
      cwd: h.directory,
      env: {},
    });
    h.config.jev = {
      ...(config.jev as NonNullable<typeof config.jev>),
      apiKey: "fixture-jev-secret",
    };
    await h.app.dispatch("project.save", {
      ...project,
      verify: ["npm run check"],
      verifyTimeoutMs: 3000,
    });
    assert.deepEqual(h.app.projects.get(project.name).verify, ["npm run check"]);
    assert.equal(h.app.projects.get(project.name).verifyTimeoutMs, 3000);
    for (const verify of ["npm test", [""], [42]])
      await assert.rejects(h.app.dispatch("project.save", { ...project, verify }), {
        code: "project_verify",
      });
    assert.deepEqual(h.app.projects.get(project.name).verify, ["npm run check"]);
    await h.app.dispatch("project.save", { ...project, verify: [] });
    assert.deepEqual(h.app.projects.get(project.name).verify, []);
    assert.ok(!JSON.stringify(h.app.history("owner")).includes("fixture-jev-secret"));
    await h.app.projects.save({ ...project, verify: ["echo fixture-jev-secret"] });
    const history = JSON.stringify(h.app.history("owner"));
    assert.ok(!history.includes("fixture-jev-secret"));
    assert.ok(history.includes("[redacted]"));
  } finally {
    await h.close();
  }
});
