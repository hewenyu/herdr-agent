import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dependencies } from "../../src/cli/dependencies.js";
import { loadConfig } from "../../src/config/load.js";
import { Store } from "../../src/storage/store.js";
import { message } from "../app/helpers.js";
import { FakeHerdr, FakePlatform } from "../tasks/helpers.js";

test("the CLI application's existing business logger writes to the service file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "myrix-cli-logging-"));
  const console: string[] = [];
  const deps = dependencies({ stderr: (line) => console.push(line) });
  const config = loadConfig({ stateDir: directory, cwd: directory, env: {} });
  config.feishu.allowedOpenIds = ["owner"];
  const log = deps.startLogging(directory);
  const store = new Store(":memory:");
  const app = deps.createApp(config, store, new FakeHerdr());
  app.attachPlatform(new FakePlatform());
  try {
    await app.handlers().message(message("diagnostic", "/help"));
    await app.shutdown();
    log.close();
    const entries = readFileSync(join(directory, "log", "myrix.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(entries.some((entry) => entry.event === "inbox.accepted"));
    assert.ok(entries.every((entry) => !entry.body && !entry.content && !entry.text));
    assert.deepEqual(console, []);
  } finally {
    await app.shutdown();
    log.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
